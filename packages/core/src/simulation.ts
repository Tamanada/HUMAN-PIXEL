/**
 * Participant behaviour simulation, so 50,000-person events can be rehearsed without phones.
 * Runs the REAL on-device code (PositionTracker, deriveParticipantState, StatusOutbox) against a
 * synthetic GPS model with correlated error, and counts the network traffic it produces.
 */
import { LocalFrame, type LatLng } from './geo';
import { PositionTracker, type PositionTarget } from './position';
import { deriveParticipantState, MemoryOutboxStorage, StatusOutbox, type ParticipantState, type StatusReport } from './participantState';
import { mulberry32 } from './formation/random';

export interface GpsModel {
  /** Standard deviation of the slowly varying bias (multipath, satellite geometry), meters. */
  biasSigma: number;
  /** AR(1) correlation of the bias per second (0..1). */
  biasCorrelation: number;
  /** White noise per fix, meters. */
  noiseSigma: number;
  /** Reported accuracy as a multiple of the true error scale. */
  reportedAccuracy: number;
  /** Probability per second that a fix is dropped. */
  dropRate: number;
}

export const GPS_OPEN_SKY: GpsModel = { biasSigma: 1.8, biasCorrelation: 0.97, noiseSigma: 0.8, reportedAccuracy: 4, dropRate: 0.02 };
export const GPS_URBAN: GpsModel = { biasSigma: 5, biasCorrelation: 0.95, noiseSigma: 2, reportedAccuracy: 12, dropRate: 0.08 };

export interface SimParticipant {
  id: number;
  target: LatLng;
  start: LatLng;
  /** Walking speed m/s. */
  speed: number;
  /** Seconds after sim start when they begin walking (late arrivals). */
  departAt: number;
  /** Probability-driven no-show. */
  noShow: boolean;
}

export interface SimResult {
  participants: number;
  reportsSent: number;
  reportsPerParticipant: number;
  peakReportsPerSecond: number;
  reportsDuringQuietWindow: number;
  inPositionAtStart: number;
  falseInPosition: number;
  finalStates: Record<ParticipantState, number>;
  medianTimeToPositionS: number;
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface CrowdSimOptions {
  participants: SimParticipant[];
  anchor: LatLng;
  radius: number;
  requiredAccuracy: number;
  gps: GpsModel;
  /** Simulation length and formation start, seconds. */
  durationS: number;
  startAtS: number;
  seed?: number;
  /** Sim step (s). GPS fixes arrive at 1 Hz. */
  stepS?: number;
}

/**
 * Discrete-time crowd simulation. Memory O(participants); time O(participants × duration).
 * 50,000 participants × 1,800 s runs in well under a minute on a laptop.
 */
export function simulateCrowd(o: CrowdSimOptions): SimResult {
  const rand = mulberry32(o.seed ?? 42);
  const frame = new LocalFrame(o.anchor);
  const startMs = o.startAtS * 1000;
  const perSecond = new Int32Array(Math.ceil(o.durationS) + 1);
  let reportsSent = 0;
  let quietReports = 0;
  let inPositionAtStart = 0;
  let falseInPosition = 0;
  const finalStates = Object.fromEntries(
    ['JOINED', 'CHECKED_IN', 'ARRIVED', 'IN_POSITION', 'READY', 'LEFT_POSITION', 'COMPLETED'].map((s) => [s, 0]),
  ) as Record<ParticipantState, number>;
  const timeToPosition: number[] = [];

  for (const p of o.participants) {
    const target: PositionTarget = { ...p.target, radius: o.radius, requiredAccuracy: o.requiredAccuracy };
    const tracker = new PositionTracker(target);
    const outbox = new StatusOutbox(new MemoryOutboxStorage(), { random: rand });
    const tgt = frame.toLocal(p.target);
    let pos = frame.toLocal(p.start);
    let bx = gauss(rand) * o.gps.biasSigma;
    let by = gauss(rand) * o.gps.biasSigma;
    let state: ParticipantState = 'JOINED';
    let reachedAt: number | null = null;
    const k = o.gps.biasCorrelation;
    const innov = Math.sqrt(1 - k * k) * o.gps.biasSigma;

    for (let t = 0; t <= o.durationS; t += o.stepS ?? 1) {
      const nowMs = t * 1000;
      // Movement: walk straight towards the target, stop inside 0.4 m, then stand (sway).
      if (!p.noShow && t >= p.departAt) {
        const dx = tgt.x - pos.x;
        const dy = tgt.y - pos.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.4) {
          const step = Math.min(d, p.speed);
          pos = { x: pos.x + (dx / d) * step, y: pos.y + (dy / d) * step };
        } else {
          reachedAt ??= t;
          pos = { x: tgt.x + gauss(rand) * 0.1, y: tgt.y + gauss(rand) * 0.1 };
        }
      }
      bx = k * bx + innov * gauss(rand);
      by = k * by + innov * gauss(rand);
      if (!p.noShow && rand() >= o.gps.dropRate) {
        const measured = frame.toLatLng({ x: pos.x + bx + gauss(rand) * o.gps.noiseSigma, y: pos.y + by + gauss(rand) * o.gps.noiseSigma });
        const trueErr = Math.hypot(bx, by);
        tracker.update({
          ...measured,
          accuracy: Math.max(2, o.gps.reportedAccuracy * (0.7 + 0.6 * rand()) + trueErr * 0.3),
          timestamp: nowMs,
          speed: reachedAt == null ? p.speed : 0,
        });
      }
      const snap = tracker.snapshot(nowMs);
      const next = deriveParticipantState(state, {
        insidePerimeter: !p.noShow && t >= p.departAt,
        tracker: snap,
        now: nowMs,
        startsAt: startMs,
        readyTapped: false,
      });
      if (next !== state) {
        state = next;
        outbox.enqueue({ eventId: 'sim', state, at: nowMs, accuracyM: snap.evaluation.accuracy, clockUncertaintyMs: 30 });
      }
      if (outbox.hasPending) {
        const due = outbox.nextSendTime(nowMs, startMs);
        if (due != null && due <= nowMs) {
          outbox.markSent(outbox.current as StatusReport, nowMs);
          reportsSent++;
          perSecond[t]!++;
          if (nowMs >= startMs - 30_000 && nowMs < startMs + 150_000) quietReports++;
        }
      }
      if (t === o.startAtS) {
        if (snap.inPosition) {
          inPositionAtStart++;
          const truth = Math.hypot(pos.x - tgt.x, pos.y - tgt.y);
          if (truth > o.radius) falseInPosition++;
        }
      }
    }
    finalStates[state]++;
    if (reachedAt != null) timeToPosition.push(reachedAt - p.departAt);
  }
  timeToPosition.sort((a, b) => a - b);
  return {
    participants: o.participants.length,
    reportsSent,
    reportsPerParticipant: reportsSent / Math.max(1, o.participants.length),
    peakReportsPerSecond: Math.max(...perSecond),
    reportsDuringQuietWindow: quietReports,
    inPositionAtStart,
    falseInPosition,
    finalStates,
    medianTimeToPositionS: timeToPosition[timeToPosition.length >> 1] ?? NaN,
  };
}

/** Builds participants scattered around assembly points who walk to their targets. */
export function makeSimParticipants(
  targets: LatLng[],
  anchor: LatLng,
  opts: { seed?: number; noShowRate?: number; lateRate?: number; spawnRadiusM?: number; arrivalWindowS?: number } = {},
): SimParticipant[] {
  const rand = mulberry32(opts.seed ?? 7);
  const frame = new LocalFrame(anchor);
  return targets.map((target, id) => {
    const t = frame.toLocal(target);
    const ang = rand() * Math.PI * 2;
    const r = (opts.spawnRadiusM ?? 150) * (0.3 + rand() * 0.7);
    const late = rand() < (opts.lateRate ?? 0.05);
    return {
      id,
      target,
      start: frame.toLatLng({ x: t.x + Math.cos(ang) * r, y: t.y + Math.sin(ang) * r }),
      speed: 0.9 + rand() * 0.6,
      departAt: late ? (opts.arrivalWindowS ?? 900) + rand() * 900 : rand() * (opts.arrivalWindowS ?? 900),
      noShow: rand() < (opts.noShowRate ?? 0.03),
    };
  });
}
