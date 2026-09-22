# HUMAN PIXEL: Operations

## Event-day runbook

| When | Who | Action |
|---|---|---|
| T-14 d | Organizer | Perimeter, exclusions (+ buffers), emergency corridors, access & assembly points drawn. Formation generated at the expected turnout, readability ≥ 75, validated and **locked**. Registration open. |
| T-7 d | Platform | Staging rehearsal at 1.2× expected participants (`npm run load`). Check compute size, SMTP quota, auth rate limits. |
| T-2 d | Organizer | Walk the site with 3–5 phones (iOS + Android) on a test event: GPS accuracy on the ground, tolerance radius, arrival route. |
| T-1 d | Organizer | Close registration if capacity reached. Confirm start time, arrival deadline, **positions release time** (e.g. T-6 h). Print QR posters for late registration. |
| T-1 d | Platform | Freeze deploys (deploy guard is automatic for DB; stop Netlify auto-publish T-3 h → T+1 h). |
| T-6 h | System | Positions unlock; phones fetch their pixel (spread over ~5 min) and store it offline. |
| T-90 min | Organizer | `→ Navigation`: every position is released; phones guide people. Watch **Live**. |
| T-45 min | Organizer | `→ Positioning`. Use **Reclaim no-shows** once arrivals plateau (on-site standby people get the most important empty pixels first). Publish announcements if needed. |
| T-10 min | Organizer | `→ Ready` when readiness is high. **No more start-time changes** (the database refuses changes < 90 s ahead). |
| T-0 | Phones | Every phone counts down on its own synced clock and shows HUMAN PIXEL LIVE. The scheduler records LIVE and the attendance snapshot. Drone photographs. |
| T+10 min | Organizer | `→ Photo captured`. Upload the official photo (and evidence photos/video metadata). |
| T+1–24 h | Organizer | Mark primary, **Release**. Everyone receives "Now you can see what you created". |
| T+7 d | Organizer | `→ Completed`. Download the evidence report (SHA-256 sealed). Retention timer starts. |

## Monitoring

- **Event health (console → Live):** 🟢 NORMAL / 🟠 HIGH LOAD / 🔴 CRITICAL, computed in the database
  from query latency, report rate, report silence (possible network outage), GPS quality and
  readiness close to T-0. Issues are listed with explanations.
- **Platform health (console → Platform admin):** active/live events, participants, reports/min,
  DB size, connections vs max, cache hit ratio, cron job runs and failures.
- **Errors:** Sentry in both apps when `VITE_SENTRY_DSN` is set (participant events containing
  coordinates are dropped before sending).
- **Logs:** Supabase log explorer (Postgres, PostgREST, Auth, Edge Functions: structured JSON
  lines), Netlify function logs for the manifest endpoint.
- **Synchronization metrics:** per-participant clock uncertainty and GPS accuracy are reported with
  each status transition; the Live tab shows median/p90 accuracy and p95 clock uncertainty.

Suggested alerts (Supabase → Reports / external uptime): API 5xx rate > 1%, DB CPU > 80% for 5 min,
connections > 80% of max, `/m/{eventId}` origin errors, cron failures.

## Incident playbooks

| Symptom | Meaning | Action |
|---|---|---|
| 🔴 NO_REPORTS during positioning | Mobile network at the venue is saturated or down | Nothing breaks: phones run offline (position, GPS, countdown). Use megaphones/staff; statuses sync later. Do **not** move the start time. |
| 🟠 GPS_POOR | Many phones report accuracy worse than required | Ask people to hold phones flat, away from the body, under open sky. Consider raising the tolerance/accuracy (before READY). |
| Low readiness near T-0 | People still walking | Reclaim no-shows; announce; if necessary delay the start by ≥ 2 minutes (only possible ≥ 90 s before the current start). |
| Wrong start time published | | Change it in Settings ≥ 90 s ahead; phones pick it up via the manifest within ~40 s (30 s polling + CDN). |
| Participant lost their phone / battery | | They sign in on another phone with the same email: the assignment is tied to the account. |
| Participant needs a different spot (accessibility) | | Participants → Manage → Assign a new pixel. Their phone refreshes. |
| Database slow (🟠 DB_SLOW) | Heavy load or noisy neighbour | Phones are unaffected. Pause non-essential admin pages; scale compute if persistent. |
| Photo upload fails | Network | Retry: each file uploads independently; registering the photo verifies all four files exist. |
| Formation rejected by the database | Points outside perimeter/in exclusions/too close | Read the validation report; fix areas or design; regenerate. Nothing was assigned. |

## Backups and restore {#restore}

- Production: Supabase PITR (primary) + nightly encrypted logical dump (`backup.yml`, 35 days).
- Restore a dump into a **new** project (never over production):

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in FILE.dump.gz.enc -pass env:BACKUP_PASSPHRASE | gunzip > restore.dump
```

```bash
pg_restore --no-owner --dbname "$TARGET_DATABASE_URL" restore.dump
```

- Test a restore quarterly and before each major event.

## Privacy operations

- **Account deletion** is self-service (participant app → Account). It releases upcoming pixels,
  anonymises past participation and deletes the auth user.
- **Retention:** `purge_expired_personal_data()` runs daily and unlinks participants from events
  finished more than `retention_days` ago (default 90). Aggregate evidence remains.
- **Data subject requests** by email: find the user in Platform admin → Users; deletion through the
  same function as self-service (`prepare_account_deletion` + auth user deletion).
- GPS coordinates of participants are never stored, so there is no location history to export.

## Record evidence

The Evidence tab and `get_event_evidence()` produce a JSON report: exact times (state history,
LIVE timestamp), location (perimeter GeoJSON and area), formation geometry metadata (version,
seed, checksum, metrics, validation), attendance at the LIVE moment, assignment action counts,
photo hashes and camera metadata, audit trail size, all sealed with a SHA-256 digest. HUMAN PIXEL
makes no record claim; adjudication belongs to the record body. Keep the original drone files and
flight logs alongside the report.
