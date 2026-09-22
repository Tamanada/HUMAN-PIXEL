import { describe, expect, it } from 'vitest';
import { ServerClock, countdown, estimateFromHttpDate, estimateOffset, formatCountdown, syncClock } from '../src';

describe('clock offset estimation', () => {
  it('computes the example from the spec (+0.810 s)', () => {
    // Device 18:27:12.610, server 18:27:13.420, 0 ms network.
    const device = Date.parse('2027-01-15T18:27:12.610Z');
    const e = estimateOffset([{ t0: device, t1: device, server: Date.parse('2027-01-15T18:27:13.420Z') }]);
    expect(e.offsetMs).toBe(810);
  });

  it('prefers low-RTT samples and is robust to queuing spikes', () => {
    const trueOffset = 810;
    const samples = [
      { t0: 0, t1: 40, server: 20 + trueOffset },
      { t0: 100, t1: 1100, server: 900 + trueOffset }, // badly asymmetric, huge RTT
      { t0: 1200, t1: 1236, server: 1218 + trueOffset },
      { t0: 1300, t1: 1344, server: 1324 + trueOffset },
      { t0: 1400, t1: 2400, server: 1500 + trueOffset },
    ];
    const e = estimateOffset(samples);
    expect(Math.abs(e.offsetMs - trueOffset)).toBeLessThanOrEqual(3);
    expect(e.uncertaintyMs).toBe(18);
  });

  it('syncClock tolerates failures and converges within uncertainty', async () => {
    let device = 1_000_000;
    const trueOffset = -2_345;
    let call = 0;
    const e = await syncClock(
      async () => {
        call++;
        if (call === 2) throw new Error('network');
        const up = 20 + (call % 3) * 15;
        device += up;
        const server = device + trueOffset;
        device += 25;
        return server;
      },
      { now: () => device, sleep: async (ms) => void (device += ms) },
    );
    expect(e.samples).toBe(4);
    expect(Math.abs(e.offsetMs - trueOffset)).toBeLessThanOrEqual(e.uncertaintyMs + 1);
  });

  it('http Date fallback has ≥ 500 ms uncertainty', () => {
    const e = estimateFromHttpDate('Fri, 15 Jan 2027 18:27:13 GMT', Date.parse('2027-01-15T18:27:12.900Z'), Date.parse('2027-01-15T18:27:13.000Z'));
    expect(e?.source).toBe('http-date');
    expect(e!.uncertaintyMs).toBeGreaterThanOrEqual(500);
  });

  it('ServerClock applies the offset and keeps the better estimate', () => {
    let d = 10_000;
    const c = new ServerClock(null, () => d);
    c.update({ offsetMs: 500, uncertaintyMs: 600, rttMs: 100, samples: 1, measuredAt: Date.now(), source: 'http-date' });
    c.update({ offsetMs: 810, uncertaintyMs: 20, rttMs: 40, samples: 5, measuredAt: Date.now(), source: 'ntp' });
    c.update({ offsetMs: 100, uncertaintyMs: 900, rttMs: 1800, samples: 1, measuredAt: Date.now(), source: 'http-date' });
    expect(c.now()).toBe(10_810);
    d += 5;
    expect(c.now()).toBe(10_815);
  });
});

describe('countdown', () => {
  const start = Date.parse('2027-01-15T18:30:00.000Z');
  it('phases and display', () => {
    const c = countdown(start, Date.parse('2027-01-15T18:29:42.000Z'));
    expect(c.phase).toBe('waiting');
    expect(formatCountdown(c)).toBe('00:18');
    expect(countdown(start, start - 2_500).displaySeconds).toBe(3);
    expect(countdown(start, start - 2_500).phase).toBe('final');
    expect(countdown(start, start).phase).toBe('live');
    expect(countdown(start, start).displaySeconds).toBe(0);
    expect(countdown(start, start + 11 * 60_000).phase).toBe('ended');
    expect(formatCountdown(countdown(start, start - 3_723_000))).toBe('01:02:03');
  });

  it('two phones with different device clocks hit T-0 at the same true instant', () => {
    const trueNow = start - 1;
    const phoneA = new ServerClock({ offsetMs: 810, uncertaintyMs: 10, rttMs: 20, samples: 5, measuredAt: Date.now(), source: 'ntp' }, () => trueNow - 810);
    const phoneB = new ServerClock({ offsetMs: -45_000, uncertaintyMs: 10, rttMs: 20, samples: 5, measuredAt: Date.now(), source: 'ntp' }, () => trueNow + 45_000);
    expect(countdown(start, phoneA.now()).phase).toBe('final');
    expect(countdown(start, phoneB.now()).phase).toBe('final');
    expect(countdown(start, phoneA.now() + 1).phase).toBe('live');
    expect(countdown(start, phoneB.now() + 1).phase).toBe('live');
  });
});
