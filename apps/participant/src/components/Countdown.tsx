import { useEffect, useRef } from 'react';
import { countdown, formatCountdown, type CountdownConfig } from '@human-pixel/core';
import { vibrate } from '../lib/platform';

export function CountdownClock({ startsAt, now, label = 'Formation starts in' }: { startsAt: number; now: number; label?: string }) {
  const c = countdown(startsAt, now);
  return (
    <div className="text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted">{label}</p>
      <p className="hp-digits mt-2 text-6xl font-bold">{formatCountdown(c)}</p>
    </div>
  );
}

let audio: AudioContext | null = null;
function beep(freq: number, ms: number) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.25, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + ms / 1000);
  } catch {
    /* audio blocked */
  }
}

/** Unlocks WebAudio from a user gesture (iOS requirement) so the final beeps can play. */
export function primeAudio(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    /* ignore */
  }
}

/**
 * Full-screen final seconds → HUMAN PIXEL LIVE. Every phone computes this from its own synced
 * clock; nothing is broadcast.
 */
export function FinalCountdown({ startsAt, now, cfg }: { startsAt: number; now: number; cfg: CountdownConfig }) {
  const c = countdown(startsAt, now, { finalWindowMs: cfg.finalSeconds * 1000 });
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (last.current === c.displaySeconds) return;
    last.current = c.displaySeconds;
    if (c.phase === 'final') {
      if (cfg.vibrate) void vibrate(60);
      if (cfg.sound && c.displaySeconds <= 3) beep(660, 120);
    }
    if (c.phase === 'live' && c.displaySeconds === 0) {
      if (cfg.vibrate) void vibrate([400, 120, 400]);
      if (cfg.sound) beep(990, 600);
    }
  }, [c.displaySeconds, c.phase, cfg]);

  if (c.phase === 'final') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg" role="timer" aria-live="assertive">
        <p className="text-xs font-semibold uppercase tracking-[0.4em] text-muted">Hold your position</p>
        <p key={c.displaySeconds} className="hp-digits hp-tick mt-4 text-[38vw] font-bold leading-none text-pixel" style={{ textShadow: '0 0 40px var(--hp-pixel)' }}>
          {String(c.displaySeconds).padStart(2, '0')}
        </p>
      </div>
    );
  }
  return (
    <div className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg px-6 text-center ${cfg.flash ? 'hp-flash' : ''}`} role="alert">
      <div className="mb-8 h-6 w-6 rounded-md bg-pixel hp-glow hp-breathe" />
      <p className="hp-display hp-rise text-6xl">Human<br />Pixel<br /><span className="text-pixel">Live</span></p>
      <p className="hp-rise mt-8 max-w-xs text-lg text-muted" style={{ animationDelay: '0.4s' }}>
        Stay exactly where you are. You are the message.
      </p>
    </div>
  );
}
