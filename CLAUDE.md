# CLAUDE.md -- project memory

Read this first. Keep lasting notes here (decisions, gotchas, how things are deployed).

## What this is
"Job Reminders" (repo: renewal-autopilot) -- a multi-tenant ServiceM8 add-on for TCB Pest Control
Canberra (Phill). Tracks when customers are due for their next service (from renewal badges like
"1 year auto") and queues SMS/email reminder drafts that staff approve in a dashboard. Never auto-sends
to customers.

## Stack / deploy
- Cloudflare Worker + D1, no build step. `src/index.js` is the router + crons.
- Pushing to `master` auto-deploys via Cloudflare Workers Builds.
- **Migrations are NOT applied by the deploy.** Apply each new `migrations/NNN-*.sql` to the remote D1
  (`renewal-autopilot-db`, id `467d6878-c491-4100-bce5-5943207bc45f`) with
  `npx wrangler d1 execute renewal-autopilot-db --remote --file=migrations/NNN-....sql`
  (or the Cloudflare D1 MCP tool) -- **before** merging code that uses the new columns.
  Keep `schema.sql` in sync (fresh installs + tests load it).
- Tests: `npm test` (node:test; `test/helpers/sqlite-d1.js` fakes D1 with real SQLite, fetch is stubbed).
- `manifest.json` uses CRLF line endings -- edit with `sed`, not tools that rewrite newlines.
- New OAuth scopes in `manifest.json` only take effect after updating the app in the ServiceM8
  developer portal AND reinstalling via `https://renewal-autopilot.phill-abb.workers.dev/install`.
- Admin debug routes take `X-Admin-Key` / `?adminKey=` = the app secret.

## Crons
- `0 16 * * *` (2-3am Canberra): nightly reconciliation -- badge sync, recompute, follow-up drafts.
- `*/2 * * * *`: backfill chunks, token refresh, delivery verification, daily due digest.

## Due notifications (added 2026-10-05)
Phill asked to be notified "like the Reminders add-on" when a customer becomes due -- NOT as a task on
a job. Design:
- Once a day after **8am Sydney**, all newly due/overdue, not-yet-contacted (`reminder_round = 1`)
  customers go into **one ServiceM8 Inbox message** (`POST /inboxmessage.json`, scope `publish_inbox`)
  plus a **push + bell notification** (`POST /notification.json`, scope `create_notifications`) that
  opens it (`destination_url: servicem8://inbox/{uuid}`).
- Recipients = every staff member who has opened the add-on (`notify_recipients`, recorded from the
  add-on JWT's `auth.staffUUID`). One notification request per recipient: ServiceM8 rejects the whole
  request if any recipient is invalid, and retries duplicate the push.
- `due_customers.due_notified_at` prevents repeats; cleared when a new service cycle starts.
- `tenant_settings.last_due_digest_date` is the atomic once-per-day claim.
- Force one now: `POST /debug/due-digest?tenant=<id>` (admin key).
- Code: `sendDueDigestForTenant` / `buildDueDigest` in `src/due-engine.js`; migration 007.

## Property matching (changed 2026-10-06)
- A renewal is **one per property**, not per client card: `normalizeStreet` (src/due-engine.js) is the
  property key, and the engine, badge hand-off and open-booking suppression all group by it alone.
  Phill's call: any completed non-warranty job at the address (any card, any job type) resets it.
- The key is canonical: street types expanded (Cr/Cres -> crescent, St -> street, Pl -> place...),
  state/country/"unit" dropped, suburb + postcode KEPT (stops "1 Smith St" in two suburbs merging),
  unit slash kept ("2/9" != "29"). Why: online bookings write "23 Joyner Cr" vs "23 Joyner Crescent",
  so Elizabeth Zaja stayed "due" after being serviced.
- Changing `normalizeStreet` is safe: `rekeyRowsForRule` re-keys stored rows on the next recompute and
  merges rows that now collide (keeps the most recent). No manual migration needed.
- Live preview before rollout: 9 properties merged, all genuine duplicates.

## Reminder wording (changed 2026-10-06)
- Follow-up rounds 2/3 have two wordings: "coming up due / due very soon" before the due date, and
  "overdue" once past it (`isPastDue`, `FOLLOWUP_OVERDUE_TEMPLATES`, `buildFollowUpTexts`). Phill's call:
  plain "overdue", not softer "now due". Round 1 has no "soon" and is unchanged.
- `refreshOverdueFollowUpDrafts` rewrites queued pending drafts to the overdue wording (nightly + every
  dashboard load), but only when the stored text exactly equals what we generated. Staff edits only reach
  the DB at send time, so pending text is ours.

## ServiceM8 API facts worth remembering
- API docs index: https://developer.servicem8.com/llms.txt (reference pages are `<name>.md`).
- Messaging API (SMS/email) lives at the API root, not under `/api_1.0`.
- Create endpoints usually return the new uuid in the `x-record-uuid` header.
- `job.badges` is a JSON-encoded string, both read and write.
- The ServiceM8 MCP tools (`mcp__servicem8__*`) can search the Help Center to see how built-in
  features behave.
