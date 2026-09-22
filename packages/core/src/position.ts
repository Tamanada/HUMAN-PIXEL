/**
 * On-device positioning. The phone decides whether it is in position; the server is only told
 * about meaningful state changes (see participantState.ts). Never assume centimetre GPS.
 */
import { haversineDistance, initialBearing, type LatLng } from './geo';

export interface GpsFix extends LatLng {
  /** Horizontal accuracy radius (68% confidence) in meters, as reported by the OS. */
  accuracy: number;
  /** Epoch ms (device clock) of the fix. */
  timestamp: number;
  /** Course over ground in degrees, when moving. */
  heading?: number | null;
  speed?: number | null;
}

export interface PositionTarget extends LatLng {
  /** Tolerance radius configured by the organizer, meters. */
  radius: number;
  /** Fix accuracy required before we may claim "in position", meters. */
  requiredAccuracy: number;
}

export type GpsQuality = 'none' | 'poor' | 'fair' | 'good';

/** User-facing status. Maps to 🟢 POSITION OK, 🟠 MOVE CLOSER, 🔴 GPS ACCURACY TOO LOW. */
export type PositionStatus = 'NO_FIX' | 'GPS_LOW' | 'MOVE_CLOSER' | 'IN_POSITION';

export interface PositionEvaluation {
  distance: number;
  bearing: number;
  accuracy: number;
  quality: GpsQuality;
  status: PositionStatus;
  /** Whether this single sample is inside the tolerance radius with acceptable accuracy. */
  inside: boolean;
}

export function gpsQuality(accuracy: number | null | undefined, required: number): GpsQuality {
  if (accuracy == null || !Number.isFinite(accuracy)) return 'none';
  if (accuracy <= Math.min(required, 5)) return 'good';
  if (accuracy <= required) return 'fair';
  return 'poor';
}

export function evaluatePosition(fix: GpsFix | null, target: PositionTarget): PositionEvaluation {
  if (!fix) {
    return { distance: NaN, bearing: NaN, accuracy: NaN, quality: 'none', status: 'NO_FIX', inside: false };
  }
  const distance = haversineDistance(fix, target);
  const bearing = initialBearing(fix, target);
  const quality = gpsQuality(fix.accuracy, target.requiredAccuracy);
  const accurateEnough = fix.accuracy <= target.requiredAccuracy;
  const inside = accurateEnough && distance <= target.radius;
  let status: PositionStatus;
  if (inside) status = 'IN_POSITION';
  else if (!accurateEnough && distance <= target.radius + fix.accuracy) status = 'GPS_LOW';
  else if (!accurateEnough && quality === 'poor' && fix.accuracy > target.requiredAccuracy * 3) status = 'GPS_LOW';
  else status = 'MOVE_CLOSER';
  return { distance, bearing, accuracy: fix.accuracy, quality, status, inside };
}

/**
 * Accuracy-weighted smoothing over a short window. When a person stands still, raw fixes wander
 * by several meters; the inverse-variance mean is much more stable. When they walk, the short
 * window keeps latency low.
 */
export class FixSmoother {
  private fixes: GpsFix[] = [];

  constructor(private readonly windowMs = 4_000, private readonly maxFixes = 8) {}

  push(fix: GpsFix): GpsFix {
    this.fixes.push(fix);
    const cutoff = fix.timestamp - this.windowMs;
    this.fixes = this.fixes.filter((f) => f.timestamp >= cutoff).slice(-this.maxFixes);
    // Moving fast: do not smooth, the window would lag behind.
    if ((fix.speed ?? 0) > 1.2 || this.fixes.length === 1) return fix;
    let wSum = 0;
    let lat = 0;
    let lng = 0;
    for (const f of this.fixes) {
      const w = 1 / Math.max(1, f.accuracy) ** 2;
      wSum += w;
      lat += f.lat * w;
      lng += f.lng * w;
    }
    // Combined accuracy of n roughly independent fixes; floor at 60% of the best raw fix because
    // consecutive GPS errors are strongly correlated (never overclaim).
    const best = Math.min(...this.fixes.map((f) => f.accuracy));
    const combined = Math.max(best * 0.6, 1 / Math.sqrt(wSum));
    return { ...fix, lat: lat / wSum, lng: lng / wSum, accuracy: combined };
  }

  reset(): void {
    this.fixes = [];
  }
}

export interface TrackerOptions {
  /** Consecutive time inside before we declare IN_POSITION. */
  enterDwellMs: number;
  /** Consecutive time outside (beyond radius × exitMargin) before we declare LEFT_POSITION. */
  exitDwellMs: number;
  exitMargin: number;
  /** Distance under which a participant counts as "arrived" near their pixel. */
  arrivedDistanceM: number;
  /** No fix for this long ⇒ GPS lost. */
  staleFixMs: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  enterDwellMs: 3_000,
  exitDwellMs: 8_000,
  exitMargin: 1.25,
  arrivedDistanceM: 25,
  staleFixMs: 15_000,
};

export interface TrackerSnapshot {
  evaluation: PositionEvaluation;
  /** Debounced: true once inside for enterDwellMs, false once outside for exitDwellMs. */
  inPosition: boolean;
  arrived: boolean;
  /** Timestamp (device ms) since which inPosition has been continuously true. */
  inPositionSince: number | null;
  gpsLost: boolean;
}

/**
 * Hysteresis state machine over smoothed fixes. Deterministic and pure given its inputs,
 * so it is exercised directly by the simulator with synthetic GPS noise.
 */
export class PositionTracker {
  private readonly opts: TrackerOptions;
  private readonly smoother = new FixSmoother();
  private inPosition = false;
  private inPositionSince: number | null = null;
  private candidateSince: number | null = null;
  private exitSince: number | null = null;
  private arrived = false;
  private lastFixAt: number | null = null;
  private last: PositionEvaluation = evaluatePosition(null, { lat: 0, lng: 0, radius: 1, requiredAccuracy: 1 });

  constructor(private target: PositionTarget, opts: Partial<TrackerOptions> = {}) {
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...opts };
  }

  setTarget(target: PositionTarget): void {
    this.target = target;
    this.smoother.reset();
    this.inPosition = false;
    this.inPositionSince = null;
    this.candidateSince = null;
    this.exitSince = null;
    this.arrived = false;
  }

  update(raw: GpsFix): TrackerSnapshot {
    const fix = this.smoother.push(raw);
    this.lastFixAt = raw.timestamp;
    const ev = evaluatePosition(fix, this.target);
    this.last = ev;
    const t = raw.timestamp;

    if (ev.distance <= this.opts.arrivedDistanceM) this.arrived = true;

    if (!this.inPosition) {
      if (ev.inside) {
        this.candidateSince ??= t;
        if (t - this.candidateSince >= this.opts.enterDwellMs) {
          this.inPosition = true;
          this.inPositionSince = t;
          this.exitSince = null;
        }
      } else {
        this.candidateSince = null;
      }
    } else {
      // Only a confident exit counts: poor accuracy alone never ejects someone standing still.
      const clearlyOutside =
        ev.distance > this.target.radius * this.opts.exitMargin &&
        ev.distance - ev.accuracy > this.target.radius;
      if (clearlyOutside) {
        this.exitSince ??= t;
        if (t - this.exitSince >= this.opts.exitDwellMs) {
          this.inPosition = false;
          this.inPositionSince = null;
          this.candidateSince = null;
        }
      } else {
        this.exitSince = null;
      }
    }
    return this.snapshot(t);
  }

  snapshot(now: number): TrackerSnapshot {
    const gpsLost = this.lastFixAt == null || now - this.lastFixAt > this.opts.staleFixMs;
    return {
      evaluation: gpsLost ? { ...this.last, status: 'NO_FIX', quality: 'none' } : this.last,
      inPosition: this.inPosition,
      arrived: this.arrived,
      inPositionSince: this.inPositionSince,
      gpsLost,
    };
  }
}

/** Human-friendly distance ("84 m", "4.8 m", "1.2 km"). */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`;
  if (m >= 10) return `${Math.round(m)} m`;
  return `${m.toFixed(1)} m`;
}
