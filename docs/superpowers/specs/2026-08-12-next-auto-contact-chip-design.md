# Next-auto-contact chip

**Date:** 2026-08-12
**Status:** approved, not yet implemented
**Scope:** display only — `src/dashboard.js` plus one exported helper in `src/due-engine.js`. No schema change, no external writes.

## Problem

A customer sitting in a Contacted tab gives staff no indication of what happens next. The engine will auto-draft the next reminder round on a schedule, but that schedule is invisible, so staff cannot tell the difference between "handled, the system will come back to this" and "this has gone quiet".

Worse, after the final round there is no next reminder at all — that customer is permanently silent, and nothing on screen says so.

## Key fact: the system drafts, it does not send

Rounds 2 and 3 are *auto-drafted* by the nightly cron and then wait in the queue for a staff member to approve and send. Nothing is sent without a human pressing the button.

The chip must therefore say **"drafts"**, never "sends". Wording that implies auto-sending would let staff assume a customer is being chased when they are not.

## Current schedule

From `FOLLOWUP_LEAD_DAYS` in `src/due-engine.js`, against `dueDate = last_completed_at + interval_months`:

| Round | Draft appears | Notes |
|---|---|---|
| 1 | when the customer first becomes due | created by the due-detection path, sent manually |
| 2 | 5 days before the due date | auto-drafted |
| 3 | 2 days before the due date | auto-drafted, final |
| 4+ | never | sequence exhausted |

`reminder_round` holds the **next** round to send, so a customer showing "Contacted 1" is at `reminder_round = 2`.

Only customers with `reminder_round IN (2, 3)`, no `suppressed_reason` and no `dismissed_at` are considered by `generateFollowUpDraftsForTenant`.

## Approach

Export one helper from `due-engine.js` and use it for **both** the generate decision and the display, so the two can never disagree:

```js
export function nextFollowUpDraftDate(dueCustomer, intervalMonths)
  // → null  when reminder_round is 1 or >= 4, or the date/interval is unknown
  // → Date  otherwise: lastCompleted + intervalMonths - FOLLOWUP_LEAD_DAYS[round]
```

`maybeCreateFollowUpDraft` is refactored to call it instead of computing the same date inline. This removes duplicated arithmetic rather than adding a second copy of it.

Rejected alternatives:

- **Recompute the date in `dashboard.js`.** Same output today, but `FOLLOWUP_LEAD_DAYS` would exist in two files and drift the moment the schedule is tuned — the chip would then confidently display a wrong date.
- **Store a `next_reminder_at` column.** Migration plus a write path, and it goes stale whenever `last_completed_at` or the interval changes. Denormalising a value that is cheap to derive.

## Display

Rendered **only on Contacted rows** (`alreadyContacted === true`). Rows in an urgency bucket already have a draft waiting now, so a future date would be noise.

Placed **outside** `<details class="draft-wrap">`, next to the first-contact chip. The composer is collapsed by default and now appears on nearly every row; anything inside it is invisible in practice. This is the defect fixed on 2026-08-12 in the delivery-chip work and must not be reintroduced.

| Situation | Chip | Style |
|---|---|---|
| Round 2 or 3, date in the future | `Next reminder drafts 15/09/2026 · in 3w` | neutral |
| Round 2 or 3, date already passed | `Next reminder drafts tonight` | neutral |
| Round 4+ — sequence exhausted | `Final reminder sent — nothing further scheduled` | amber warning |
| Date not derivable | no chip | — |

"Date already passed" means the trigger date has arrived but the nightly cron has not run since. Once it runs, the draft exists, the customer leaves Contacted and returns to an urgency bucket — so this state is short-lived by design.

The amber exhausted-state chip is the point of the feature as much as the date is: it makes a permanently silent customer visible so they can be chased by hand or dismissed.

Tooltip carries the full explanation, including that the row will move back out of Contacted when the draft appears.

## Reuse

- `dueChipText()` for the relative time ("in 3w"), matching the Next-due column.
- `formatJsDate()` for the date, likewise.

Both operate on a `Date` produced by date-only arithmetic on a parsed ServiceM8 date, so no timezone handling is involved. Note this is deliberately **not** `formatEpochAu`, which is for epoch-ms send timestamps.

## Testing

Extend the existing render harness with a row per state: future trigger, passed trigger, exhausted sequence, and underivable date.

Assert **position**, not just presence — each chip must appear before `<details class="draft-wrap">` in its row. A presence-only assertion passes even when a chip is buried inside the collapsed composer, which is exactly how the delivery chips shipped invisible.

## Out of scope

- Auto-sending rounds 2 and 3 without approval. Considered and explicitly deferred on 2026-08-12; the current design is display-only.
- Changing the 5/2-day lead times or the number of rounds.
