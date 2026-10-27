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
- **New OAuth scopes go in BOTH `manifest.json` and `OAUTH_SCOPES` (src/servicem8-oauth.js)** -- the
  install link sends `OAUTH_SCOPES`, not the manifest (missed for publish_inbox/create_notifications/
  create_jobs until 2026-10-16). `test/oauth-scopes.test.js` checks they match.
- New OAuth scopes in `manifest.json` only take effect after updating the app in the ServiceM8
  developer portal AND reinstalling via `https://renewal-autopilot.phill-abb.workers.dev/install`.
- Admin debug routes take `X-Admin-Key` / `?adminKey=` = the app secret.

## Crons
- `0 16 * * *` (2-3am Canberra): nightly reconciliation -- badge sync, recompute, follow-up drafts.
- `*/2 * * * *`: backfill chunks, token refresh, delivery verification, daily due digest.
- **The nightly must finish inside Cloudflare's 15-minute cron limit.** From 2026-09-17 to 2026-10-12 it
  was killed ~200 of 319 customers in (no `cron_runs` row = it didn't finish). Fix: `shouldRefreshDetails`
  only re-reads contact + notes for new/changed rows, due soon/due/overdue (nightly), and everyone else
  one night a week; the two reads run in parallel; follow-up drafting runs *before* the recompute.
  Check health with `SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT 3`.

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
  state/country/"unit" and a trailing postcode dropped, suburb KEPT (stops "1 Smith St" in two suburbs
  merging), unit slash kept ("2/9" != "29"). Postcode dropped 2026-10-16: most of phill johnston's jobs
  say "...greenway", one says "...Greenway ACT 2900". Live preview: 1 merge (Kathryn Market, a real duplicate). Why: online bookings write "23 Joyner Cr" vs "23 Joyner Crescent",
  so Elizabeth Zaja stayed "due" after being serviced.
- Changing `normalizeStreet` is safe: `rekeyRowsForRule` re-keys stored rows on the next recompute and
  merges rows that now collide (keeps the most recent). No manual migration needed.
- Live preview before rollout: 9 properties merged, all genuine duplicates.

## "Due now" timing = ServiceM8's reminder timing (changed 2026-10-08)
- Phill wants a customer in "Due now" the same day ServiceM8's own Job Reminder for them arrives.
  ServiceM8's follow-ups recur "Every <due month> on the first Monday" and land 4 weeks before that
  Monday (Nov 2026 batch arrived Mon 5 Oct). So `dueNowStartDate` = first Monday of the due month
  minus `SM8_REMINDER_LEAD_DAYS` (28), compared as Sydney dates so the 3am run flips them that Monday.
- The 4 weeks is ServiceM8's Settings > Preferences > Recurring Jobs "weeks prior" -- if Phill changes
  it there, change the constant too.

## Reminder wording (changed 2026-10-06)
- Follow-up rounds 2/3 have two wordings: "coming up due / due very soon" before the due date, and
  "overdue" once past it (`isPastDue`, `FOLLOWUP_OVERDUE_TEMPLATES`, `buildFollowUpTexts`). Phill's call:
  plain "overdue", not softer "now due". Round 1 has no "soon" and is unchanged.
- `refreshOverdueFollowUpDrafts` rewrites queued pending drafts to the overdue wording (nightly + every
  dashboard load), but only when the stored text exactly equals what we generated. Staff edits only reach
  the DB at send time, so pending text is ours.

## SMS reply wording + termite barrier (changed 2026-10-24)
- ServiceM8 appends its own **"Reply here" link (Two-Way SMS)** to every SMS sent through it, plus an
  Australian spam-compliance header/footer on some. It can't be turned off and it's the only way a reply
  gets back. Our SMS said "Reply here" too, so it read twice -- now every SMS ends `SMS_REPLY` =
  "Tap the link below to reply, or call us on (02) 6105 9771" (src/due-engine.js). Option 2's softer
  "Get in touch" wording is unchanged; email ("Reply to this email") is unchanged.
- **Termite barrier** is a third wording (`TERMITE_BARRIER`, not a real ServiceM8 category). Barrier jobs
  are booked under Termite Management Treatment like the bait stations, so `resolveCategoryUuid` now reads
  the **notes as well as the description**: "inspection" wins first, then "barrier" (Phill: "Anita
  [Easterby-Wood] is a termite barrier not monitoring stations", job #251). 7 live customers.
- `refreshOverdueFollowUpDrafts` is now **`refreshPendingDrafts`**: it rewrites EVERY pending draft
  (rounds 1-3) to what the templates say now, so a wording change reaches the ~311 drafts already queued,
  not just new ones. Sent/failed drafts are never touched (they're the record of what went out), and a
  staff edit only reaches the DB at send time, so pending text is always ours.

## The dashboard keeps your place (changed 2026-10-27)
- Sending, "Mark called" and a stage move still reload the page (the server decides which tab the row
  belongs in afterwards), but `reloadKeepingPlace` first saves the view to `sessionStorage`
  (urgency tab / Contacted stage, plan tab, service filter, search text, scroll position) and restores it
  on load, then shows a toast ("SMS sent to Jill Smith"). Phill: "it reloads the screen and takes me to
  the main screen again ... i cant see where i was up to in the list".
- The toast matters as much as the scroll: after a send the row leaves the tab you were on, so without it
  the list just appears to lose someone. sessionStorage is wrapped in try/catch -- if it throws (some
  in-app browsers) the page simply opens on the default tab, as before.

## Manual stages + Book job (added 2026-10-16)
- Each dashboard row has **Move to...** (Due / Contacted 1 / Contacted 2 / Contacted 3-Call customer /
  Called) for customers phoned by hand. It's `setCustomerStage` in `src/dashboard.js`, which maps each stage
  onto the existing state: `reminder_round` 1/2/3/4, plus `called_at` for Called. "Contacted 3" lands in
  Call customer, which is where rows already go after the 3rd reminder.
  `due_customers.manual_stage_at` / `manual_stage_note` record when and the note (migration 008).
  A stage set by hand counts as "contacted" even with no sent draft.
- A move archives unsent drafts and every draft from the new round on, so the nightly re-drafts those
  rounds on its normal schedule. Back to Due rebuilds the round-1 drafts. A new service cycle clears the
  manual fields.
- **Book job** (`bookJobForCustomer`) POSTs a Work Order to `/job.json` for the row's client, address and
  category, then suppresses the row (`open_pipeline_job`). It needs the **`create_jobs`** scope;
  `manage_jobs` doesn't cover creating jobs. The renewal badge moves onto the new job via the normal
  hand-off once it's completed.
- The booked job's address is `bookingAddress`: the last job's text if it already ends in a postcode,
  otherwise rebuilt from that job's ServiceM8 geocode (`geo_number`/`geo_street`/`geo_city`/...), e.g.
  "12/26 cynthea Teague crescent greenway" -> "12/26 Cynthea Teague Crescent\nGreenway ACT 2900" (Phill:
  "like the unsuccessful one", job #929). Never changes the property key (no suburb is added where none
  was typed). Billing = the same, unless the last job billed elsewhere.
- An API-created job gets NO contacts (unlike one made in the app), so Book job copies the client card's
  contacts onto it as Job Contacts, like the app does (`planJobContacts` / `createJobContact`, scope
  **`manage_job_contacts`**). Best-effort:
  if it fails the job is still booked and the dashboard says to add the contact by hand.

## ServiceM8 API facts worth remembering
- API docs index: https://developer.servicem8.com/llms.txt (reference pages are `<name>.md`).
- Messaging API (SMS/email) lives at the API root, not under `/api_1.0`.
- Create endpoints usually return the new uuid in the `x-record-uuid` header.
- `job.badges` is a JSON-encoded string, both read and write.
- The ServiceM8 MCP tools (`mcp__servicem8__*`) can search the Help Center to see how built-in
  features behave.
