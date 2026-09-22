/**
 * Event-day load rehearsal against a real database (local or staging, NEVER production).
 * Simulates N participants who join an event by code and report realistic lifecycle states
 * through the same RPCs the phones use, with the same RLS and rate limits.
 *
 *   npm run load -w @human-pixel/simulator -- --code PHANGAN7 --n 12000 --concurrency 40
 *
 * Options: --code <join code> (required) · --n <participants> · --concurrency <db connections>
 *          --no-show <fraction, default 0.03> · --skip-join (only report statuses)
 */
import { CONSENT, DB_URL, createPool, createUsers, rpc, runPool, type Actor } from './db';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? 'true' : process.argv[++i]!);
}
const code = args.get('code');
const n = Number(args.get('n') ?? 1000);
const concurrency = Number(args.get('concurrency') ?? 40);
const noShow = Number(args.get('no-show') ?? 0.03);
if (!code) {
  console.error('Usage: load --code <JOINCODE> [--n 12000] [--concurrency 40]');
  process.exit(1);
}
if (/supabase\.co/.test(DB_URL) && !process.env.HP_ALLOW_REMOTE) {
  console.error('Refusing to load-test a hosted database without HP_ALLOW_REMOTE=1 (use staging only).');
  process.exit(1);
}

const STATES = ['CHECKED_IN', 'ARRIVED', 'IN_POSITION', 'READY'] as const;

async function main() {
  const pool = createPool(concurrency + 2);
  const t0 = performance.now();
  console.log(`▶ creating ${n.toLocaleString()} test users…`);
  const users: Actor[] = await createUsers(pool, n, `load-${code}`);
  console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  let eventId = '';
  if (!args.has('skip-join')) {
    const t1 = performance.now();
    let done = 0;
    const lat: number[] = [];
    await runPool(users, concurrency, async (u) => {
      const s = performance.now();
      const b = await rpc<{ event: { id: string } }>(pool, u, 'join_event', [code, CONSENT, null, `sim-${u.id.slice(0, 8)}`]);
      lat.push(performance.now() - s);
      eventId = b.event.id;
      if (++done % 2000 === 0) console.log(`  ${done.toLocaleString()} joined`);
    });
    lat.sort((a, b) => a - b);
    const ms = performance.now() - t1;
    console.log(`▶ joins: ${n.toLocaleString()} in ${(ms / 1000).toFixed(1)} s → ${Math.round((n / ms) * 1000)}/s · p50 ${lat[lat.length >> 1]!.toFixed(0)} ms · p95 ${lat[Math.floor(lat.length * 0.95)]!.toFixed(0)} ms · p99 ${lat[Math.floor(lat.length * 0.99)]!.toFixed(0)} ms`);
  }

  // Lifecycle: each present participant reports its transitions in order (like the outbox would).
  const t2 = performance.now();
  let reports = 0;
  const present = users.filter(() => Math.random() >= noShow);
  await runPool(present, concurrency, async (u, i) => {
    const r = Math.random();
    const last = r < 0.88 ? 3 : r < 0.93 ? 2 : r < 0.97 ? 1 : 0; // most reach READY
    for (let s = 0; s <= last; s++) {
      // Server rate limit is 1 report / 2 s per participant: the simulated clock steps accordingly.
      await pool.query(`update public.participant_status set reported_at = now() - interval '3 seconds' from public.event_members m where m.id = participant_status.member_id and m.user_id = $1`, [u.id]);
      await rpc(pool, u, 'report_status', [eventId || null, STATES[s], s + 1, new Date(Date.now() + s * 1000).toISOString(), 3 + Math.random() * 6, 20 + Math.round(Math.random() * 60), `sim-${u.id.slice(0, 8)}`, 'sim']);
      reports++;
    }
    if (i > 0 && i % 3000 === 0) console.log(`  ${i.toLocaleString()} participants reported`);
  });
  const ms2 = performance.now() - t2;
  console.log(`▶ status reports: ${reports.toLocaleString()} in ${(ms2 / 1000).toFixed(1)} s → ${Math.round((reports / ms2) * 1000)}/s (${present.length.toLocaleString()} present, ${n - present.length} no-shows)`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
