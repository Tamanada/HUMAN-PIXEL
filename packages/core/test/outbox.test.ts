import { describe, expect, it } from 'vitest';
import { MemoryOutboxStorage, StatusOutbox, deriveParticipantState, type TrackerSnapshot } from '../src';

const base = { eventId: 'e', at: 0, accuracyM: 4, clockUncertaintyMs: 20 };

describe('StatusOutbox (offline sync)', () => {
  it('coalesces offline transitions into one report with the latest state', async () => {
    const storage = new MemoryOutboxStorage();
    const ob = new StatusOutbox(storage, { random: () => 0.5 });
    ob.enqueue({ ...base, state: 'ARRIVED' });
    ob.enqueue({ ...base, state: 'IN_POSITION' });
    ob.enqueue({ ...base, state: 'LEFT_POSITION' });
    const r = ob.enqueue({ ...base, state: 'IN_POSITION' });
    expect(r.seq).toBe(4);
    const sent: string[] = [];
    // Offline: retries back off.
    expect(await ob.flush(0, null, async () => 'retry')).toBe('failed');
    expect(ob.nextSendTime(0, null)!).toBeGreaterThan(0);
    const later = 10 * 60_000;
    expect(await ob.flush(later, null, async (rep) => (sent.push(`${rep.state}#${rep.seq}`), 'ok'))).toBe('sent');
    expect(sent).toEqual(['IN_POSITION#4']);
    expect(ob.hasPending).toBe(false);
  });

  it('persists across restarts (app killed, battery died)', () => {
    const storage = new MemoryOutboxStorage();
    new StatusOutbox(storage).enqueue({ ...base, state: 'READY' });
    const revived = new StatusOutbox(storage);
    expect(revived.current?.state).toBe('READY');
    expect(revived.enqueue({ ...base, state: 'COMPLETED' }).seq).toBe(2);
  });

  it('enforces min interval', async () => {
    const ob = new StatusOutbox(new MemoryOutboxStorage(), { random: () => 0 });
    ob.enqueue({ ...base, state: 'ARRIVED' });
    await ob.flush(1000, null, async () => 'ok');
    ob.enqueue({ ...base, state: 'IN_POSITION' });
    expect(ob.nextSendTime(2000, null)).toBe(6000);
  });

  it('stays quiet around T-0 and spreads the flush afterwards (no thundering herd)', () => {
    const start = 1_000_000;
    const times = Array.from({ length: 1000 }, (_, i) => {
      const ob = new StatusOutbox(new MemoryOutboxStorage(), { random: () => (i + 0.5) / 1000 });
      ob.enqueue({ ...base, state: 'READY' });
      return ob.nextSendTime(start - 5_000, start)!;
    });
    expect(Math.min(...times)).toBeGreaterThanOrEqual(start + 150_000);
    // Spread over the 120 s window: no second receives more than ~1% of the crowd.
    const buckets = new Map<number, number>();
    for (const t of times) buckets.set(Math.floor(t / 1000), (buckets.get(Math.floor(t / 1000)) ?? 0) + 1);
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(12);
  });

  it('keeps a newer report enqueued while a send is in flight', async () => {
    const ob = new StatusOutbox(new MemoryOutboxStorage(), { random: () => 0 });
    ob.enqueue({ ...base, state: 'ARRIVED' });
    await ob.flush(0, null, async () => {
      ob.enqueue({ ...base, state: 'IN_POSITION' });
      return 'ok';
    });
    expect(ob.current?.state).toBe('IN_POSITION');
  });
});

describe('deriveParticipantState', () => {
  const snap = (p: Partial<TrackerSnapshot>): TrackerSnapshot => ({
    evaluation: { distance: 1, bearing: 0, accuracy: 3, quality: 'good', status: 'IN_POSITION', inside: true },
    inPosition: false,
    arrived: false,
    inPositionSince: null,
    gpsLost: false,
    ...p,
  });
  const ctx = { insidePerimeter: true, now: 100_000, startsAt: 1_000_000, readyTapped: false };
  it('progresses through the lifecycle', () => {
    expect(deriveParticipantState('JOINED', { ...ctx, insidePerimeter: false, tracker: null })).toBe('JOINED');
    expect(deriveParticipantState('JOINED', { ...ctx, tracker: null })).toBe('CHECKED_IN');
    expect(deriveParticipantState('CHECKED_IN', { ...ctx, tracker: snap({ arrived: true }) })).toBe('ARRIVED');
    expect(deriveParticipantState('ARRIVED', { ...ctx, tracker: snap({ arrived: true, inPosition: true, inPositionSince: 99_000 }) })).toBe('IN_POSITION');
    expect(deriveParticipantState('IN_POSITION', { ...ctx, tracker: snap({ inPosition: true, inPositionSince: 30_000 }) })).toBe('READY');
    expect(deriveParticipantState('IN_POSITION', { ...ctx, readyTapped: true, tracker: snap({ inPosition: true, inPositionSince: 99_000 }) })).toBe('READY');
    expect(deriveParticipantState('READY', { ...ctx, tracker: snap({ inPosition: false }) })).toBe('LEFT_POSITION');
    expect(deriveParticipantState('LEFT_POSITION', { ...ctx, tracker: snap({ inPosition: true, inPositionSince: 99_500 }) })).toBe('IN_POSITION');
    expect(deriveParticipantState('READY', { ...ctx, now: 1_000_000 + 130_000, tracker: snap({ inPosition: true }) })).toBe('COMPLETED');
  });
});
