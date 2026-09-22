import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { readJson, writeJson } from './storage';

export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return { session, loading };
}

export function useSunlight(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => readJson<boolean>('sun') ?? false);
  useEffect(() => {
    document.documentElement.dataset.sun = on ? 'on' : 'off';
    writeJson('sun', on);
  }, [on]);
  return [on, setOn];
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/** Wall-clock time in the EVENT's timezone (what is printed on the posters). */
export function formatEventTime(iso: string | number | null | undefined, timeZone: string, withDate = false): string {
  if (iso == null) return '—';
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      ...(withDate ? { day: 'numeric', month: 'long', year: 'numeric' } : {}),
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function formatEventDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  } catch {
    return new Date(iso).toDateString();
  }
}

/** HH:MM:SS in the event's timezone, from server-synced epoch ms. */
export function formatClock(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}
