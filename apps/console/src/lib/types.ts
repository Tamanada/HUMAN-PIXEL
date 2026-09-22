import type { EventState, ParticipantState } from '@human-pixel/core';

export interface EventRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  join_code: string;
  state: EventState;
  timezone: string;
  venue_name: string | null;
  center_lat: number | null;
  center_lng: number | null;
  starts_at: string | null;
  arrival_deadline: string | null;
  positions_release_at: string | null;
  /** Registration limit. NULL until the formation (or a manual target) decides it. */
  capacity: number | null;
  tolerance_radius_m: number;
  required_accuracy_m: number;
  allocation_mode: 'progressive' | 'random' | 'sequential';
  allow_late_registration: boolean;
  allow_anonymous_join: boolean;
  countdown: { vibrate: boolean; sound: boolean; flash: boolean; finalSeconds: number };
  share_message: string | null;
  hashtags: string[];
  announcement: string | null;
  photo_audience: 'registered' | 'checked_in';
  retention_days: number;
  active_formation_id: string | null;
  manifest_version: number;
  created_at: string;
  live_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface AreaRow {
  id: string;
  event_id: string;
  kind: 'perimeter' | 'formation_area' | 'exclusion' | 'no_go' | 'emergency' | 'access_point' | 'assembly' | 'entry_zone';
  name: string | null;
  /** Access-point symbol (see lib/symbols): medical, exit, toilets… */
  symbol?: string | null;
  geom: GeoJSON.Geometry;
  safety_buffer_m: number;
  is_public: boolean;
  area_m2?: number | null;
}

export interface FormationRow {
  id: string;
  event_id: string;
  version: number;
  status: 'uploading' | 'ready' | 'rejected' | 'locked' | 'archived';
  source: Record<string, unknown>;
  params: Record<string, unknown>;
  seed: number;
  point_count: number;
  uploaded_count: number;
  metrics: Record<string, number>;
  warnings: { code: string; message: string }[];
  validation: Record<string, unknown> | null;
  created_at: string;
  locked_at: string | null;
}

export interface LiveStats {
  event_id: string;
  state: EventState;
  starts_at: string | null;
  counts: {
    registered: number;
    waitlisted: number;
    cancelled: number;
    checked_in: number;
    arrived: number;
    in_position: number;
    ready: number;
    left_position: number;
    completed: number;
    assigned: number;
    points: number | null;
  };
  readiness: number;
  report_rate_per_s: number;
  gps: { median_accuracy_m: number | null; p90_accuracy_m: number | null; poor: number; p95_clock_uncertainty_ms: number | null; sampled: number };
  zones: { label: string; points: number; assigned: number; in_position: number }[];
  health: { level: 'NORMAL' | 'HIGH_LOAD' | 'CRITICAL'; issues: { level: string; code: string; message: string }[]; query_ms: number };
  server_time: string;
}

export interface MemberRow {
  id: string;
  participant_number: number;
  status: 'registered' | 'waitlisted' | 'cancelled' | 'removed';
  joined_at: string;
  group_id: string | null;
  public_listing: boolean;
  public_name: string | null;
  public_nationality: string | null;
  participant_status: { state: ParticipantState; reported_at: string | null; accuracy_m: number | null; report_count: number } | null;
}
