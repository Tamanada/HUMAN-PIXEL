/**
 * Participant-side lifecycle and the outbox that reports it.
 * Only transitions are ever sent. Never coordinates.
 */
import type { TrackerSnapshot } from './position';

export const PARTICIPANT_STATES = [
  'JOINED',
  'CHECKED_IN',
  'ARRIVED',
  'IN_POSITION',
  'READY',
  'LEFT_POSITION',
  'COMPLETED',
] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export interface ParticipantContext {
  insidePerimeter: boolean | null;
  tracker: TrackerSnapshot | null;
  /** Authoritative server-synced now. */
  now: number;
  startsAt: number | null;
  /** The user tapped "I'M READY". */
  readyTapped: boolean;
  /** How long a held position auto-promotes to READY. */
  autoReadyAfterMs?: number;
  /** After start + this, a participant still present is COMPLETED. */
  completeAfterMs?: number;
}

/**
 * Pure derivation of the participant state from local sensors. Called every GPS tick; the
 * outbox only transmits when the derived state changes.
 */
export function deriveParticipantState(prev: ParticipantState, ctx: ParticipantContext): ParticipantState {
  const completeAfter = ctx.completeAfterMs ?? 2 * 60_000;
  if (prev === 'COMPLETED') return 'COMPLETED';
  if (ctx.startsAt != null && ctx.now >= ctx.startsAt + completeAfter && (prev === 'READY' || prev === 'IN_POSITION')) {
    return 'COMPLETED';
  }
  const t = ctx.tracker;
  const autoReady = ctx.autoReadyAfterMs ?? 60_000;

  if (t?.inPosition) {
    const heldFor = t.inPositionSince != null ? ctx.now - t.inPositionSince : 0;
    if (prev === 'READY' || ctx.readyTapped || heldFor >= autoReady) return 'READY';
    return 'IN_POSITION';
  }
  // Was positioned and the (debounced) tracker says we are out.
  if (prev === 'IN_POSITION' || prev === 'READY' || prev === 'LEFT_POSITION') {
    return 'LEFT_POSITION';
  }
  if (t?.arrived || prev === 'ARRIVED') return 'ARRIVED';
  if (ctx.insidePerimeter || prev === 'CHECKED_IN') return 'CHECKED_IN';
  return 'JOINED';
}

export interface StatusReport {
  eventId: string;
  state: ParticipantState;
  seq: number;
  /** Device-observed time of the transition, server-synced epoch ms. */
  at: number;
  accuracyM: number | null;
  clockUncertaintyMs: number | null;
}

export interface OutboxStorage {
  load(): StatusReport | null;
  save(r: StatusReport | null): void;
  loadSeq(): number;
  saveSeq(n: number): void;
}

export class MemoryOutboxStorage implements OutboxStorage {
  private r: StatusReport | null = null;
  private seq = 0;
  load() {
    return this.r;
  }
  save(r: StatusReport | null) {
    this.r = r;
  }
  loadSeq() {
    return this.seq;
  }
  saveSeq(n: number) {
    this.seq = n;
  }
}

export interface OutboxOptions {
  minIntervalMs: number;
  /** Quiet window around the formation start: no reports sent in [start - before, start + after]. */
  quietBeforeMs: number;
  quietAfterMs: number;
  /** After the quiet window, flushes are spread uniformly over this many ms. */
  quietSpreadMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  random: () => number;
}

export const DEFAULT_OUTBOX_OPTIONS: OutboxOptions = {
  minIntervalMs: 5_000,
  quietBeforeMs: 30_000,
  // Must exceed the COMPLETED delay (2 min after start) so that synchronized transition is spread too.
  quietAfterMs: 150_000,
  quietSpreadMs: 300_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 120_000,
  random: Math.random,
};

export type SendResult = 'ok' | 'retry' | 'drop';

/**
 * Coalescing outbox: holds at most ONE pending report (the latest state). A participant who
 * goes IN_POSITION → LEFT → IN_POSITION while offline sends a single report once online.
 * Sequence numbers are monotonic and persisted so the server can discard stale/replayed reports.
 */
export class StatusOutbox {
  private readonly opts: OutboxOptions;
  private pending: StatusReport | null;
  private seq: number;
  private lastSentAt = -Infinity;
  private failures = 0;
  private nextAttemptAt = 0;
  private quietJitter: number;

  constructor(private readonly storage: OutboxStorage, opts: Partial<OutboxOptions> = {}) {
    this.opts = { ...DEFAULT_OUTBOX_OPTIONS, ...opts };
    this.pending = storage.load();
    this.seq = storage.loadSeq();
    this.quietJitter = this.opts.random() * this.opts.quietSpreadMs;
  }

  enqueue(r: Omit<StatusReport, 'seq'>): StatusReport {
    this.seq += 1;
    this.storage.saveSeq(this.seq);
    const report = { ...r, seq: this.seq };
    this.pending = report;
    this.storage.save(report);
    return report;
  }

  get hasPending(): boolean {
    return this.pending != null;
  }

  get current(): StatusReport | null {
    return this.pending;
  }

  /** When may we next transmit? Returns null when nothing is pending. */
  nextSendTime(now: number, startsAt: number | null): number | null {
    if (!this.pending) return null;
    let t = Math.max(now, this.lastSentAt + this.opts.minIntervalMs, this.nextAttemptAt);
    if (startsAt != null) {
      const quietStart = startsAt - this.opts.quietBeforeMs;
      const quietEnd = startsAt + this.opts.quietAfterMs + this.quietJitter;
      if (t >= quietStart && t < quietEnd) t = quietEnd;
    }
    return t;
  }

  async flush(now: number, startsAt: number | null, send: (r: StatusReport) => Promise<SendResult>): Promise<'sent' | 'waiting' | 'empty' | 'failed'> {
    const due = this.nextSendTime(now, startsAt);
    if (due == null) return 'empty';
    if (due > now) return 'waiting';
    const report = this.pending!;
    let result: SendResult;
    try {
      result = await send(report);
    } catch {
      result = 'retry';
    }
    if (result === 'retry') {
      this.markFailed(now);
      return 'failed';
    }
    this.markSent(report, now);
    return 'sent';
  }

  /** Records a failed attempt: exponential backoff with full jitter (no synchronized retry storms). */
  markFailed(now: number): void {
    this.failures += 1;
    const cap = Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** this.failures);
    this.nextAttemptAt = now + this.opts.random() * cap;
  }

  /** Records a delivered (or permanently rejected) report. */
  markSent(report: StatusReport, now: number): void {
    this.failures = 0;
    this.lastSentAt = now;
    // A newer report may have been enqueued while the request was in flight.
    if (this.pending && this.pending.seq === report.seq) {
      this.pending = null;
      this.storage.save(null);
    }
  }
}
