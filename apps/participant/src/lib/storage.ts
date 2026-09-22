/**
 * Durable local storage for the offline bundle, clock estimate and outbox.
 * localStorage is synchronous (the outbox must persist before a send is attempted) and survives
 * restarts; every access is guarded because private modes and WebViews can throw.
 */
import type { OutboxStorage, StatusReport } from '@human-pixel/core';

const PREFIX = 'hp:';

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or disabled storage: the app keeps working from memory */
  }
}

export function removeKeys(predicate: (key: string) => boolean): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX) && predicate(k.slice(PREFIX.length))) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

export class LocalOutboxStorage implements OutboxStorage {
  constructor(private readonly eventId: string) {}
  load(): StatusReport | null {
    return readJson<StatusReport>(`outbox:${this.eventId}`);
  }
  save(r: StatusReport | null): void {
    writeJson(`outbox:${this.eventId}`, r);
  }
  loadSeq(): number {
    return readJson<number>(`seq:${this.eventId}`) ?? 0;
  }
  saveSeq(n: number): void {
    writeJson(`seq:${this.eventId}`, n);
  }
}

/** Random per-install identifier (not a hardware ID): lets the server tell devices apart. */
export function deviceId(): string {
  let id = readJson<string>('device');
  if (!id) {
    id = crypto.randomUUID();
    writeJson('device', id);
  }
  return id;
}

export interface JoinedEvent {
  eventId: string;
  name: string;
  joinedAt: string;
}

export function rememberEvent(e: JoinedEvent): void {
  const list = (readJson<JoinedEvent[]>('events') ?? []).filter((x) => x.eventId !== e.eventId);
  writeJson('events', [e, ...list].slice(0, 20));
}

export function joinedEvents(): JoinedEvent[] {
  return readJson<JoinedEvent[]>('events') ?? [];
}

export function forgetEvent(eventId: string): void {
  writeJson('events', joinedEvents().filter((e) => e.eventId !== eventId));
  removeKeys((k) => k.endsWith(`:${eventId}`));
}
