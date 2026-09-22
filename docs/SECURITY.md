# HUMAN PIXEL: Security

## Assets

1. **The secret formation**: design source, points, zones. Leaking it ruins the event.
2. **Participant privacy**: identity (email), participation, per-person status.
3. **Event integrity**: timing, state, assignments, photos, evidence.

## Adversaries

- A curious or malicious **participant** inspecting and replaying API calls, scripting many accounts.
- A **rival organizer** probing other organizations' events.
- An **outsider** with the public anon key (it ships in the apps by design).
- A compromised **organizer account** (limited to that organization).

## Controls

| Threat | Control | Where |
|---|---|---|
| Participant reads the formation | `formation_points`, `formation_zones`, `assignment_log` have **no client table privilege at all** (organizers use RPCs), which also removes planner-statistics side channels; `formations`/`formation_assets` have no participant RLS policy. Tests assert `permission denied` / 0 rows. | `000002`, `000010`, DB tests |
| Participant infers position meaning | Pixel number = random permutation; zones = equal-count bands; coordinates only after `positions_release_at`. | engine, `get_my_assignment` |
| Mass fake registrations to scrape positions | Positions withheld until release; per-user **and per-IP** join limits (IP limit sized for carrier NAT); email OTP by default (anonymous join opt-in per event); late registration off by default. **Partial mitigation only, see residual risks.** | `join_event`, `000010` |
| Replay / forged status reports | Idempotent `seq` per device, client-time ordering across devices, 2 s per-participant rate limit, membership check. | `report_status` |
| Organizer tampers with protected fields | Column-level grants (clients cannot address `state`, `active_formation_id`, …) + trigger guard + state-dependent rules. | `000006_grants.sql`, `hp_guard_event` |
| Unsafe formation (people in exclusion zones, too close) | Server-side PostGIS validation of every point before a formation can be locked; checksum; spacing grid check. | `formation_finalize` |
| Cross-organization access | Every policy and RPC checks organization membership via `SECURITY DEFINER` helpers with pinned `search_path`; helpers exclude suspended users and suspended organizations; `photo_register` cannot touch another event's row. | helpers, `000010` |
| Organizer privilege abuse inside an org | Only owners can change or remove owners; the last owner can never be demoted or removed; invitations rate-limited. | `000010` |
| Privilege creep from new objects | Default-deny whitelist: all table/function privileges revoked from `anon`/`authenticated` and re-granted explicitly. | `000006_grants.sql` |
| Internal functions called directly | `hp_*` internals have no EXECUTE grant (tests assert `permission denied`). | grants, DB tests |
| Photo leakage before release | Private bucket; `storage.objects` policy allows participants only released display/share/thumb files; master never readable by participants. | `000005_operations.sql` |
| Location data exposure | GPS never leaves the phone; Sentry `beforeSend` drops events containing coordinates; no location columns exist for participants. | participant app |
| Supply chain / secrets | No secrets in source; `.env*` ignored; service role only in Edge Functions; CSP headers on both sites. | `.gitignore`, `netlify.toml` |
| Clickjacking / XSS surface | `X-Frame-Options: DENY`, strict CSP (`script-src 'self'`), React escaping, no `dangerouslySetInnerHTML`. | `netlify.toml` |

## Accepted residual risks

- Participants who meet on the day can pool their own coordinates and partially reconstruct the
  image. Inherent to the concept; mitigated by late release.
- The public manifest exposes event name, state and times of non-draft events by UUID (by design).
- `deploy_guard()` exposes the number of events with ≥ 100 participants in a critical window (a count only).
- **Coordinated fake accounts (review finding F1).** Accounts that join early hold evenly spread
  pixels (progressive order), so a few hundred scripted accounts can, at release time, sketch the
  image. Rate limits raise the cost but a determined actor with many emails can still do it.
  Before large public events: add a CAPTCHA to sign-up (Supabase Auth supports hCaptcha/Turnstile),
  keep anonymous join off, release coordinates as late as practical, and watch join bursts in the
  audit log. A future improvement is to assign fill order at release time instead of join time.
- Rate-limit counters roll back with a failed call (failed join attempts are not counted). Join
  codes have ~8.5e11 combinations, so guessing remains impractical.
- Participant status is self-reported by the phone (inherent without streaming GPS); evidence
  counts are therefore "reported in position", which the aerial photo corroborates.

## Reporting

security@humanpixel.app. Please do not test against production events.
