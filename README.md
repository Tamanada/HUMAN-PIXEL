# HUMAN PIXEL

> **You don't know what you are creating. You only know where you belong.**
> Thousands of people. One moment. One human pixel.

HUMAN PIXEL turns a crowd into a giant image seen from the sky. Each participant receives one
precise GPS position and never learns the secret formation; at the scheduled second, thousands of
people standing on their pixels become a word, a logo or a drawing, and everyone receives the aerial
photograph afterwards.

**The server coordinates the event. The phone executes the experience.** GPS, distance, direction,
tolerance and the countdown all run on the phone; the backend only receives a handful of state
transitions per participant. Built for 12,000 participants per event, architected for 50,000+.

## Repository

| Path | What |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Binding blueprint: load model, security, data model, state machine, formation engine, sync, failure recovery, measured results |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Environments, Supabase/Netlify setup, secrets, CI/CD, mobile builds, capacity, rollback |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Event-day runbook, monitoring, incident playbooks, backups/restore, privacy operations |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and controls |
| `packages/core` | Pure TypeScript domain: geo, positioning, clock sync, state machines, formation engine, crowd simulator |
| `apps/participant` | Participant PWA + Capacitor (iOS/Android): join, reveal, offline navigation, countdown, photo |
| `apps/console` | Organizer dashboard + platform admin |
| `supabase/` | Migrations (schema, RLS, RPCs), Edge Functions, dev seed |
| `tools/simulator` | Database integration tests and the event-day load rehearsal CLI |

## Quick start (local)

Prerequisites: Node 22+, Docker Desktop, Supabase CLI.

```bash
npm install
supabase start
```

`supabase start` applies every migration and the dev seed (a platform admin, the demo organization
"Phangan Festivals" and the event **PHANGAN HUMAN PIXEL 2027**, code `PHANGAN7`, on Haad Rin beach).
Local services use dedicated ports (API 55421, DB 55422, Studio 55423, Mailpit 55424) so they can
run next to other Supabase projects.

Create `apps/console/.env.local` and `apps/participant/.env.local` from their `.env.example`, with
`VITE_SUPABASE_ANON_KEY` taken from `supabase status -o env` (`ANON_KEY`). Then:

```bash
npm run dev:console
```

```bash
npm run dev:participant
```

- Console: http://localhost:5174. Sign in as `admin@humanpixel.local`; the one-time code arrives in Mailpit at http://127.0.0.1:55424.
- Participant app: http://localhost:5173/j/PHANGAN7

## Tests

```bash
npm run test -w @human-pixel/core
```

Geo, positioning hysteresis, clock sync, countdown, both state machines (the TypeScript one is
checked against the SQL transition table), offline outbox, the formation engine at 1k/5k/12k/50k,
and a crowd simulation that runs the real phone code against noisy GPS for 1k, 5k, 12k and 50k
participants.

```bash
npm run test:db -w @human-pixel/simulator
```

Against the local database, as impersonated users through RLS: formation secrecy, protected
columns, cross-organization isolation, server-side formation validation, **13,200 concurrent joins
on 12,000 positions with zero duplicates**, idempotent/replay-safe status reports, waitlist
promotion, no-show reclaim, formation remapping, state machine, scheduler, live stats, privacy,
photo access.

Event-day load rehearsal (local or staging only; the CLI refuses hosted databases unless explicitly allowed):

```bash
npm run load -w @human-pixel/simulator -- --code PHANGAN7 --n 12000 --concurrency 40
```

## License

Proprietary. All rights reserved.
