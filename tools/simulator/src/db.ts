/**
 * Direct-Postgres harness. Impersonates Supabase users exactly as PostgREST does
 * (role `authenticated` + `request.jwt.claims`), so RLS and SECURITY DEFINER checks run for real.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  LocalFrame,
  generateFormation,
  pointsChecksum,
  renderBitmapText,
  toPointRows,
  chunk,
  type LatLng,
  type FormationResult,
} from '@human-pixel/core';

export const DB_URL = process.env.HP_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55422/postgres';

export function createPool(max = 20): pg.Pool {
  return new pg.Pool({ connectionString: DB_URL, max });
}

export interface Actor {
  id: string;
  email: string;
  isAnonymous?: boolean;
}

/** Runs `fn` in a transaction as the given user (or as anon when actor is null). */
export async function asUser<T>(pool: pg.Pool, actor: Actor | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${actor ? 'authenticated' : 'anon'}`);
    const claims = actor
      ? { sub: actor.id, role: 'authenticated', email: actor.email, is_anonymous: actor.isAnonymous ?? false }
      : { role: 'anon' };
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Calls an RPC as a user and returns the single scalar/json result. */
export async function rpc<T = unknown>(pool: pg.Pool, actor: Actor | null, fn: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  return asUser(pool, actor, async (c) => {
    // `select * from fn()` expands composite results (e.g. an `events` row) into columns, like PostgREST.
    const r = await c.query(`select * from public.${fn}(${placeholders})`, args);
    const row = r.rows[0];
    if (!row) return undefined as T;
    const cols = Object.keys(row);
    return (cols.length === 1 && cols[0] === fn ? row[fn] : row) as T;
  });
}

export async function createUsers(pool: pg.Pool, n: number, prefix: string): Promise<Actor[]> {
  const users: Actor[] = Array.from({ length: n }, (_, i) => ({ id: randomUUID(), email: `${prefix}-${i}-${Date.now()}@test.humanpixel.local` }));
  for (const part of chunk(users, 5000)) {
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
       select (u->>'id')::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u->>'email', '', now(), now(), now(),
              '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb
       from jsonb_array_elements($1::jsonb) u`,
      [JSON.stringify(part)],
    );
    await pool.query(
      `update public.profiles p set first_name = 'Pixel', birth_year = 1995, sex = 'undisclosed', nationality = 'TH'
       from jsonb_array_elements($1::jsonb) u where p.id = (u->>'id')::uuid`,
      [JSON.stringify(part)],
    );
  }
  return users;
}

export const ANCHOR: LatLng = { lat: 9.6664, lng: 100.0402 }; // Haad Rin beach area, Koh Phangan

export function squareWkt(center: LatLng, halfSizeM: number): string {
  const f = new LocalFrame(center);
  const c = [
    f.toLatLng({ x: -halfSizeM, y: -halfSizeM }),
    f.toLatLng({ x: halfSizeM, y: -halfSizeM }),
    f.toLatLng({ x: halfSizeM, y: halfSizeM }),
    f.toLatLng({ x: -halfSizeM, y: halfSizeM }),
  ];
  const ring = [...c, c[0]!].map((p) => `${p.lng} ${p.lat}`).join(', ');
  return `SRID=4326;POLYGON((${ring}))`;
}

export interface Scenario {
  organizer: Actor;
  orgId: string;
  eventId: string;
  joinCode: string;
  formationId: string;
  formation: FormationResult;
}

/**
 * Builds a complete event: organization (enterprise plan), event, perimeter, exclusion,
 * formation generated with the real engine, uploaded in chunks, validated and locked.
 */
export async function buildScenario(pool: pg.Pool, n: number, opts: { text?: string; lock?: boolean } = {}): Promise<Scenario> {
  const [organizer] = await createUsers(pool, 1, 'organizer');
  const org = await rpc<{ id: string }>(pool, organizer!, 'create_organization', ['Test Org ' + n]);
  // Platform admin grants capacity (as postgres, i.e. an operator action).
  await pool.query(
    `update public.organization_subscriptions set plan = 'enterprise', max_participants_per_event = 250000, max_active_events = 100 where org_id = $1`,
    [org.id],
  );
  const startsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const event = await rpc<{ id: string; join_code: string }>(pool, organizer!, 'create_event', [
    org.id, `Load test ${n}`, startsAt, 'Asia/Bangkok', n, 'Haad Rin', ANCHOR.lat, ANCHOR.lng,
  ]);
  const half = Math.max(200, Math.sqrt(n) * 4);
  await asUser(pool, organizer!, (c) =>
    c.query(`insert into public.event_areas (event_id, kind, name, geom) values ($1, 'perimeter', 'Beach', $2::extensions.geometry)`, [
      event.id,
      squareWkt(ANCHOR, half),
    ]),
  );
  const mask = renderBitmapText(opts.text ?? 'LOVE\nPHANGAN', 10);
  const formation = generateFormation({ mask, anchor: ANCHOR, widthM: Math.sqrt(n) * 3.2, targetCount: n, seed: 4242, lloydIterations: n > 20_000 ? 3 : 6 });
  const formationId = await rpc<string>(pool, organizer!, 'formation_create', [
    event.id,
    JSON.stringify({ kind: 'text', text: opts.text ?? 'LOVE PHANGAN', fontFamily: 'bitmap', fontWeight: 800, letterSpacingEm: 0, lineHeightEm: 1 }),
    JSON.stringify({ targetCount: n, widthM: formation.widthM, rotationDeg: 0, minSpacingM: 0.9, anchor: ANCHOR, seed: 4242, zoneSize: 1500 }),
    n,
    4242,
    'test',
    JSON.stringify(formation.metrics),
    JSON.stringify(formation.warnings),
    JSON.stringify(formation.zones.map((z) => ({ zone: z.zone, label: z.label, count: z.count, lat: z.centroid.lat, lng: z.centroid.lng }))),
  ]);
  const rows = toPointRows(formation.points);
  await Promise.all(chunk(rows, 5000).map((part) => rpc(pool, organizer!, 'formation_upload_points', [formationId, JSON.stringify(part)])));
  const report = await rpc<{ ok: boolean }>(pool, organizer!, 'formation_finalize', [formationId, pointsChecksum(formation.points)]);
  if (!report.ok) throw new Error('Formation validation failed: ' + JSON.stringify(report));
  if (opts.lock !== false) await rpc(pool, organizer!, 'formation_lock', [formationId]);
  await rpc(pool, organizer!, 'transition_event', [event.id, 'REGISTRATION_OPEN', 'test']);
  return { organizer: organizer!, orgId: org.id, eventId: event.id, joinCode: event.join_code, formationId, formation };
}

/** Runs async tasks with bounded concurrency. */
export async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

export const CONSENT = '2026-09-v1';
