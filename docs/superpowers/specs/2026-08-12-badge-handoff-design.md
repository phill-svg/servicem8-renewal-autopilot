# Badge hand-off to the latest job

**Date:** 2026-08-12
**Status:** approved, not yet implemented
**Scope:** `src/due-engine.js` behaviour change. **Writes to ServiceM8** (moves job badges) and mutates D1 drafts.

## Problem

When a customer is serviced again before their renewal falls due, the renewal date should move to the newer job. For **category**-based rules this already happens: `upsertJobsAsDueCandidates` groups jobs by `company_uuid | normalized street` and keeps the most recently completed one.

**Badge**-based rules are the gap. Their candidate list comes from `listCompletedJobsForBadge`, which only contains jobs *carrying the badge*. A newer job created without the badge is invisible to the engine, so `last_completed_at` never moves and the customer is chased against a stale date — potentially reminded to book a service they already had.

## Decisions

Confirmed with the user on 2026-08-12:

- **Qualifying job:** any completed job at the same company and address, excluding warranty categories. Reuses `getWarrantyCategoryUuids`, the existing rule that a warranty callback must not push the renewal out.
- **Trigger:** when the newer job *completes*. A booked-but-unfinished job must not shift the date, since it may still be cancelled.
- **Stale drafts:** unsent drafts for the old cycle are superseded and `reminder_round` resets to 1.
- **Rollout:** live immediately, no dry-run phase. The user accepted this after the risk was raised; the mitigations below exist because of it.

## Algorithm

`reassignBadgeToLatestJob(env, tenantId, rule)` in `src/due-engine.js`, called from the nightly cron immediately before the recompute, for each badge-based rule.

1. Fetch completed jobs once via `listAllCompletedJobs`. This is the same fetch `listCompletedJobsForBadge` already performs, so the pass costs no additional API calls.
2. Drop warranty-category jobs, and drop any job with a blank address (see Risks).
3. Group by `company_uuid | normalizeStreet(job_address)` — the key the engine already uses.
4. Within each group, identify:
   - `badged` — jobs whose `parseBadges(job.badges)` includes `rule.servicem8_badge_uuid`
   - `latest` — the most recently completed job in the group
5. **If `badged` is empty, skip the group.** The pass only ever *relocates* a badge staff applied by hand; it never introduces tracking for a customer nobody chose to track.
6. If `latest` already carries the badge, skip. This is the common case and makes the whole pass a no-op once settled.
7. Otherwise:
   - Add the badge to `latest`, preserving its existing badges (read–modify–write over the parsed array, then `updateJobBadges`).
   - Remove the badge from every older job in `badged`, likewise preserving their other badges.
   - Log both sides of the move with job numbers and UUIDs.
8. Then in D1, set that customer's unsent (`pending`) drafts to `status = 'superseded'` and reset `reminder_round = 1`, clearing `last_reminder_sent_at`.

   The `due_customers` row is located by its natural key, which is the same grouping key already in hand — `UNIQUE(tenant_id, servicem8_company_uuid, address_key, category_config_id)`, using `rule.id` as the `category_config_id`. No uuid-to-row search is needed. If no row exists yet the step is simply skipped; the recompute that follows will create one against the new date.

   `dismissed_at` needs no handling here: it is already cleared automatically by the upsert once `last_completed_at` moves forward, which is precisely what a badge move causes.

`superseded` is a new status. It matches none of the dashboard's `pending` / `failed` / `sent` filters, so the drafts leave the queue automatically while remaining auditable — preferable to deleting them.

## Why the reminder sequence resets

A completed newer job means the customer was serviced. Leaving unsent "your treatment is due" drafts in the queue invites a staff member to send one to someone serviced last week. Resetting to round 1 means the next cycle starts cleanly from the new due date rather than resuming mid-chase.

## Safety properties

Required because this runs live against real ServiceM8 data with no dry run:

- **Idempotent.** Once `latest` carries the badge the pass does nothing, so a partially failed run simply completes on the next nightly cron. No state machine to unwind.
- **Never invents tracking.** Step 5 guarantees the set of tracked customers can only stay the same or consolidate — never grow.
- **Preserves unrelated badges.** Both the add and the remove are read–modify–write on the parsed array. `updateJobBadges` replaces the whole field, so blind writes would silently destroy other badges staff rely on.
- **Auditable.** Every move is logged with both job numbers, so Workers logs show exactly what was touched and when.

## Risks

**Address collision.** Two genuinely different properties whose addresses normalize to the same string are treated as one customer. The engine already makes this assumption for category rules, so the matching risk is not new — but the consequence is newly *visible*, because a badge move shows up in ServiceM8 where a wrong internal due date does not. Jobs with a blank address are excluded outright, since they would otherwise all collapse into a single per-company group.

**No dry run.** A wrong matching rule edits many jobs before anyone notices. Mitigated by idempotency (re-running is safe), by step 5 (scope cannot grow), and by per-move logging. Recommend watching the first nightly run's logs.

## Testing

- Unit-level, against a stubbed ServiceM8 client:
  - latest job already badged → no writes at all
  - newer non-warranty job exists → badge added to newer, removed from older, other badges on both left intact
  - newer job is warranty → no move
  - group has no badged job → no writes
  - multiple badged jobs in one group → consolidated onto the latest
  - job with blank address → excluded from grouping
- D1 side: pending drafts become `superseded` and `reminder_round` returns to 1; already-sent drafts are untouched.
- Confirm the dashboard renders nothing for a `superseded` draft.

## Out of scope

- Changing how category-based rules pick their job — they already behave correctly.
- Any UI for reviewing or undoing badge moves.
- Backfilling historical mis-tracked customers beyond what the nightly pass naturally corrects.
