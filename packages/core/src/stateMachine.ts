/**
 * Event lifecycle. Mirrors `event_state_transitions` in supabase/migrations: a unit test parses
 * the migration and fails if the two ever diverge.
 */

export const EVENT_STATES = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'EVENT_PREPARATION',
  'PARTICIPANT_NAVIGATION',
  'POSITIONING',
  'READY',
  'LIVE',
  'PHOTO_CAPTURED',
  'PHOTO_PROCESSING',
  'PHOTO_RELEASED',
  'COMPLETED',
  'CANCELLED',
] as const;

export type EventState = (typeof EVENT_STATES)[number];

export const EVENT_TRANSITIONS: Readonly<Record<EventState, readonly EventState[]>> = {
  DRAFT: ['REGISTRATION_OPEN', 'CANCELLED'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'EVENT_PREPARATION', 'CANCELLED'],
  REGISTRATION_CLOSED: ['REGISTRATION_OPEN', 'EVENT_PREPARATION', 'CANCELLED'],
  EVENT_PREPARATION: ['PARTICIPANT_NAVIGATION', 'CANCELLED'],
  PARTICIPANT_NAVIGATION: ['POSITIONING', 'CANCELLED'],
  POSITIONING: ['READY', 'PARTICIPANT_NAVIGATION', 'LIVE', 'CANCELLED'],
  READY: ['LIVE', 'POSITIONING', 'CANCELLED'],
  LIVE: ['PHOTO_CAPTURED', 'CANCELLED'],
  PHOTO_CAPTURED: ['PHOTO_PROCESSING', 'PHOTO_RELEASED'],
  PHOTO_PROCESSING: ['PHOTO_RELEASED'],
  PHOTO_RELEASED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const TERMINAL_STATES: readonly EventState[] = ['COMPLETED', 'CANCELLED'];

export function canTransition(from: EventState, to: EventState): boolean {
  return EVENT_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: EventState, to: EventState): void {
  if (!canTransition(from, to)) throw new Error(`ILLEGAL_TRANSITION ${from} -> ${to}`);
}

export function isEventState(s: string): s is EventState {
  return (EVENT_STATES as readonly string[]).includes(s);
}

/** States in which participants may join (late registration adds preparation/navigation). */
export function registrationAllowed(state: EventState, allowLate: boolean): boolean {
  if (state === 'REGISTRATION_OPEN') return true;
  return allowLate && (state === 'EVENT_PREPARATION' || state === 'PARTICIPANT_NAVIGATION');
}

/** States in which formation geometry and constraints may still change. */
export function formationEditable(state: EventState): boolean {
  return state === 'DRAFT' || state === 'REGISTRATION_OPEN' || state === 'REGISTRATION_CLOSED' || state === 'EVENT_PREPARATION';
}

/** Coarse phase a participant's phone renders. */
export type ParticipantPhase = 'upcoming' | 'navigate' | 'live' | 'waiting_photo' | 'photo' | 'ended' | 'cancelled';

export function participantPhase(state: EventState, serverNow: number, startsAt: number | null): ParticipantPhase {
  if (state === 'CANCELLED') return 'cancelled';
  if (state === 'PHOTO_RELEASED') return 'photo';
  if (state === 'COMPLETED') return 'ended';
  if (state === 'LIVE' || state === 'PHOTO_CAPTURED' || state === 'PHOTO_PROCESSING') return 'waiting_photo';
  // Phones never wait for the server to say LIVE: local time is authoritative for the moment.
  if (startsAt != null && serverNow >= startsAt) return 'live';
  if (state === 'PARTICIPANT_NAVIGATION' || state === 'POSITIONING' || state === 'READY') return 'navigate';
  return 'upcoming';
}

export const EVENT_STATE_LABELS: Record<EventState, string> = {
  DRAFT: 'Draft',
  REGISTRATION_OPEN: 'Registration open',
  REGISTRATION_CLOSED: 'Registration closed',
  EVENT_PREPARATION: 'Preparation',
  PARTICIPANT_NAVIGATION: 'Navigation',
  POSITIONING: 'Positioning',
  READY: 'Ready',
  LIVE: 'Live',
  PHOTO_CAPTURED: 'Photo captured',
  PHOTO_PROCESSING: 'Photo processing',
  PHOTO_RELEASED: 'Photo released',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
