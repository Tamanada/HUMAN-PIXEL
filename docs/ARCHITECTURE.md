# HUMAN PIXEL — Architecture (v1.0, binding)

> THE SERVER COORDINATES THE EVENT. THE PHONE EXECUTES THE EXPERIENCE.

This document is the binding blueprint. Code that contradicts it is a bug in one of the two;
fix the one that is wrong and keep them in sync.

## 1. Repository audit (2026-09-22)

Greenfield: the directory was empty. `C:\Users\David` is itself a git repository, so this project
received its own `git init` to isolate it. Toolchain: Node 24, npm 11 (workspaces), Supabase CLI,
Docker Desktop (local Supabase stack), Netlify for static hosting (same conventions as the
owner's other projects).

## 2. System overview

```
                         ┌──────────────────────────────────────────────┐
  Organizer / Admin ───▶ │ apps/console  (Vite+React, Netlify)          │
                         │  • formation engine in a Web Worker          │
                         │  • live dashboard (poll RPC + Realtime)      │
                         └───────────────┬──────────────────────────────┘
                                         │ PostgREST RPC (JWT, RLS)
                         ┌───────────────▼──────────────────────────────┐
                         │ Supabase                                     │
                         │  Postgres 15 + PostGIS + pg_cron             │
                         │  RLS on every table, SECURITY DEFINER RPCs   │
                         │  Edge Functions: time, account-delete        │
                         │  Storage: event-photos (private, RLS)        │
                         │           formation-assets (private)         │
                         └───────────────▲──────────────────────────────┘
      join / assignment (once)           │         status transitions only
      time sync (5 tiny samples)         │         (coalesced, idempotent)
                         ┌───────────────┴──────────────────────────────┐
  Participant ─────────▶ │ apps/participant (PWA + Capacitor iOS/Android)│
                         │  • GPS, distance, bearing, tolerance: LOCAL  │
                         │  • countdown from synced clock: LOCAL        │
                         │  • offline bundle + outbox                   │
                         │  • polls CDN manifest (Netlify durable cache)│
                         └──────────────────────────────────────────────┘
```

Packages:

| Path | Role |
|---|---|
| `packages/core` | Pure TypeScript domain: geo, positioning + hysteresis, clock sync, countdown, event state machine, formation engine, fill ordering, outbox, simulation. No I/O. Fully unit-tested. |
| `apps/participant` | Participant PWA / Capacitor app. |
| `apps/console` | Organizer dashboard + platform admin (role-gated routes). |
| `supabase/` | Migrations, RLS, RPCs, Edge Functions, SQL tests, seed. |
| `tools/simulator` | Load & concurrency simulator against a real Postgres (1k → 50k participants). |

## 3. Load model (why it scales)

| Moment | Naive design | HUMAN PIXEL |
|---|---|---|
| Walking to position | 12k × 1 GPS/s = 12,000 writes/s | 0. GPS never leaves the phone. |
| Status | – | ≤ ~8 coalesced transitions per participant per event, min 5 s apart, idempotent by `seq`. 12k participants over a 45 min positioning window ≈ 35 writes/s average. |
| Countdown | server broadcast to 12k sockets | 0. Each phone computes `serverNow = Date.now() + offset`. |
| T-0 (start) | 12k requests at the same instant | 0. The outbox is **quiet** from T-30 s to T+150 s, then each phone flushes at its own random offset within 5 minutes (the simulation caught a synchronized `COMPLETED` burst before this window was widened). |
| Event state changes | Realtime to 12k sockets (above default quotas) | Public manifest (`get_event_manifest`, secrets-free) served by a Netlify Function with durable CDN caching (`s-maxage=10, stale-while-revalidate=60`); phones poll with jitter (10 min → 30 s as T-0 approaches, silent from T-60 s to T+150 s). Origin load is independent of crowd size. Fallback: direct RPC. |
| Dashboard | Realtime per participant row change | 1 aggregate RPC every 5 s per organizer (indexed `GROUP BY` over ≤ 50k rows ≈ ms). |

Additional protections: per-user rate limits on join/report RPCs (`rate_limits` table), idempotent
RPCs (client `seq`, `ON CONFLICT`), retries with exponential backoff + full jitter, connection pooling
through Supavisor (PostgREST), and bulk set-based SQL for assignment (never row-by-row loops from the client).

## 4. Security model

Roles: platform `admin` (profiles.platform_role), organization roles `owner | admin | member`
(organizers), and `participant` (event_members).

Rules:

1. **Default deny.** RLS is enabled on every table. `anon` has no table privileges. `authenticated`
   has `SELECT` only where a policy exists; **all writes to sensitive tables go through
   `SECURITY DEFINER` functions** that re-check authorization with `auth.uid()`.
2. Participants have **zero** row access to `formations`, `formation_points`, `formation_assets`,
   `formation_zones`, `assignment_log`, other members, or other statuses. The only way to learn a
   coordinate is `get_my_assignment(event_id)`, which returns exactly one point: the caller's own.
3. Coordinates are withheld until `events.positions_release_at` (default: event day). This makes
   scraping by mass fake registration weeks in advance useless. Joins are rate-limited per user and per event.
4. The pixel number shown to a participant is a random permutation label, not the spatial index,
   so it leaks nothing about where in the image the pixel sits.
5. Protected columns (`state`, `org_id`, `join_code`, `active_formation_id`, `manifest_version`, …)
   are guarded by a trigger. Only internal functions (which set `hp.internal`) may change them.
6. Storage: `event-photos` is private. Participants can read an object only if the photo is
   released and they are an eligible member (policy on `storage.objects`). `formation-assets` is
   organizer-only.
7. Residual risk (accepted, documented): on the event day, participants who pool their own
   coordinates could reconstruct part of the image. That is inherent to the concept. The mitigations
   are late release of coordinates and rate limits.

## 5. Data model (Postgres + PostGIS)

Core tables (see `supabase/migrations`):

- `profiles`: 1:1 with `auth.users`; `platform_role`, locale, privacy consent, soft delete.
- `organizations`, `organization_members`, `organization_subscriptions`.
- `events`: timing (`starts_at`, `arrival_deadline`, `positions_release_at`), tolerance
  (`tolerance_radius_m`, `required_accuracy_m`), countdown config, share config, `state`,
  `active_formation_id`, `manifest_version`.
- `event_areas` (= boundaries and points): `perimeter | formation_area | exclusion | no_go |
  emergency | access_point | assembly | entry_zone | collection | control | bounty`, PostGIS
  geometry, `safety_buffer_m`, `is_public`, `symbol` (ISO pictogram or an organizer-made type in
  `event_symbols`), and for service points `capacity`, `opens_at`, `closes_at`, `details`.
- `events.briefing` (jsonb) and `event_members.pickup_area_id`: see §8b.
- `formations` (versioned per event), `formation_assets`, `formation_zones`,
  `formation_points` (≤ 100k rows per formation; `member_id UNIQUE` = the assignment).
- `event_groups`, `event_members` (participants; `participant_number` sequential per event).
- `participant_status`: one row per member, updated in place (no GPS history is ever stored).
- `assignment_log`: append-only evidence of every assign / release / reassign.
- `event_state_history`, `audit_logs`, `event_stat_snapshots`.
- `event_photos`, `notifications`, `abuse_reports`, `platform_settings`, `rate_limits`.
- Identity: `profiles.first_name / birth_year / sex / nationality` (required to join); per-event snapshot on
  `event_members` for demographics, plus `public_listing / public_name / public_nationality` for the public
  **Hall of Fame** (`/hall/:eventId`): opt-in per event, anonymous by default, never for under-16s, never
  with age, sex or position.

**Assignment invariant, enforced by the database:** `formation_points.member_id` is `UNIQUE`,
so a point has at most one holder and a member holds at most one point (member rows are
event-scoped). Free points are claimed with `FOR UPDATE SKIP LOCKED` ordered by
`fill_rank`, served by a partial index `WHERE member_id IS NULL`.

## 6. Event state machine

```
DRAFT → REGISTRATION_OPEN ⇄ REGISTRATION_CLOSED → EVENT_PREPARATION → PARTICIPANT_NAVIGATION
  → POSITIONING ⇄ READY → LIVE → PHOTO_CAPTURED → PHOTO_PROCESSING → PHOTO_RELEASED → COMPLETED
(PARTICIPANT_NAVIGATION ⇄ POSITIONING and POSITIONING → LIVE allowed; any pre-photo state → CANCELLED)
```

The transition table is defined once in SQL (`event_state_transitions`) and mirrored in
`packages/core/src/stateMachine.ts`; a test asserts that both are identical. Every transition goes
through `transition_event()`, which checks role, legality and preconditions (perimeter present,
locked formation before EVENT_PREPARATION, released photo before PHOTO_RELEASED), and then writes
`event_state_history` and `audit_logs`. `pg_cron` auto-advances READY/POSITIONING → LIVE at `starts_at`
**for the record only**: phones never wait for it.

## 7. Formation engine

Input: a coverage mask (text rendered with real fonts via OffscreenCanvas, or SVG / PNG alpha /
luminance), physical design size (W × H m), anchor, rotation, target count N, minimum human spacing,
perimeter, exclusions (+ safety buffers).

1. Rasterize constraints into the design frame: `valid = design ∧ perimeter ∧ ¬(exclusion ⊕ buffer)`.
2. Solve for spacing: hexagonal packing gives `s = √(2A / (√3·N))`. If `s < minSpacing` → hard error with the required area.
3. Binary-search a jittered hex lattice so that the count is ≥ N, then drop the surplus using the progressive order (holes end up spread out evenly).
4. **Lloyd relaxation** (centroidal Voronoi on the valid-pixel field, spatial hash, 6–12 iterations): smooth edges, uniform density, points hug letter contours (acts as anti-aliasing).
5. Metrics: min/mean neighbour distance, density (p/m²), stroke thickness in persons (distance transform), readability score + warnings (e.g. "strokes < 3 people wide").
6. `fill_rank`: hierarchical grid decimation, so every prefix of the order is spatially uniform. Assignment fills in this order, so partial turnout still gives a readable image.
7. Zones: equal-count bands along the formation's long axis (labels A, B, C …).
8. Labels: seeded random permutation 1..N (pixel numbers).

The engine is pure (`packages/core`) and deterministic for a given seed. It is tested at 1k / 5k / 12k / 50k.

**Capacity is an output, not an input.** Nobody knows the head count before the surface and the
message exist, so an event is created without a capacity (`events.capacity` is NULL = "set by
the formation"). The order is surface → design → head count → capacity:

- *Location* shows what the surface holds (`surfaceCapacity`: usable m² after buffered
  exclusions, hex packing at 1.2 / 1.3 / 1.5 m). A message covers only 25–45 % of that.
- *Formation*, two sizing modes. **Fill the surface**: `fitDesignWidth` finds the largest width
  whose footprint stays inside the formation area (else the perimeter). Only the outer boundary
  limits the size; exclusions inside it just remove pixels. N is then the hex-lattice count at the
  target spacing. **I know my head count**: N is given and the width follows (the old mode).
- Capacity follows the design. `set_capacity_from_formation` adopts a validated version's pixel
  count so registration can open while the design stays editable. `formation_lock` sets
  capacity = pixel count, and from then on it cannot be edited by hand
  (`CAPACITY_FROM_FORMATION`).
- Opening registration requires a capacity (`PRECONDITION_CAPACITY`). Formations are bounded
  by the plan's `max_participants_per_event`, no longer by a number typed in advance.

**Curved layout (`formation/curve.ts`).** One rigid rectangle on a bending beach is capped by the
bend, not by the width of the sand, so the letters stay small. Ticking *Follow the shape of the
area* cuts the message at its spaces and lays the segments along the area's centre line, each one
turned to the ground beneath it:

1. *Spine*: traced outwards from the deepest point of the area (chamfer distance transform),
   re-centring across the band at every step, so the line turns with the beach. Slicing along one
   global axis was tried first and fails on a crescent — near the tips a slice runs ALONG the sand.
2. *Layout*: for a candidate height every segment's width follows from its own aspect ratio; the
   blocks are walked along the spine by arc length and turned to their local chord.
3. *Fit*: the segment's ink samples must stay inside the area; bisection on the height, largest
   first, trying several positions along the curve.

All segments share one height on purpose: sized independently, a short word would come out twice as
tall as a long one. `renderTextSegmentMasks` therefore renders the words into a common vertical box
and crops them together. The win comes from the curve, not from resizing words.

The engine then works in world axes (`rotationDeg` 0) because each segment carries its own rotation,
and the constraint field tests every segment per cell. Two consequences: **stroke width is measured
in each segment's own frame** (on a rotated raster the staircase edges of the letters read as thin
strokes and would punish a curved layout for nothing), and **zones follow the reading order** rather
than a world axis, so a marshalling group never straddles two segments that face different ways.
Measured on a real crescent beach (event "lala", *FULL MOON FESTIVAL*): 2,450 → 3,726 people,
stroke 1.7 → 2.0 persons, readability 56 → 64. Nothing changes in the database (the design lands in
`formations.source` / `params`, both free-form JSON) or on the phone: a pixel is a pixel.

## 8. Synchronisation model

Clock: NTP-style exchange with the `time` Edge Function. 5 samples, keep the 3 with the lowest RTT,
median offset, uncertainty = min RTT / 2. Fallback: the HTTP `Date` header of the manifest (±1 s). The offset is persisted,
refreshed opportunistically with jitter, and **never** at T-0.

Participant local state machine (phone): `JOINED → CHECKED_IN (inside perimeter) → ARRIVED (≤ 25 m)
→ IN_POSITION (inside radius for 3 s with required accuracy) → READY (held 60 s or tapped) ⇄
LEFT_POSITION (outside radius × 1.25 for 8 s) → COMPLETED`. The hysteresis and accuracy-weighted
smoothing absorb GPS jitter so the state doesn't flicker.

Outbox: persisted, coalesces to the latest state, monotonic `seq`, min 5 s spacing, backoff with full
jitter, quiet window around T-0 (T-30 s → T+150 s, spread over 5 min). The server ignores `seq ≤ last_seq` (idempotent, replay-safe, multi-device safe).

## 8b. Briefing and pickup points (sponsored events)

Participants must know what to wear and what they get; sponsors hand out thousands of items
without a stampede.

- `events.briefing` (jsonb): dress code (text + colour swatches), what to bring, what to collect,
  the bounty after the photo. Returned by `get_event_preview` (shown **before** joining, so people
  arrive dressed correctly) and inside the assignment bundle. A change bumps `manifest_version`,
  so phones re-read it.
- Pickup points are event areas of kind `collection`, `control` or `bounty` (points, like access
  points) with `capacity`, `opens_at`, `closes_at` and `details` (what is handed out).
- **One collection point per participant.** `hp_assign_pickup` runs inside `join_event` and picks
  the least loaded point that still has room (ratio to capacity, random tie-break), so queues and
  stock split evenly. `rebalance_pickups` re-deals everybody round-robin when a point is added or
  removed and bumps `assignment_epoch` so phones learn their new point;
  `set_member_pickup` moves one person by hand.
- The phone shows the briefing and its own point (name, what to collect, opening hours, "Open in
  maps"). The console shows the load per point with a "Spread evenly" action.

## 9. Media

One master + derivatives (display 2560 px, share 1080 px, thumb 480 px), generated in the organizer
browser before upload (no plan-dependent image service required). Private bucket and signed URLs.
Released via `release_photo()`, which bumps the manifest; participants then fetch, and native share
uses the Web Share API Level 2 or the Capacitor Share plugin.

## 10. Failure recovery

| Failure | Behaviour |
|---|---|
| Network loss | Offline bundle (assignment, timing, areas, clock offset) + service worker. Outbox flushes later. |
| GPS loss / low accuracy | Explicit 🔴 GPS state; never falsely "in position"; last known target still shown. |
| Battery dies / app closed / device change | Assignment is tied to the account, not the device; re-login restores it. `seq` is server-authoritative. |
| No-show | `reclaim_no_shows()` releases points of members not checked in and reassigns them to checked-in waitlist members, lowest `fill_rank` first. |
| Cancellation | Point released and waitlist promoted in the same transaction. |
| Server/DB slow | Phones keep working offline; the dashboard shows 🟠/🔴 health; RPCs are idempotent and retried. |
| Photo upload fails | Resumable per file; `event_photos.status` tracks `uploading → ready`; release is a separate step. |
| Formation change after registration | A new version is locked and all active members are remapped set-based in one transaction. |

## 11. Privacy

GPS is processed on the device. The only location-derived data sent is a state and a GPS accuracy figure.
No coordinates and no history are stored. Consent is versioned per event. `delete_my_account` anonymises
membership rows (evidence counts stay valid) and deletes the auth user. `purge_expired_personal_data()`
(daily cron) anonymises members of events completed more than `retention_days` ago.

## 12. Deployment

- Environments: `local` (supabase start), `staging` and `production` (separate Supabase projects + Netlify sites).
- CI (GitHub Actions): typecheck, unit tests, build; `supabase db push` + functions deploy on tagged
  releases to staging, then production after manual approval.
- Backups: Supabase PITR (production), plus a nightly logical dump from the workflow to encrypted storage.
- Rollback: web = Netlify instant rollback to the previous deploy; DB = forward-only migrations, each
  with a documented compensating migration; functions = redeploy the previous tag.
- Secrets are only in the environment (`.env.local`, GitHub/Netlify/Supabase secrets). Never in source.

See `docs/DEPLOYMENT.md` and `docs/OPERATIONS.md`.

## 13. Measured results (2026-09-22, local Docker Postgres on a laptop)

| Scenario | Result |
|---|---|
| Formation engine, 12,000 pixels (browser worker) | 0.6 s |
| Formation engine, 50,000 pixels (Node) | ~2–3 s |
| Upload + PostGIS validation, 12,000 points | 2.0 s |
| Concurrent joins, 13,200 users on 12,000 positions (40 connections) | 0 duplicates, exact 1,200 waitlist, ~160 joins/s |
| Status reports (12k participants, full lifecycle) | 468 reports/s sustained; the crowd simulation's peak need is ~78/s |
| Reports per participant for a whole event (simulated GPS noise) | ~5.2 (vs ~1 per second with naive streaming) |
| Participants in position at T-0 / false positives (simulation) | 99% / 0 |
| Live dashboard aggregation at 12,000 participants | ~105 ms per 5 s poll |
| Scheduler LIVE bookkeeping after T-0 | +3.6 s (phones switch locally at T-0) |

Scaling notes for 50k+: join throughput is bounded by the per-event counters row (short lock,
~ms): registration is spread over days in practice; for flash registrations of 50k+ move
participant numbering to a sequence. All other paths are set-based or O(1) per participant.
