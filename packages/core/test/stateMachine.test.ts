import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_STATES, EVENT_TRANSITIONS, assertTransition, canTransition, participantPhase, registrationAllowed, type EventState } from '../src';

describe('event state machine', () => {
  it('every state has an entry and terminal states have no exits', () => {
    for (const s of EVENT_STATES) expect(EVENT_TRANSITIONS[s]).toBeDefined();
    expect(EVENT_TRANSITIONS.COMPLETED).toHaveLength(0);
    expect(EVENT_TRANSITIONS.CANCELLED).toHaveLength(0);
  });

  it('happy path is legal', () => {
    const path: EventState[] = [
      'DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION',
      'POSITIONING', 'READY', 'LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING', 'PHOTO_RELEASED', 'COMPLETED',
    ];
    for (let i = 1; i < path.length; i++) expect(() => assertTransition(path[i - 1]!, path[i]!)).not.toThrow();
  });

  it('rejects skipping and resurrecting', () => {
    expect(canTransition('DRAFT', 'LIVE')).toBe(false);
    expect(canTransition('COMPLETED', 'DRAFT')).toBe(false);
    expect(canTransition('CANCELLED', 'REGISTRATION_OPEN')).toBe(false);
    expect(canTransition('LIVE', 'READY')).toBe(false);
    expect(() => assertTransition('PHOTO_RELEASED', 'LIVE')).toThrow(/ILLEGAL_TRANSITION/);
  });

  it('every non-terminal pre-photo state can be cancelled', () => {
    for (const s of EVENT_STATES) {
      if (['COMPLETED', 'CANCELLED', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING', 'PHOTO_RELEASED'].includes(s)) continue;
      expect(canTransition(s, 'CANCELLED')).toBe(true);
    }
  });

  it('late registration rules', () => {
    expect(registrationAllowed('REGISTRATION_OPEN', false)).toBe(true);
    expect(registrationAllowed('EVENT_PREPARATION', false)).toBe(false);
    expect(registrationAllowed('EVENT_PREPARATION', true)).toBe(true);
    expect(registrationAllowed('LIVE', true)).toBe(false);
  });

  it('phones go live on local time even if the server has not transitioned', () => {
    expect(participantPhase('READY', 1000, 1000)).toBe('live');
    expect(participantPhase('READY', 999, 1000)).toBe('navigate');
    expect(participantPhase('PHOTO_RELEASED', 0, 1000)).toBe('photo');
  });

  it('matches the SQL transition table exactly', () => {
    const dir = join(__dirname, '../../../supabase/migrations');
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    const block = sql.match(/insert into public\.event_state_transitions[\s\S]*?;/i);
    expect(block, 'event_state_transitions seed not found').toBeTruthy();
    const pairs = [...block![0].matchAll(/\('([A-Z_]+)'\s*,\s*'([A-Z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const expected = EVENT_STATES.flatMap((f) => EVENT_TRANSITIONS[f].map((t) => `${f}>${t}`)).sort();
    expect(pairs).toEqual(expected);
  });
});
