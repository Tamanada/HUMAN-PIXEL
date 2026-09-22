/**
 * Runtime validation for everything that crosses a trust boundary (network, storage, workers).
 * Server-side, the same rules are enforced again in SQL; these schemas give early, typed errors.
 */
import { z } from 'zod';
import { EVENT_STATES } from './stateMachine';
import { PARTICIPANT_STATES } from './participantState';

export const eventStateSchema = z.enum(EVENT_STATES);
export const participantStateSchema = z.enum(PARTICIPANT_STATES);

export const joinCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6,10}$/, 'Event codes are 6–10 letters or digits');

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const geoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(position).min(4)).min(1),
});
export const geoJsonPointSchema = z.object({ type: z.literal('Point'), coordinates: position });

export const areaKindSchema = z.enum([
  'perimeter',
  'formation_area',
  'exclusion',
  'no_go',
  'emergency',
  'access_point',
  'assembly',
  'entry_zone',
  'collection',
  'control',
  'bounty',
]);
export type AreaKind = z.infer<typeof areaKindSchema>;

export const countdownConfigSchema = z.object({
  vibrate: z.boolean().default(true),
  sound: z.boolean().default(false),
  flash: z.boolean().default(true),
  finalSeconds: z.number().int().min(3).max(60).default(10),
});
export type CountdownConfig = z.infer<typeof countdownConfigSchema>;

/** Public, CDN-cached manifest. MUST NOT contain anything secret (no formation, no points). */
export const eventManifestSchema = z.object({
  schema: z.literal(1),
  eventId: z.string().uuid(),
  version: z.number().int(),
  /** Bumped when assignments are remapped (new formation version): phones refetch their pixel. */
  assignmentEpoch: z.number().int().default(0),
  name: z.string(),
  state: eventStateSchema,
  timezone: z.string(),
  startsAt: z.string().datetime({ offset: true }).nullable(),
  arrivalDeadline: z.string().datetime({ offset: true }).nullable(),
  positionsReleaseAt: z.string().datetime({ offset: true }).nullable(),
  venueName: z.string().nullable(),
  announcement: z.string().nullable(),
  photoReleased: z.boolean(),
  countdown: countdownConfigSchema,
  allowAnonymousJoin: z.boolean().default(false),
  publishedAt: z.string(),
});
export type EventManifest = z.infer<typeof eventManifestSchema>;

export const publicAreaSchema = z.object({
  kind: areaKindSchema,
  name: z.string().nullable(),
  geometry: z.union([geoJsonPolygonSchema, geoJsonPointSchema]),
});
export type PublicArea = z.infer<typeof publicAreaSchema>;

/** What participants are told: dress code, what to bring / collect, the bounty after the photo. */
export const briefingSchema = z
  .object({
    dressCode: z.object({ text: z.string().optional(), colors: z.array(z.string()).optional() }).optional(),
    bring: z.string().optional(),
    collect: z.string().optional(),
    bounty: z.string().optional(),
  })
  .default({});
export type Briefing = z.infer<typeof briefingSchema>;

/** The one collection / control / bounty point this participant must go to. */
export const pickupPointSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    kind: z.enum(['collection', 'control', 'bounty']),
    details: z.string().nullable(),
    opens_at: z.string().nullable(),
    closes_at: z.string().nullable(),
    lat: z.number(),
    lng: z.number(),
  })
  .nullable()
  .default(null);
export type PickupPoint = z.infer<typeof pickupPointSchema>;

/** What `get_my_assignment` returns: the participant's entire offline bundle. */
export const assignmentBundleSchema = z.object({
  event: z.object({
    id: z.string().uuid(),
    name: z.string(),
    state: eventStateSchema,
    timezone: z.string(),
    starts_at: z.string().nullable(),
    arrival_deadline: z.string().nullable(),
    positions_release_at: z.string().nullable(),
    venue_name: z.string().nullable(),
    center: latLngSchema.nullable(),
    tolerance_radius_m: z.number(),
    required_accuracy_m: z.number(),
    countdown: countdownConfigSchema,
    share_message: z.string().nullable(),
    hashtags: z.array(z.string()),
    briefing: briefingSchema,
    manifest_version: z.number().int(),
    assignment_epoch: z.number().int().default(0),
    participant_total: z.number().int(),
  }),
  member: z.object({
    id: z.string().uuid(),
    participant_number: z.number().int(),
    status: z.enum(['registered', 'waitlisted', 'cancelled', 'removed']),
    state: participantStateSchema,
    last_seq: z.number().int(),
  }),
  pixel: z
    .object({
      label: z.number().int(),
      zone: z.string(),
      released: z.boolean(),
      target: latLngSchema.nullable(),
    })
    .nullable(),
  pickup: pickupPointSchema,
  areas: z.array(publicAreaSchema),
  server_time: z.string(),
});
export type AssignmentBundle = z.infer<typeof assignmentBundleSchema>;

export const formationParamsSchema = z.object({
  targetCount: z.number().int().min(1).max(250_000),
  widthM: z.number().positive().max(20_000),
  heightM: z.number().positive().max(20_000).optional(),
  rotationDeg: z.number().min(-360).max(360).default(0),
  minSpacingM: z.number().min(0.5).max(20).default(0.9),
  anchor: latLngSchema,
  seed: z.number().int().nonnegative(),
  zoneSize: z.number().int().min(50).max(50_000).default(1_500),
  lloydIterations: z.number().int().min(0).max(40).optional(),
});
export type FormationParams = z.infer<typeof formationParamsSchema>;

export const formationSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string().trim().min(1).max(120),
    fontFamily: z.string().min(1),
    fontWeight: z.number().int().min(100).max(1000).default(800),
    letterSpacingEm: z.number().min(-0.2).max(1).default(0.04),
    lineHeightEm: z.number().min(0.6).max(3).default(1.05),
  }),
  z.object({
    kind: z.literal('image'),
    assetId: z.string().uuid().nullable(),
    fileName: z.string(),
    mode: z.enum(['alpha', 'luminance', 'auto']).default('auto'),
    invert: z.boolean().default(false),
  }),
]);
export type FormationSource = z.infer<typeof formationSourceSchema>;
