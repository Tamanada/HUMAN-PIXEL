/**
 * Clock synchronisation and local countdown.
 * The server is asked for the time a handful of times when the phone joins; afterwards every
 * phone runs its own countdown against `Date.now() + offset`. No 3-2-1 broadcast exists.
 */

export interface ClockSample {
  /** Device time when the request was sent (ms). */
  t0: number;
  /** Authoritative server time (ms) embedded in the response. */
  server: number;
  /** Device time when the response was received (ms). */
  t1: number;
}

export interface ClockEstimate {
  /** serverTime - deviceTime, ms. */
  offsetMs: number;
  /** Half of the best round-trip: bound on the error assuming symmetric-ish paths. */
  uncertaintyMs: number;
  rttMs: number;
  samples: number;
  /** Device time at which the estimate was computed. */
  measuredAt: number;
  source: 'ntp' | 'http-date' | 'none';
}

export function sampleOffset(s: ClockSample): { offset: number; rtt: number } {
  const rtt = Math.max(0, s.t1 - s.t0);
  return { offset: s.server - (s.t0 + s.t1) / 2, rtt };
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/**
 * NTP-style estimate: keep the lowest-RTT samples (least queuing noise) and take the median
 * of their offsets.
 */
export function estimateOffset(samples: ClockSample[], keep = 3): ClockEstimate {
  const valid = samples.filter((s) => Number.isFinite(s.server) && s.t1 >= s.t0);
  if (valid.length === 0) {
    return { offsetMs: 0, uncertaintyMs: Infinity, rttMs: Infinity, samples: 0, measuredAt: Date.now(), source: 'none' };
  }
  const scored = valid.map((s) => ({ s, ...sampleOffset(s) })).sort((a, b) => a.rtt - b.rtt);
  const best = scored.slice(0, Math.max(1, Math.min(keep, scored.length)));
  const minRtt = best[0]!.rtt;
  return {
    offsetMs: median(best.map((b) => b.offset)),
    uncertaintyMs: minRtt / 2,
    rttMs: minRtt,
    samples: valid.length,
    measuredAt: valid[valid.length - 1]!.t1,
    source: 'ntp',
  };
}

export interface SyncOptions {
  samples?: number;
  spacingMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `samples` sequential exchanges. `fetchServerTime` must return the server's epoch ms;
 * failures are tolerated as long as at least one exchange succeeds.
 */
export async function syncClock(
  fetchServerTime: (signal: AbortSignal) => Promise<number>,
  opts: SyncOptions = {},
): Promise<ClockEstimate> {
  const n = opts.samples ?? 5;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const samples: ClockSample[] = [];
  for (let i = 0; i < n; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4_000);
    const t0 = now();
    try {
      const server = await fetchServerTime(ctrl.signal);
      samples.push({ t0, server, t1: now() });
    } catch {
      /* tolerate individual failures */
    } finally {
      clearTimeout(timer);
    }
    if (i < n - 1) await sleep(opts.spacingMs ?? 120);
  }
  if (samples.length === 0) throw new Error('CLOCK_SYNC_FAILED');
  return estimateOffset(samples);
}

/** Coarse fallback from an HTTP `Date` header (1 s resolution). */
export function estimateFromHttpDate(dateHeader: string, t0: number, t1: number): ClockEstimate | null {
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return null;
  // The header is truncated to the second: centre it.
  const e = estimateOffset([{ t0, t1, server: server + 500 }], 1);
  return { ...e, uncertaintyMs: e.uncertaintyMs + 500, source: 'http-date' };
}

/** Prefer the more precise estimate; a fresh coarse one beats a very old precise one. */
export function betterEstimate(a: ClockEstimate | null, b: ClockEstimate | null, maxAgeMs = 6 * 3600_000): ClockEstimate | null {
  if (!a) return b;
  if (!b) return a;
  const stale = (e: ClockEstimate) => Date.now() - e.measuredAt > maxAgeMs;
  if (stale(a) !== stale(b)) return stale(a) ? b : a;
  return a.uncertaintyMs <= b.uncertaintyMs ? a : b;
}

export class ServerClock {
  constructor(private estimate: ClockEstimate | null = null, private readonly deviceNow: () => number = () => Date.now()) {}

  update(e: ClockEstimate | null): void {
    this.estimate = betterEstimate(e, this.estimate);
  }

  get current(): ClockEstimate | null {
    return this.estimate;
  }

  /** Authoritative "now" in epoch ms. */
  now(): number {
    return this.deviceNow() + (this.estimate?.offsetMs ?? 0);
  }

  get synced(): boolean {
    return this.estimate != null && this.estimate.source !== 'none';
  }

  toJSON(): ClockEstimate | null {
    return this.estimate;
  }
}

export type CountdownPhase = 'waiting' | 'final' | 'live' | 'ended';

export interface CountdownState {
  remainingMs: number;
  phase: CountdownPhase;
  hours: number;
  minutes: number;
  seconds: number;
  /** Whole seconds remaining, ceil'd: shows "3, 2, 1" and then 0 at exactly T. */
  displaySeconds: number;
}

export function countdown(targetMs: number, nowMs: number, opts: { finalWindowMs?: number; liveDurationMs?: number } = {}): CountdownState {
  const remainingMs = targetMs - nowMs;
  const finalWindow = opts.finalWindowMs ?? 10_000;
  const liveDuration = opts.liveDurationMs ?? 10 * 60_000;
  let phase: CountdownPhase;
  if (remainingMs > finalWindow) phase = 'waiting';
  else if (remainingMs > 0) phase = 'final';
  else if (-remainingMs < liveDuration) phase = 'live';
  else phase = 'ended';
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return {
    remainingMs,
    phase,
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    displaySeconds: total,
  };
}

export function formatCountdown(c: CountdownState): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return c.hours > 0 ? `${pad(c.hours)}:${pad(c.minutes)}:${pad(c.seconds)}` : `${pad(c.minutes)}:${pad(c.seconds)}`;
}
