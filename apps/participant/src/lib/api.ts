/**
 * Participant API: every call the phone makes to the backend. There are deliberately few.
 */
import {
  assignmentBundleSchema,
  eventManifestSchema,
  estimateFromHttpDate,
  syncClock,
  type AssignmentBundle,
  type ClockEstimate,
  type EventManifest,
  type ParticipantState,
  type StatusReport,
  type SendResult,
} from '@human-pixel/core';
import { z } from 'zod';
import { config } from './config';
import { supabase } from './supabase';
import { deviceId } from './storage';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  EVENT_NOT_FOUND: 'We could not find an event with this code.',
  REGISTRATION_CLOSED: 'Registration for this event is closed.',
  REGISTRATION_DISABLED: 'Registration is temporarily paused. Try again shortly.',
  CONSENT_REQUIRED: 'Please accept the participation terms to continue.',
  EMAIL_SIGN_IN_REQUIRED: 'This event requires you to sign in with your email.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  GROUP_NOT_FOUND: 'This group code is not valid for the event.',
  GROUP_FULL: 'This group is full.',
  REMOVED_FROM_EVENT: 'You are no longer part of this event. Contact the organizer.',
  NOT_A_PARTICIPANT: 'You are not registered for this event.',
  EVENT_ALREADY_HAPPENED: 'This event has already taken place.',
  AUTH_REQUIRED: 'Please sign in again.',
  ACCOUNT_SUSPENDED: 'This account is suspended.',
  EVENT_UNAVAILABLE: 'This event is not available.',
  PROFILE_REQUIRED: 'Please tell us a little about yourself first.',
  INVALID_FIRST_NAME: 'Please enter your first name using letters only.',
  INVALID_AGE: 'Please enter a valid age.',
  INVALID_NATIONALITY: 'Please choose your nationality.',
  TOO_YOUNG_FOR_PUBLIC_LISTING: 'Participants under 16 stay anonymous in the Hall of Fame.',
};

function toApiError(e: { message?: string; code?: string } | null, fallback = 'Something went wrong'): ApiError {
  const msg = e?.message ?? fallback;
  const code = msg.match(/^([A-Z_]{4,})/)?.[1] ?? (e?.code === 'PGRST301' ? 'AUTH_REQUIRED' : 'UNKNOWN');
  const retryable = code === 'UNKNOWN' || /fetch|network|timeout|Failed/i.test(msg);
  return new ApiError(code, FRIENDLY[code] ?? (retryable ? 'Network problem. We will retry automatically.' : msg), retryable);
}

async function call<T>(fn: string, args: Record<string, unknown>, schema?: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toApiError(error);
  return schema ? schema.parse(data) : (data as T);
}

export const previewSchema = z.object({
  eventId: z.string().uuid(),
  name: z.string(),
  state: z.string(),
  venueName: z.string().nullable(),
  startsAt: z.string().nullable(),
  timezone: z.string(),
  registrationOpen: z.boolean(),
  allowAnonymousJoin: z.boolean(),
  consentVersion: z.string(),
});
export type EventPreview = z.infer<typeof previewSchema>;

export async function getEventPreview(code: string): Promise<EventPreview | null> {
  const { data, error } = await supabase.rpc('get_event_preview', { p_code: code });
  if (error) throw toApiError(error);
  return data ? previewSchema.parse(data) : null;
}

export function joinEvent(code: string, consentVersion: string, groupCode?: string, publicListing = false): Promise<AssignmentBundle> {
  return call(
    'join_event',
    { p_code: code, p_consent_version: consentVersion, p_group_code: groupCode || null, p_device_id: deviceId(), p_public_listing: publicListing },
    assignmentBundleSchema,
  );
}

// ---- Identity & Hall of Fame ------------------------------------------------------------------
export const profileSchema = z.object({
  first_name: z.string().nullable(),
  age: z.number().nullable(),
  sex: z.enum(['female', 'male', 'other', 'undisclosed']).nullable(),
  nationality: z.string().nullable(),
  complete: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;

export function getMyProfile(): Promise<Profile> {
  return call('get_my_profile', {}, profileSchema);
}

export function saveMyProfile(p: { firstName: string; age: number; sex: string; nationality: string }): Promise<Profile> {
  return call('save_my_profile', { p_first_name: p.firstName, p_age: p.age, p_sex: p.sex, p_nationality: p.nationality }, profileSchema);
}

export function getMyListing(eventId: string): Promise<boolean> {
  return call<boolean>('get_my_listing', { p_event_id: eventId });
}

export function setMyListing(eventId: string, isPublic: boolean): Promise<boolean> {
  return call<boolean>('set_my_listing', { p_event_id: eventId, p_public: isPublic });
}

export const hallSchema = z.object({
  event: z.object({ id: z.string(), name: z.string(), state: z.string(), startsAt: z.string().nullable(), timezone: z.string(), venueName: z.string().nullable() }),
  participants: z.number().nullable(),
  listed: z.number(),
  countries: z.number(),
  byNationality: z.array(z.object({ code: z.string(), count: z.number() })),
  people: z.array(z.object({ name: z.string(), nationality: z.string().nullable() })),
});
export type HallOfFame = z.infer<typeof hallSchema>;

export async function getHallOfFame(eventId: string, offset = 0, nationality: string | null = null): Promise<HallOfFame | null> {
  const { data, error } = await supabase.rpc('get_hall_of_fame', { p_event_id: eventId, p_limit: 200, p_offset: offset, p_nationality: nationality });
  if (error) throw toApiError(error);
  return data ? hallSchema.parse(data) : null;
}

export function getMyAssignment(eventId: string): Promise<AssignmentBundle> {
  return call('get_my_assignment', { p_event_id: eventId }, assignmentBundleSchema);
}

export function cancelParticipation(eventId: string): Promise<void> {
  return call('cancel_my_participation', { p_event_id: eventId });
}

export const photoCardSchema = z.object({
  released: z.boolean(),
  eligible: z.boolean().optional(),
  event_name: z.string().optional(),
  event_date: z.string().nullable().optional(),
  timezone: z.string().optional(),
  pixel_label: z.number().nullable().optional(),
  participant_number: z.number().optional(),
  participants: z.number().nullable().optional(),
  share_message: z.string().nullable().optional(),
  hashtags: z.array(z.string()).optional(),
  photo: z
    .object({ id: z.string(), display_path: z.string(), share_path: z.string(), thumb_path: z.string(), width: z.number().nullable(), height: z.number().nullable() })
    .nullable()
    .optional(),
});
export type PhotoCard = z.infer<typeof photoCardSchema>;

export function getMyPhoto(eventId: string): Promise<PhotoCard> {
  return call('get_my_photo', { p_event_id: eventId }, photoCardSchema);
}

export async function signedPhotoUrl(path: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await supabase.storage.from('event-photos').createSignedUrl(path, expiresIn);
  if (error || !data) throw toApiError(error as { message: string });
  return data.signedUrl;
}

/** Sends one status report. Maps transport outcomes to outbox semantics. */
export async function sendStatus(r: StatusReport, clockUncertaintyMs: number | null): Promise<SendResult> {
  if (!navigator.onLine) return 'retry';
  const { data, error } = await supabase.rpc('report_status', {
    p_event_id: r.eventId,
    p_state: r.state satisfies ParticipantState,
    p_seq: r.seq,
    p_client_at: new Date(r.at).toISOString(),
    p_accuracy_m: r.accuracyM != null && Number.isFinite(r.accuracyM) ? Math.round(r.accuracyM * 10) / 10 : null,
    p_clock_uncertainty_ms: clockUncertaintyMs != null && Number.isFinite(clockUncertaintyMs) ? Math.round(clockUncertaintyMs) : null,
    p_device_id: deviceId(),
    p_app_version: config.appVersion,
  });
  if (error) {
    const e = toApiError(error);
    // Not a participant any more (cancelled/removed): drop, retrying cannot succeed.
    return e.code === 'NOT_A_PARTICIPANT' ? 'drop' : 'retry';
  }
  const res = data as { accepted: boolean; reason?: string };
  if (!res.accepted && res.reason === 'RATE_LIMITED') return 'retry';
  return 'ok'; // accepted, or STALE (the server already has something newer)
}

// ---- Manifest (CDN) -------------------------------------------------------------------------
export interface ManifestResult {
  manifest: EventManifest;
  /** Coarse clock estimate from the response Date header, when available. */
  clock: ClockEstimate | null;
}

export async function fetchManifest(eventId: string, signal?: AbortSignal): Promise<ManifestResult | null> {
  if (config.manifestUrl) {
    const url = config.manifestUrl.replace('{eventId}', encodeURIComponent(eventId));
    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
      const t1 = Date.now();
      if (res.ok) {
        const date = res.headers.get('date');
        return {
          manifest: eventManifestSchema.parse(await res.json()),
          clock: date ? estimateFromHttpDate(date, t0, t1) : null,
        };
      }
      if (res.status === 404) return null;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      /* CDN unreachable: fall back to the RPC below */
    }
  }
  const { data, error } = await supabase.rpc('get_event_manifest', { p_event_id: eventId });
  if (error) throw toApiError(error);
  return data ? { manifest: eventManifestSchema.parse(data), clock: null } : null;
}

// ---- Clock ----------------------------------------------------------------------------------
export async function measureClock(): Promise<ClockEstimate> {
  const url = config.timeUrl ?? `${config.supabaseUrl}/functions/v1/time`;
  const headers: Record<string, string> = config.timeUrl ? {} : { apikey: config.supabaseAnonKey, authorization: `Bearer ${config.supabaseAnonKey}` };
  return syncClock(async (signal) => {
    const res = await fetch(url, { signal, cache: 'no-store', headers });
    if (!res.ok) throw new Error(`time ${res.status}`);
    const body = (await res.json()) as { now: number };
    if (!Number.isFinite(body.now)) throw new Error('bad time payload');
    return body.now;
  });
}
