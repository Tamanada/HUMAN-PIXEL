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

/** Frame-accurate server time for countdowns (requestAnimationFrame, ~no battery cost). */
export function useServerNow(engine: ParticipantEngine, hz = 10): number {
  const [now, setNow] = useState(() => engine.now());
  const last = useRef(0);
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      if (t - last.current >= 1000 / hz) {
        last.current = t;
        setNow(engine.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, hz]);
  return now;
}
