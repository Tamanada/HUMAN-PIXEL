# HUMAN PIXEL: Deployment

## Environments

| Env | Database / Auth / Storage | Participant app | Console | Purpose |
|---|---|---|---|---|
| local | `supabase start` (Docker) | `npm run dev:participant` | `npm run dev:console` | development, tests |
| staging | Supabase project `human-pixel-staging` | Netlify site `hp-participant-staging` | Netlify site `hp-console-staging` | release candidates, load rehearsals |
| production | Supabase project `human-pixel-prod` (Pro plan or higher, PITR on) | Netlify site `hp-participant` (e.g. `humanpixel.app`) | Netlify site `hp-console` (e.g. `console.humanpixel.app`) | live events |

Staging and production are separate Supabase projects: separate data, keys and auth users.

## 1. Supabase project setup (once per environment)

1. Create the project in the region closest to your events (Singapore `ap-southeast-1` for Thailand).
2. **Database → Extensions:** `postgis` and `pg_cron` are created by the first migration. Nothing to click.
3. **Auth → Providers → Email:** enable email, *confirm email* on, OTP length 6, OTP expiry 3600 s.
   Customize the "Magic Link" template to show `{{ .Token }}` prominently (the apps use the 6-digit code).
4. **Auth → SMTP:** configure a production SMTP provider (Postmark, SES, Resend…). The built-in
   mailer is rate-limited and **not** suitable for 12,000 sign-ups.
5. **Auth → Rate limits:** a beach full of phones shares a few carrier-NAT IP addresses. Raise
   per-IP limits for sign-in/OTP verification (e.g. 2,000 / 5 min) and email sending to your SMTP
   quota. Keep the application-level limits (in the database) as they are.
6. **Auth → Anonymous sign-ins:** enable if any event will use "instant join without email"
   (each event opts in separately; default off).
7. **Auth → URL configuration:** Site URL = participant app URL; additional redirect URLs =
   console URL.
8. **Compute:** 12,000-participant events: at least *Small*; 50,000: *Medium* or larger. Use the
   Supavisor pooler (default for PostgREST). Run a load rehearsal on staging with the same size.
9. **Backups:** enable Point-in-Time Recovery on production.

## 2. Secrets and variables

Never commit secrets. `.env.local` files are git-ignored; only `.env.example` files are tracked.

GitHub → Settings → Environments `staging` and `production` (add **required reviewers** on production):

| Secret | Used by |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | deploy workflow (CLI) |
| `SUPABASE_PROJECT_REF` | deploy workflow |
| `SUPABASE_DB_PASSWORD` | deploy workflow (`db push`) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | production deploy guard |
| `BACKUP_DATABASE_URL` | nightly backup (read-only role recommended) |
| `BACKUP_PASSPHRASE` | nightly backup encryption |

Netlify site environment variables:

| Site | Variables |
|---|---|
| participant | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MANIFEST_URL=/m/{eventId}`, `VITE_TIME_URL=/api/time`, `VITE_SENTRY_DSN`, `VITE_APP_VERSION`; **functions:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| console | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PARTICIPANT_URL`, `VITE_MAP_STYLE_URL`, optional `VITE_SATELLITE_TILES` + `VITE_SATELLITE_ATTRIBUTION` (licensed provider), `VITE_SENTRY_DSN` |

The anon key is designed to be public: every table is protected by RLS and column grants.
The service-role key is only ever set as an Edge Function secret (automatic on Supabase).

## 3. Web apps (Netlify)

Create two Netlify sites from the GitHub repository. Each reads its own `netlify.toml`:

- participant: base `apps/participant`, which also deploys the `manifest` function (CDN-cached event
  manifest at `/m/{eventId}`) and the `time` edge function (`/api/time`).
- console: base `apps/console`.

Enable "Deploy previews" for pull requests. Production deploys from `main`.

## 4. Database and Edge Functions (GitHub Actions)

- `ci.yml`: every PR and push. Typecheck, core tests, both builds, and a full Supabase stack
  in Docker with the integration suite (including 12,000 concurrent joins) and `db lint`.
- `deploy.yml`: on a `v*` tag. Migrations + Edge Functions to **staging**, then **production**
  after manual approval. Production is blocked while any event is in its critical window
  (`deploy_guard()`).
- `backup.yml`: nightly encrypted logical dump (35-day artifact retention), in addition to PITR.

Release:

```bash
git tag v1.0.0
```

```bash
git push origin v1.0.0
```

### Migration rules

- Migrations are **forward-only and immutable** once pushed. Fix mistakes with a new migration
  (see `20260922000009_finalize_v2.sql` replacing a function).
- Every new table or function must be added to the privilege whitelist explicitly (see
  `20260922000006_grants.sql`); Supabase's defaults would otherwise expose it.
- Each migration must be safe to apply during registration (no long exclusive locks on
  `formation_points`, `event_members`, `participant_status`). Add indexes `concurrently` in their
  own migration when tables are large.

## 5. Mobile apps (Capacitor)

The participant PWA works from the QR code in any modern browser, with no install required. The
native apps add reliable background-safe GPS, haptics, keep-awake and native sharing.

```bash
npm run cap:sync -w @human-pixel/participant
```

- **Android** (project committed in `apps/participant/android`): open with `npm run cap:android -w @human-pixel/participant`,
  set the signing config, and build an AAB for Play Console. Location, vibration, wake-lock and
  camera permissions are declared in `AndroidManifest.xml`.
- **iOS** (requires macOS + Xcode): `npx cap add ios` once, then add to `Info.plist`:
  `NSLocationWhenInUseUsageDescription` ("HUMAN PIXEL uses your location on your phone only, to
  guide you to your pixel. It is never sent to our servers."), `NSCameraUsageDescription` (QR
  scanning). Build and submit through Xcode/TestFlight.
- Set `VITE_*` variables for the production API before `cap sync`; bump `versionCode`/`CFBundleVersion`.

## 6. Rollback

| Layer | How |
|---|---|
| Web apps | Netlify → Deploys → "Publish deploy" on the previous build (instant, atomic). |
| Edge Functions | Re-run `deploy.yml` on the previous tag (`workflow_dispatch`), or `supabase functions deploy` from that tag. |
| Database schema | Forward-only: ship a compensating migration. Never edit applied migrations. |
| Database data | Point-in-Time Recovery (production) to a new project, or restore the nightly dump (see OPERATIONS.md). |
| Mobile apps | Store rollouts are staged (start at 10%); the PWA fallback always serves the current web build. |

**Never deploy during an event's critical window.** The deploy guard enforces this for migrations.
For the web apps, freeze Netlify auto-publishing from T-3 h to T+1 h ("Stop auto publishing").

## 7. Capacity planning cheat sheet

| Participants | Peak writes/s (simulated) | Supabase compute | Notes |
|---|---|---|---|
| 1,000 | ~10 | Micro | |
| 12,000 | ~80 | Small–Medium | rehearsal: 468 reports/s sustained on a laptop |
| 50,000 | ~340 | Medium–Large | rehearse on staging; move participant numbering to a sequence for flash registrations |

The manifest is served from Netlify's durable CDN cache, so its origin load does not grow with
crowd size. Live dashboard cost is O(organizers), not O(participants).
