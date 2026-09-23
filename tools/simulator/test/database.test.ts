/**
 * Database integration tests against a real Supabase Postgres (supabase start).
 * Every call goes through RLS as the impersonated user: this is what a malicious client sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { CONSENT, asUser, buildScenario, createPool, createUsers, rpc, runPool, squareWkt, ANCHOR, type Actor, type Scenario } from '../src/db';

let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(40);
});
afterAll(async () => {
  await pool.end();
});

async function expectError(p: Promise<unknown>, pattern: RegExp) {
  await expect(p).rejects.toThrow(pattern);
}

describe('security: the formation stays secret', () => {
  let s: Scenario;
  let alice: Actor;
  let bob: Actor;
  beforeAll(async () => {
    s = await buildScenario(pool, 1_000);
    const users = await createUsers(pool, 2, 'sec');
    alice = users[0]!;
    bob = users[1]!;
    await rpc(pool, alice!, 'join_event', [s.joinCode, CONSENT]);
    await rpc(pool, bob!, 'join_event', [s.joinCode, CONSENT]);
  });

  it('participants read ZERO rows of formations, points, zones, logs and other members', async () => {
    await asUser(pool, alice, async (c) => {
      for (const table of ['formations', 'formation_assets', 'events', 'event_areas', 'event_state_history', 'event_stat_snapshots']) {
        const r = await c.query(`select count(*)::int n from public.${table}`);
        expect(r.rows[0].n, table).toBe(0);
      }
    });
    // The formation's geometry is not even addressable by clients (no table privilege at all).
    for (const table of ['formation_points', 'formation_zones', 'assignment_log']) {
      await expectError(asUser(pool, alice, (c) => c.query(`select count(*) from public.${table}`)), /permission denied/);
    }
    await asUser(pool, alice, async (c) => {
      const members = await c.query('select user_id from public.event_members');
      expect(members.rows.map((r) => r.user_id)).toEqual([alice.id]);
      const statuses = await c.query('select count(*)::int n from public.participant_status');
      expect(statuses.rows[0].n).toBe(1);
    });
  });

  it('participants cannot call organizer RPCs', async () => {
    await expectError(rpc(pool, alice, 'get_formation_points', [s.formationId]), /FORBIDDEN/);
    await expectError(rpc(pool, alice, 'get_formation_live', [s.formationId]), /FORBIDDEN/);
    await expectError(rpc(pool, alice, 'get_event_live_stats', [s.eventId]), /FORBIDDEN/);
    await expectError(rpc(pool, alice, 'get_event_evidence', [s.eventId]), /FORBIDDEN/);
    await expectError(rpc(pool, alice, 'transition_event', [s.eventId, 'CANCELLED', 'hack']), /FORBIDDEN/);
    await expectError(rpc(pool, alice, 'admin_system_health', []), /FORBIDDEN/);
  });

  it('internal helpers are not executable by clients', async () => {
    await expectError(rpc(pool, alice, 'hp_assign_member', [alice.id, 'assign', 'x']), /permission denied/);
    await expectError(rpc(pool, alice, 'hp_transition_event', [s.eventId, 'CANCELLED', alice.id, 'x', true]), /permission denied/);
    await expectError(rpc(pool, alice, 'hp_anonymize_user', [bob.id]), /permission denied/);
  });

  it('a participant sees only their own pixel, and coordinates only after release', async () => {
    const before = await rpc<any>(pool, alice, 'get_my_assignment', [s.eventId]);
    expect(before.pixel.label).toBeGreaterThan(0);
    expect(before.pixel.zone).toMatch(/^[A-Z]+$/);
    expect(before.pixel.released).toBe(false);
    expect(before.pixel.target).toBeNull();
    expect(JSON.stringify(before)).not.toMatch(/LOVE|PHANGAN/);
    await asUser(pool, s.organizer, (c) => c.query(`update public.events set positions_release_at = now() - interval '1 minute' where id = $1`, [s.eventId]));
    const after = await rpc<any>(pool, alice, 'get_my_assignment', [s.eventId]);
    expect(after.pixel.released).toBe(true);
    expect(after.pixel.target.lat).toBeCloseTo(ANCHOR.lat, 1);
    const bobs = await rpc<any>(pool, bob, 'get_my_assignment', [s.eventId]);
    expect(bobs.pixel.target).not.toEqual(after.pixel.target);
  });

  it('the public manifest and preview contain nothing secret', async () => {
    const m = await rpc<any>(pool, null, 'get_event_manifest', [s.eventId]);
    const p = await rpc<any>(pool, null, 'get_event_preview', [s.joinCode]);
    const text = JSON.stringify([m, p]);
    expect(text).not.toMatch(/LOVE|PHANGAN|formation|lat|lng/i);
    expect(m.state).toBe('REGISTRATION_OPEN');
    expect(p.registrationOpen).toBe(true);
  });

  it('organizers cannot write protected columns directly', async () => {
    await expectError(asUser(pool, s.organizer, (c) => c.query(`update public.events set state = 'LIVE' where id = $1`, [s.eventId])), /permission denied/);
    await expectError(asUser(pool, s.organizer, (c) => c.query(`update public.events set active_formation_id = null where id = $1`, [s.eventId])), /permission denied/);
    await expectError(asUser(pool, s.organizer, (c) => c.query(`update public.formation_points set member_id = null`)), /permission denied/);
    await expectError(asUser(pool, alice, (c) => c.query(`update public.profiles set platform_role = 'admin' where id = $1`, [alice.id])), /permission denied/);
  });

  it('another organization cannot see this event', async () => {
    const [other] = await createUsers(pool, 1, 'other-org');
    await rpc(pool, other!, 'create_organization', ['Rival Org']);
    await asUser(pool, other!, async (c) => {
      expect((await c.query('select count(*)::int n from public.events where id = $1', [s.eventId])).rows[0].n).toBe(0);
    });
    await expectError(rpc(pool, other!, 'get_formation_points', [s.formationId]), /FORBIDDEN/);
  });

  it('suspended organizers lose access; admins cannot demote owners', async () => {
    await pool.query(`update public.profiles set is_suspended = true where id = $1`, [s.organizer.id]).catch(async () => {
      await pool.query(`begin; select set_config('hp.internal','on',true); update public.profiles set is_suspended = true where id = '${s.organizer.id}'; commit;`);
    });
    await asUser(pool, s.organizer, async (c) => {
      expect((await c.query('select count(*)::int n from public.events where id = $1', [s.eventId])).rows[0].n).toBe(0);
    });
    await pool.query(`begin; select set_config('hp.internal','on',true); update public.profiles set is_suspended = false where id = '${s.organizer.id}'; commit;`);
    const [admin] = await createUsers(pool, 1, 'org-admin');
    await pool.query(`insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'admin')`, [s.orgId, admin!.id]);
    await expectError(rpc(pool, admin!, 'add_organization_member', [s.orgId, s.organizer.email, 'member']), /FORBIDDEN/);
    await expectError(rpc(pool, admin!, 'remove_organization_member', [s.orgId, s.organizer.id]), /FORBIDDEN/);
  });

  it('constraint areas are frozen once a formation is locked', async () => {
    await expectError(
      asUser(pool, s.organizer, (c) =>
        c.query(`insert into public.event_areas (event_id, kind, name, geom, safety_buffer_m) values ($1, 'exclusion', 'Rock', $2::extensions.geometry, 2)`, [s.eventId, squareWkt(ANCHOR, 5)]),
      ),
      /FORMATION_LOCKED/,
    );
  });
});

describe('imported fonts', () => {
  // A font the organizer brings is stored like a design image so a saved design stays reproducible.
  it('accepts font files, and lets the organizer drop a font but never a design image', async () => {
    const s = await buildScenario(pool, 200, { lock: false });
    const insert = (name: string, mime: string, path: string) =>
      asUser(pool, s.organizer, (c) =>
        c.query(
          `insert into public.formation_assets (event_id, storage_path, file_name, mime_type, bytes, created_by)
           values ($1, $2, $3, $4, 1024, $5) returning id`,
          [s.eventId, path, name, mime, s.organizer.id],
        ),
      );

    const font = await insert('Brand-Bold.woff2', 'font/woff2', `${s.eventId}/font.woff2`);
    const image = await insert('logo.png', 'image/png', `${s.eventId}/logo.png`);
    expect(font.rowCount).toBe(1);

    // Anything that is neither an image nor a font is refused by the check constraint.
    await expectError(insert('payload.exe', 'application/octet-stream', `${s.eventId}/x.exe`), /formation_assets_mime_type_check/);

    // The font can go; the image cannot, because every formation version built from it refers to it.
    const dropFont = await asUser(pool, s.organizer, (c) => c.query(`delete from public.formation_assets where id = $1`, [font.rows[0].id]));
    expect(dropFont.rowCount).toBe(1);
    const dropImage = await asUser(pool, s.organizer, (c) => c.query(`delete from public.formation_assets where id = $1`, [image.rows[0].id]));
    expect(dropImage.rowCount).toBe(0);
  });
});

describe('formation validation is enforced by the database', () => {
  it('rejects points inside an exclusion zone even if the client claims they are fine', async () => {
    const s = await buildScenario(pool, 500, { lock: false }).catch((e) => {
      throw e;
    });
    // Add an exclusion right in the middle (allowed: formation not locked yet), then re-upload the SAME points.
    await asUser(pool, s.organizer, (c) =>
      c.query(`insert into public.event_areas (event_id, kind, name, geom, safety_buffer_m) values ($1, 'exclusion', 'Rock', $2::extensions.geometry, 1)`, [s.eventId, squareWkt(ANCHOR, 30)]),
    );
    const { toPointRows, pointsChecksum, chunk } = await import('@human-pixel/core');
    const fid = await rpc<string>(pool, s.organizer, 'formation_create', [
      s.eventId, JSON.stringify({ kind: 'text' }), JSON.stringify({ minSpacingM: 0.9 }), 500, 1, 'test', '{}', '[]',
      JSON.stringify(s.formation.zones.map((z) => ({ zone: z.zone, label: z.label, count: z.count, lat: z.centroid.lat, lng: z.centroid.lng }))),
    ]);
    for (const part of chunk(toPointRows(s.formation.points), 5000)) await rpc(pool, s.organizer, 'formation_upload_points', [fid, JSON.stringify(part)]);
    const report = await rpc<any>(pool, s.organizer, 'formation_finalize', [fid, pointsChecksum(s.formation.points)]);
    expect(report.ok).toBe(false);
    expect(report.inside_exclusions).toBeGreaterThan(0);
    await expectError(rpc(pool, s.organizer, 'formation_lock', [fid]), /FORMATION_NOT_READY/);
  });

  it('rejects a tampered checksum', async () => {
    const s = await buildScenario(pool, 300, { lock: false });
    const { toPointRows, chunk } = await import('@human-pixel/core');
    const fid = await rpc<string>(pool, s.organizer, 'formation_create', [
      s.eventId, JSON.stringify({ kind: 'text' }), JSON.stringify({ minSpacingM: 0.9 }), 300, 1, 'test', '{}', '[]',
      JSON.stringify(s.formation.zones.map((z) => ({ zone: z.zone, label: z.label, count: z.count, lat: z.centroid.lat, lng: z.centroid.lng }))),
    ]);
    for (const part of chunk(toPointRows(s.formation.points), 5000)) await rpc(pool, s.organizer, 'formation_upload_points', [fid, JSON.stringify(part)]);
    const report = await rpc<any>(pool, s.organizer, 'formation_finalize', [fid, 12345]);
    expect(report.ok).toBe(false);
    expect(report.checksum_ok).toBe(false);
  });
});

describe('hand-drawn areas', () => {
  it('repairs small self-crossings (double-click spike, lasso overshoot) and refuses real figure-eights', async () => {
    const s = await buildScenario(pool, 50, { lock: false, open: false });
    const save = (coords: number[][]) =>
      rpc<string>(pool, s.organizer, 'save_event_area', [s.eventId, 'assembly', JSON.stringify({ type: 'Polygon', coordinates: [coords] }), null, 0, null, null]);
    // Lasso overshooting its start: crosses itself near the first corner.
    const id = await save([[100, 9], [100.001, 9], [100.001, 9.001], [100, 9.001], [100.0001, 8.9999], [100, 9]]);
    const g = await pool.query(`select extensions.st_isvalid(geom) ok, extensions.geometrytype(geom) t from public.event_areas where id = $1`, [id]);
    expect(g.rows[0]).toEqual({ ok: true, t: 'POLYGON' });
    // A figure-eight with two equal lobes is ambiguous: refused.
    await expectError(save([[100, 9], [100.001, 9.001], [100.001, 9], [100, 9.001], [100, 9]]), /crosses itself/);
  });
});

describe('briefing & pickup points', () => {
  it('spreads participants over the collection points, respects capacity, and rebalances', async () => {
    const s = await buildScenario(pool, 100, { lock: false });
    const point = (lng: number, cap: number | null, name: string) =>
      rpc<string>(pool, s.organizer, 'save_event_area', [
        s.eventId, 'collection', JSON.stringify({ type: 'Point', coordinates: [ANCHOR.lng + lng, ANCHOR.lat] }),
        name, 0, true, null, null, cap, null, null, 'One t-shirt per person',
      ]);
    const a = await point(0.001, 10, 'Tent A');
    const b = await point(0.002, 10, 'Tent B');
    await asUser(pool, s.organizer, (c) => c.query(`update public.events set briefing = $2 where id = $1`, [
      s.eventId,
      JSON.stringify({ dressCode: { text: 'Plain white t-shirt', colors: ['#ffffff'] }, collect: 'Sponsor t-shirt', bounty: 'Free drink after the photo' }),
    ]));

    const users = await createUsers(pool, 20, 'pickup');
    await runPool(users, 10, (u) => rpc(pool, u, 'join_event', [s.joinCode, CONSENT]));
    const counts = async () =>
      (await pool.query<{ id: string; n: number }>(
        `select a.id, count(m.id)::int n from public.event_areas a
           left join public.event_members m on m.pickup_area_id = a.id
          where a.event_id = $1 and a.kind = 'collection' group by a.id order by a.id`, [s.eventId])).rows;
    const spread = await counts();
    expect(spread.map((r) => r.n).reduce((x, y) => x + y, 0)).toBe(20);
    expect(Math.abs(spread[0]!.n - spread[1]!.n)).toBeLessThanOrEqual(4); // both tents used, roughly evenly
    expect(spread.every((r) => r.n <= 10)).toBe(true); // capacity never exceeded

    // The participant is told where to go, and the briefing travels with it.
    const mine = await rpc<any>(pool, users[0]!, 'get_my_assignment', [s.eventId]);
    expect([a, b]).toContain(mine.pickup.id);
    expect(mine.pickup.details).toBe('One t-shirt per person');
    expect(mine.event.briefing.dressCode.text).toBe('Plain white t-shirt');
    const preview = await rpc<any>(pool, users[0]!, 'get_event_preview', [s.joinCode]);
    expect(preview.briefing.bounty).toBe('Free drink after the photo');

    // A third tent opens the day before: everybody is spread again.
    const c = await point(0.003, null, 'Tent C');
    const r = await rpc<any>(pool, s.organizer, 'rebalance_pickups', [s.eventId]);
    expect(r.points).toBe(3);
    const after = await counts();
    expect(after.length).toBe(3);
    expect(Math.max(...after.map((x) => x.n)) - Math.min(...after.map((x) => x.n))).toBeLessThanOrEqual(1);
    expect(after.some((x) => x.id === c)).toBe(true);

    // An organizer can move one person by hand.
    const m0 = (await pool.query(`select id from public.event_members where event_id = $1 order by participant_number limit 1`, [s.eventId])).rows[0].id;
    await rpc(pool, s.organizer, 'set_member_pickup', [m0, c]);
    const moved = await pool.query(`select pickup_area_id from public.event_members where id = $1`, [m0]);
    expect(moved.rows[0].pickup_area_id).toBe(c);
  });
});

describe('assignment integrity under concurrency', () => {
  for (const n of [1_000, 5_000, 12_000]) {
    it(`${n.toLocaleString()} simultaneous joins (+10% over capacity): no duplicates, exact waitlist`, async () => {
      const s = await buildScenario(pool, n);
      const extra = Math.round(n * 0.1);
      const users = await createUsers(pool, n + extra, `join${n}`);
      const t0 = performance.now();
      await runPool(users, 40, (u) => rpc(pool, u, 'join_event', [s.joinCode, CONSENT, null, 'dev-' + u.id.slice(0, 8)]));
      const ms = performance.now() - t0;
      const dup = await pool.query(
        `select count(*)::int n from (select member_id from public.formation_points where member_id is not null group by member_id having count(*) > 1) d`,
      );
      expect(dup.rows[0].n).toBe(0);
      const counts = await pool.query(
        `select
           (select count(*)::int from public.formation_points where formation_id = $1 and member_id is not null) assigned,
           (select count(*)::int from public.event_members where event_id = $2 and status = 'registered') registered,
           (select count(*)::int from public.event_members where event_id = $2 and status = 'waitlisted') waitlisted,
           (select registered from public.event_counters where event_id = $2) counter,
           (select count(distinct participant_number)::int from public.event_members where event_id = $2) numbers`,
        [s.formationId, s.eventId],
      );
      const c = counts.rows[0];
      expect(c.assigned).toBe(n);
      expect(c.registered).toBe(n);
      expect(c.counter).toBe(n);
      expect(c.waitlisted).toBe(extra);
      expect(c.numbers).toBe(n + extra);
      // Progressive allocation: the first half of joiners got the first half of fill ranks.
      const ranks = await pool.query(`select max(fill_rank)::int m from public.formation_points where formation_id = $1 and member_id is not null`, [s.formationId]);
      expect(ranks.rows[0].m).toBe(n - 1);
      console.info(`[db ${n}] ${n + extra} joins in ${(ms / 1000).toFixed(1)} s → ${Math.round(((n + extra) / ms) * 1000)} joins/s`);
    });
  }

  it('re-joining is idempotent and double-taps converge to one membership', async () => {
    const s = await buildScenario(pool, 200);
    const [u] = await createUsers(pool, 1, 'double');
    const results = await Promise.all(Array.from({ length: 5 }, () => rpc<any>(pool, u!, 'join_event', [s.joinCode, CONSENT])));
    expect(new Set(results.map((r) => r.member.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.pixel?.label)).size).toBe(1);
  });
});

describe('status reports: idempotent, replay-safe, multi-device', () => {
  it('ignores stale sequence numbers and accepts device switches by client time', async () => {
    const s = await buildScenario(pool, 100);
    const [u] = await createUsers(pool, 1, 'status');
    await rpc(pool, u!, 'join_event', [s.joinCode, CONSENT, null, 'phone-A']);
    const t = Date.now();
    const report = (state: string, seq: number, device: string, at: number) =>
      rpc<any>(pool, u!, 'report_status', [s.eventId, state, seq, new Date(at).toISOString(), 4.2, 30, device, '1.0.0']);
    expect((await report('CHECKED_IN', 1, 'phone-A', t)).accepted).toBe(true);
    await pool.query(`update public.participant_status set reported_at = now() - interval '10 s'`);
    expect((await report('ARRIVED', 1, 'phone-A', t + 1)).reason).toBe('STALE');
    await pool.query(`update public.participant_status set reported_at = now() - interval '10 s'`);
    expect((await report('IN_POSITION', 2, 'phone-A', t + 2)).accepted).toBe(true);
    // Rate limit: immediate second report is deferred.
    expect((await report('READY', 3, 'phone-A', t + 3)).reason).toBe('RATE_LIMITED');
    await pool.query(`update public.participant_status set reported_at = now() - interval '10 s'`);
    // New phone (battery died): its seq restarts at 1 but its client time is newer.
    expect((await report('READY', 1, 'phone-B', t + 60_000)).accepted).toBe(true);
    await pool.query(`update public.participant_status set reported_at = now() - interval '10 s'`);
    // Old phone comes back online with an older report: ignored.
    expect((await report('LEFT_POSITION', 3, 'phone-A', t + 30_000)).reason).toBe('STALE');
    const st = await pool.query(`select state, first_in_position_at is not null fip, ready_at is not null r from public.participant_status ps join public.event_members m on m.id = ps.member_id where m.user_id = $1`, [u!.id]);
    expect(st.rows[0]).toEqual({ state: 'READY', fip: true, r: true });
  });
});

describe('recovery: cancellation, waitlist, no-shows, formation change', () => {
  it('a cancelled position goes to the next person on the waitlist in the same transaction', async () => {
    const s = await buildScenario(pool, 50);
    const users = await createUsers(pool, 52, 'wait');
    for (const u of users) await rpc(pool, u, 'join_event', [s.joinCode, CONSENT]);
    const w1 = await rpc<any>(pool, users[50]!, 'get_my_assignment', [s.eventId]);
    expect(w1.member.status).toBe('waitlisted');
    expect(w1.pixel).toBeNull();
    await rpc(pool, users[3]!, 'cancel_my_participation', [s.eventId]);
    const w1b = await rpc<any>(pool, users[50]!, 'get_my_assignment', [s.eventId]);
    expect(w1b.member.status).toBe('registered');
    expect(w1b.pixel.label).toBeGreaterThan(0);
    const log = await pool.query(`select action, reason from public.assignment_log where event_id = $1 and reason in ('participant_cancelled', 'waitlist_promotion')`, [s.eventId]);
    expect(log.rows.map((r) => r.reason).sort()).toEqual(['participant_cancelled', 'waitlist_promotion']);
  });

  it('reclaims no-show points for checked-in standby participants, most important points first', async () => {
    const s = await buildScenario(pool, 100);
    const users = await createUsers(pool, 110, 'noshow');
    for (const u of users) await rpc(pool, u, 'join_event', [s.joinCode, CONSENT]);
    // 90 registered people check in; 10 do not. 10 waitlisted people are on site (standby).
    await pool.query(`update public.participant_status set state = 'CHECKED_IN' where event_id = $1`, [s.eventId]);
    const noShows = users.slice(0, 10).map((u) => u.id);
    await pool.query(
      `update public.participant_status ps set state = 'JOINED' from public.event_members m where m.id = ps.member_id and m.user_id = any($1::uuid[])`,
      [noShows],
    );
    for (const st of ['EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION']) await rpc(pool, s.organizer, 'transition_event', [s.eventId, st, 'test']);
    const r = await rpc<any>(pool, s.organizer, 'reclaim_no_shows', [s.eventId, 100000]);
    expect(r).toMatchObject({ standby: 10, released: 10, assigned: 10 });
    const standby = await rpc<any>(pool, users[105]!, 'get_my_assignment', [s.eventId]);
    expect(standby.member.status).toBe('registered');
    expect(standby.pixel.released).toBe(true);
    const noShow = await rpc<any>(pool, users[0]!, 'get_my_assignment', [s.eventId]);
    expect(noShow.member.status).toBe('waitlisted');
  });

  it('locking a new formation version remaps every member set-based with no duplicates', async () => {
    const s = await buildScenario(pool, 400);
    const users = await createUsers(pool, 300, 'remap');
    await runPool(users, 20, (u) => rpc(pool, u, 'join_event', [s.joinCode, CONSENT]));
    const { toPointRows, pointsChecksum, chunk, generateFormation, renderBitmapText } = await import('@human-pixel/core');
    const f2 = generateFormation({ mask: renderBitmapText('PEACE', 10), anchor: ANCHOR, widthM: 70, targetCount: 350, seed: 9 });
    const fid = await rpc<string>(pool, s.organizer, 'formation_create', [
      s.eventId, JSON.stringify({ kind: 'text', text: 'PEACE' }), JSON.stringify({ minSpacingM: 0.9 }), 350, 9, 'test', '{}', '[]',
      JSON.stringify(f2.zones.map((z) => ({ zone: z.zone, label: z.label, count: z.count, lat: z.centroid.lat, lng: z.centroid.lng }))),
    ]);
    for (const part of chunk(toPointRows(f2.points), 5000)) await rpc(pool, s.organizer, 'formation_upload_points', [fid, JSON.stringify(part)]);
    expect((await rpc<any>(pool, s.organizer, 'formation_finalize', [fid, pointsChecksum(f2.points)])).ok).toBe(true);
    const res = await rpc<any>(pool, s.organizer, 'formation_lock', [fid]);
    expect(res).toMatchObject({ released: 300, assigned: 300, waitlisted: 0 });
    const q = await pool.query(
      `select count(*)::int n, count(distinct member_id)::int d from public.formation_points where formation_id = $1 and member_id is not null`,
      [fid],
    );
    expect(q.rows[0]).toEqual({ n: 300, d: 300 });
    const old = await pool.query(`select count(*)::int n from public.formation_points where formation_id = $1 and member_id is not null`, [s.formationId]);
    expect(old.rows[0].n).toBe(0);
  });
});

describe('event state machine (database)', () => {
  it('enforces legality, preconditions, audit and history', async () => {
    const [o] = await createUsers(pool, 1, 'sm');
    const org = await rpc<any>(pool, o!, 'create_organization', ['SM Org']);
    const e = await rpc<any>(pool, o!, 'create_event', [org.id, 'SM Event', new Date(Date.now() + 86400_000).toISOString(), 'UTC', 100, null, null, null]);
    await expectError(rpc(pool, o!, 'transition_event', [e.id, 'LIVE', null]), /ILLEGAL_TRANSITION/);
    await expectError(rpc(pool, o!, 'transition_event', [e.id, 'REGISTRATION_OPEN', null]), /PRECONDITION_PERIMETER/);
    await asUser(pool, o!, (c) => c.query(`insert into public.event_areas (event_id, kind, geom) values ($1, 'perimeter', $2::extensions.geometry)`, [e.id, squareWkt(ANCHOR, 100)]));
    await rpc(pool, o!, 'transition_event', [e.id, 'REGISTRATION_OPEN', null]);
    await expectError(rpc(pool, o!, 'transition_event', [e.id, 'EVENT_PREPARATION', null]), /PRECONDITION_FORMATION/);
    await rpc(pool, o!, 'transition_event', [e.id, 'CANCELLED', 'weather']);
    await expectError(rpc(pool, o!, 'transition_event', [e.id, 'REGISTRATION_OPEN', null]), /ILLEGAL_TRANSITION/);
    const h = await pool.query(`select from_state, to_state from public.event_state_history where event_id = $1 order by id`, [e.id]);
    expect(h.rows.map((r) => `${r.from_state ?? '∅'}>${r.to_state}`)).toEqual(['∅>DRAFT', 'DRAFT>REGISTRATION_OPEN', 'REGISTRATION_OPEN>CANCELLED']);
    const a = await pool.query(`select count(*)::int n from public.audit_logs where event_id = $1 and action = 'event.transition'`, [e.id]);
    expect(a.rows[0].n).toBe(2);
  });

  it('capacity is an output of the formation: required to open, set by lock, then frozen', async () => {
    const s = await buildScenario(pool, 150, { lock: false, open: false });
    const setCap = (v: number | null) =>
      asUser(pool, s.organizer, (c) => c.query(`update public.events set capacity = $2 where id = $1`, [s.eventId, v]));
    const cap = async () => (await pool.query(`select capacity from public.events where id = $1`, [s.eventId])).rows[0].capacity;
    await setCap(null); // DRAFT: "to be decided by the design"
    await expectError(rpc(pool, s.organizer, 'transition_event', [s.eventId, 'REGISTRATION_OPEN', null]), /PRECONDITION_CAPACITY/);
    expect(await rpc(pool, s.organizer, 'set_capacity_from_formation', [s.formationId])).toBe(150);
    expect(await cap()).toBe(150);
    await setCap(60); // a manual target is allowed until a formation is locked
    await rpc(pool, s.organizer, 'transition_event', [s.eventId, 'REGISTRATION_OPEN', null]);
    await expectError(setCap(null), /CAPACITY_REQUIRED/);
    const lock = await rpc<any>(pool, s.organizer, 'formation_lock', [s.formationId]);
    expect(lock.capacity).toBe(150);
    expect(await cap()).toBe(150);
    await expectError(setCap(10), /CAPACITY_FROM_FORMATION/);
  });

  it('the scheduler moves READY events to LIVE at start time and snapshots attendance', async () => {
    const s = await buildScenario(pool, 100);
    for (const st of ['EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY']) await rpc(pool, s.organizer, 'transition_event', [s.eventId, st, 'test']);
    // Operator back-door (as postgres, flagged internal) to fast-forward time for the test.
    await pool.query(
      `begin; select set_config('hp.internal', 'on', true); update public.events set starts_at = now() - interval '1 second' where id = '${s.eventId}'; commit;`,
    );
    await pool.query(`select public.hp_scheduler_tick()`);
    const e = await pool.query(`select state, live_at is not null live from public.events where id = $1`, [s.eventId]);
    expect(e.rows[0]).toEqual({ state: 'LIVE', live: true });
    const snap = await pool.query(`select count(*)::int n from public.event_stat_snapshots where event_id = $1 and state = 'LIVE'`, [s.eventId]);
    expect(snap.rows[0].n).toBe(1);
  });
});

describe('dashboard & evidence', () => {
  it('live stats aggregate correctly and report health', async () => {
    const s = await buildScenario(pool, 300);
    const users = await createUsers(pool, 300, 'stats');
    await runPool(users, 20, (u) => rpc(pool, u, 'join_event', [s.joinCode, CONSENT]));
    await pool.query(
      `update public.participant_status set state = (array['CHECKED_IN','ARRIVED','IN_POSITION','READY']::public.participant_state[])[1 + (random() * 3)::int],
         accuracy_m = 3 + random() * 5, reported_at = now()
       where event_id = $1`,
      [s.eventId],
    );
    const stats = await rpc<any>(pool, s.organizer, 'get_event_live_stats', [s.eventId]);
    expect(stats.counts.registered).toBe(300);
    expect(stats.counts.checked_in).toBe(300);
    expect(stats.counts.in_position).toBeGreaterThanOrEqual(stats.counts.ready);
    expect(stats.zones.reduce((a: number, z: any) => a + z.assigned, 0)).toBe(300);
    expect(['NORMAL', 'HIGH_LOAD', 'CRITICAL']).toContain(stats.health.level);
    const live = await rpc<string>(pool, s.organizer, 'get_formation_live', [s.formationId]);
    expect(live).toHaveLength(300);
    expect(live).toMatch(/^[2-5]+$/);
    const ev = await rpc<any>(pool, s.organizer, 'get_event_evidence', [s.eventId]);
    expect(ev.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.formation.points).toBe(300);
  });
});

describe('sponsor report', () => {
  // What the brand receives. Every figure must be one the database witnessed: the test drives a
  // known crowd and then checks the report says exactly that, no more.
  it('reports the peak attendance, the split per collection point, and invents nothing', async () => {
    const s = await buildScenario(pool, 60, { lock: false });
    const point = (lng: number, name: string) =>
      rpc<string>(pool, s.organizer, 'save_event_area', [
        s.eventId, 'collection', JSON.stringify({ type: 'Point', coordinates: [ANCHOR.lng + lng, ANCHOR.lat] }),
        name, 0, true, null, null, null, null, null, 'One t-shirt per person',
      ]);
    await point(0.001, 'Tent A');
    await point(0.002, 'Tent B');
    await asUser(pool, s.organizer, (c) => c.query(`update public.events set briefing = $2, sponsor = $3 where id = $1`, [
      s.eventId,
      JSON.stringify({ dressCode: { text: 'Plain white t-shirt', colors: ['#ffffff'] }, collect: 'Sponsor t-shirt' }),
      JSON.stringify({ name: 'Chang Beer', campaign: 'Full Moon 2026' }),
    ]));

    const users = await createUsers(pool, 30, 'sponsor');
    await runPool(users, 10, (u) => rpc(pool, u, 'join_event', [s.joinCode, CONSENT]));

    // 18 of the 30 reach their position; 6 more only check in; 6 never show up at all.
    const ids = (await pool.query<{ id: string }>(`select m.id from public.event_members m where m.event_id = $1 order by m.participant_number`, [s.eventId])).rows.map((r) => r.id);
    await pool.query(`update public.participant_status set state = 'IN_POSITION', reported_at = now() where member_id = any($1::uuid[])`, [ids.slice(0, 18)]);
    await pool.query(`update public.participant_status set state = 'CHECKED_IN', reported_at = now() where member_id = any($1::uuid[])`, [ids.slice(18, 24)]);
    // The 30-second snapshots are what the report reads: one while filling, one at the peak.
    const snap = () => pool.query(`insert into public.event_stat_snapshots (event_id, at, state, counts) values ($1, now(), 'POSITIONING', public.hp_event_counts($1))`, [s.eventId]);
    await snap();
    await pool.query(`update public.participant_status set state = 'IN_POSITION' where member_id = any($1::uuid[])`, [ids.slice(18, 24)]);
    await snap();
    // Then people drift off after the shutter: the report must still headline the peak.
    await pool.query(`update public.participant_status set state = 'LEFT_POSITION' where member_id = any($1::uuid[])`, [ids.slice(0, 10)]);
    await snap();

    const r = await rpc<any>(pool, s.organizer, 'get_event_sponsor_report', [s.eventId]);
    expect(r.sponsor.name).toBe('Chang Beer');
    expect(r.audience.registered).toBe(30);
    expect(r.delivery.peak_in_position).toBe(24);
    expect(r.delivery.peak_in_position_at).toBeTruthy();
    expect(r.delivery.now.in_position).toBe(14); // the live figure did fall; the headline did not
    expect(r.briefing.dressCode.text).toBe('Plain white t-shirt');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.curve.length).toBeGreaterThanOrEqual(3);

    // Per point: everybody sent somewhere, and "turned up" can never exceed "sent there".
    expect(r.pickups).toHaveLength(2);
    expect(r.pickups.reduce((a: number, p: any) => a + p.assigned, 0)).toBe(30);
    expect(r.pickups.reduce((a: number, p: any) => a + p.checked_in, 0)).toBe(24);
    for (const p of r.pickups) expect(p.checked_in).toBeLessThanOrEqual(p.assigned);
  });

  it('is organizer-only: a participant cannot read the commercial figures', async () => {
    const s = await buildScenario(pool, 20);
    const [u] = await createUsers(pool, 1, 'sponsor-priv');
    await rpc(pool, u!, 'join_event', [s.joinCode, CONSENT]);
    await expectError(rpc(pool, u!, 'get_event_sponsor_report', [s.eventId]), /FORBIDDEN/);
  });
});

describe('privacy', () => {
  it('account deletion releases upcoming positions and anonymises membership', async () => {
    const s = await buildScenario(pool, 20);
    const [u, w] = await createUsers(pool, 2, 'privacy');
    await rpc(pool, u!, 'join_event', [s.joinCode, CONSENT]);
    const r = await rpc<any>(pool, u!, 'prepare_account_deletion', []);
    expect(r.upcoming_released).toBe(1);
    const m = await pool.query(`select user_id, status from public.event_members where event_id = $1`, [s.eventId]);
    expect(m.rows[0]).toEqual({ user_id: null, status: 'cancelled' });
    const free = await pool.query(`select count(*)::int n from public.formation_points where formation_id = $1 and member_id is null`, [s.formationId]);
    expect(free.rows[0].n).toBe(20);
    expect(w).toBeDefined();
  });

  it('anonymous users can join only events that allow it', async () => {
    const s = await buildScenario(pool, 20);
    const [anonUser] = await createUsers(pool, 1, 'anon');
    const anon = { ...anonUser!, isAnonymous: true };
    await expectError(rpc(pool, anon, 'join_event', [s.joinCode, CONSENT]), /EMAIL_SIGN_IN_REQUIRED/);
    await asUser(pool, s.organizer, (c) => c.query(`update public.events set allow_anonymous_join = true where id = $1`, [s.eventId]));
    const b = await rpc<any>(pool, anon, 'join_event', [s.joinCode, CONSENT]);
    expect(b.member.status).toBe('registered');
  });
});

describe('photos', () => {
  it('participants can read the photo files only after release', async () => {
    const s = await buildScenario(pool, 20);
    const [u] = await createUsers(pool, 1, 'photo');
    await rpc(pool, u!, 'join_event', [s.joinCode, CONSENT]);
    const photoId = '11111111-1111-4111-8111-' + Math.floor(Math.random() * 1e12).toString().padStart(12, '0');
    const base = `${s.eventId}/${photoId}/`;
    for (const f of ['master.jpg', 'display.jpg', 'share.jpg', 'thumb.jpg']) {
      await pool.query(`insert into storage.objects (bucket_id, name, owner, metadata) values ('event-photos', $1, $2, '{"mimetype":"image/jpeg"}')`, [base + f, s.organizer.id]);
    }
    for (const st of ['EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION', 'POSITIONING', 'LIVE', 'PHOTO_CAPTURED']) await rpc(pool, s.organizer, 'transition_event', [s.eventId, st, 'test']);
    await rpc(pool, s.organizer, 'photo_register', [
      s.eventId, photoId, 'official', 'Official', base + 'master.jpg', base + 'display.jpg', base + 'share.jpg', base + 'thumb.jpg',
      6000, 4000, 12_000_000, 'a'.repeat(64), new Date().toISOString(), 'DJI Mavic 3',
    ]);
    const visible = () => asUser(pool, u!, async (c) => (await c.query(`select name from storage.objects where bucket_id = 'event-photos' order by name`)).rows.map((r) => r.name));
    expect(await visible()).toEqual([]);
    expect((await rpc<any>(pool, u!, 'get_my_photo', [s.eventId])).released).toBe(false);
    await rpc(pool, s.organizer, 'transition_event', [s.eventId, 'PHOTO_RELEASED', 'test']);
    const names = await visible();
    expect(names).toEqual([base + 'display.jpg', base + 'share.jpg', base + 'thumb.jpg'].sort());
    expect(names).not.toContain(base + 'master.jpg');
    const card = await rpc<any>(pool, u!, 'get_my_photo', [s.eventId]);
    expect(card).toMatchObject({ released: true, eligible: true });
    expect(card.pixel_label).toBeGreaterThan(0);
  });
});

describe('participant identity & Hall of Fame', () => {
  it('requires a profile, keeps people anonymous by default, and exposes only first name + nationality', async () => {
    const s = await buildScenario(pool, 50);
    const [noProfile, alice, bob, teen] = await createUsers(pool, 4, 'identity');
    await pool.query(`update public.profiles set first_name = null where id = $1`, [noProfile!.id]);
    await expectError(rpc(pool, noProfile!, 'join_event', [s.joinCode, CONSENT]), /PROFILE_REQUIRED/);

    await rpc(pool, alice!, 'save_my_profile', ['Alice', 29, 'female', 'fr']);
    await rpc(pool, bob!, 'save_my_profile', ['Bob', 41, 'male', 'TH']);
    await rpc(pool, teen!, 'save_my_profile', ['Tom', 14, 'male', 'GB']);
    await expectError(rpc(pool, alice!, 'save_my_profile', ['<script>', 29, 'female', 'FR']), /INVALID_FIRST_NAME/);

    await rpc(pool, alice!, 'join_event', [s.joinCode, CONSENT, null, null, true]); // opts in
    await rpc(pool, bob!, 'join_event', [s.joinCode, CONSENT]); // default: anonymous
    await rpc(pool, teen!, 'join_event', [s.joinCode, CONSENT, null, null, true]); // under 16: ignored
    await expectError(rpc(pool, teen!, 'set_my_listing', [s.eventId, true]), /TOO_YOUNG/);

    const hof = await rpc<any>(pool, null, 'get_hall_of_fame', [s.eventId, 100, 0, null]);
    expect(hof.people).toEqual([{ name: 'Alice', nationality: 'FR' }]);
    expect(hof.listed).toBe(1);
    for (const person of hof.people) expect(Object.keys(person).sort()).toEqual(['name', 'nationality']);
    expect(JSON.stringify(hof)).not.toMatch(/"(age|birth_year|sex|lat|lng|label|participant_number)"|female/);

    // Bob changes his mind; Alice withdraws.
    await rpc(pool, bob!, 'set_my_listing', [s.eventId, true]);
    await rpc(pool, alice!, 'set_my_listing', [s.eventId, false]);
    const hof2 = await rpc<any>(pool, null, 'get_hall_of_fame', [s.eventId, 100, 0, null]);
    expect(hof2.people).toEqual([{ name: 'Bob', nationality: 'TH' }]);

    // Age and sex are never readable per person, not even by the organizer.
    await expectError(asUser(pool, s.organizer, (c) => c.query('select birth_year, sex from public.event_members')), /permission denied/);
    const demo = await rpc<any>(pool, s.organizer, 'get_event_demographics', [s.eventId]);
    expect(demo.total).toBe(3);
    expect(demo.countries).toBe(3);
    await expectError(rpc(pool, alice!, 'get_event_demographics', [s.eventId]), /FORBIDDEN/);

    // Account deletion withdraws the public entry.
    await rpc(pool, bob!, 'prepare_account_deletion', []);
    const hof3 = await rpc<any>(pool, null, 'get_hall_of_fame', [s.eventId, 100, 0, null]);
    expect(hof3.people).toEqual([]);
  });
});
