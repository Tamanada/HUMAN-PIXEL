import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AssignmentBundle } from '@human-pixel/core';
import { ParticipantEngine, type EngineSnapshot } from './ParticipantEngine';

const engines = new Map<string, { engine: ParticipantEngine; refs: number }>();

/** One engine per event, shared across screens, started once and disposed with its last user. */
export function useEngine(eventId: string, initial?: AssignmentBundle): { engine: ParticipantEngine; snap: EngineSnapshot } {
  const [engine] = useState(() => {
    const existing = engines.get(eventId);
    if (existing) return existing.engine;
    const e = new ParticipantEngine(eventId, initial);
    engines.set(eventId, { engine: e, refs: 0 });
    e.start();
    return e;
  });
  useEffect(() => {
    const entry = engines.get(eventId);
    if (entry) entry.refs++;
    return () => {
      const en = engines.get(eventId);
      if (!en) return;
      en.refs--;
      if (en.refs <= 0) {
        // Keep it alive briefly for screen transitions.
        setTimeout(() => {
          const again = engines.get(eventId);
          if (again && again.refs <= 0) {
            again.engine.dispose();
            engines.delete(eventId);
          }
        }, 5_000);
      }
    };
  }, [eventId]);
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  return { engine, snap };
}

/**
 * Server time for countdowns. Timers are aligned to the exact server-second boundary, so "3, 2, 1"
 * flips within a few ms of the true second on every phone (not "up to 1/hz late"), and unlike
 * requestAnimationFrame they keep running when the page is not painting.
 */
export function useServerNow(engine: ParticipantEngine, hz = 4): number {
  const [now, setNow] = useState(() => engine.now());
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const tick = () => {
      const n = engine.now();
      setNow(n);
      const toNextSecond = 1000 - (((n % 1000) + 1000) % 1000) + 2;
      timer.current = window.setTimeout(tick, Math.min(toNextSecond, 1000 / hz));
    };
    tick();
    return () => window.clearTimeout(timer.current);
  }, [engine, hz]);
  return now;
}
