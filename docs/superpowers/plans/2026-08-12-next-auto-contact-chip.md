# Next-auto-contact Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every Contacted customer when their next reminder will be auto-drafted, and flag the ones whose reminder sequence has run out.

**Architecture:** One date helper is exported from `src/due-engine.js` and used by both the engine (to decide when to generate a follow-up draft) and the dashboard (to display that same date), so the two can never disagree. `src/dashboard.js` renders a chip from it. Display only — no schema change, no writes to ServiceM8.

**Tech Stack:** Cloudflare Workers (ESM JavaScript), D1, Wrangler 4. Tests use Node's built-in `node:test` runner — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-12-next-auto-contact-chip-design.md`

## Global Constraints

- The chip must say **"drafts"**, never "sends". Rounds 2 and 3 are auto-drafted and wait for staff approval; nothing is auto-sent.
- Any chip staff must see has to render **outside** `<details class="draft-wrap">`. That element is collapsed by default and appears on nearly every row, so anything inside it is invisible in practice.
- Dates here come from date-only arithmetic on a parsed ServiceM8 date. Use `formatJsDate`, **not** `formatEpochAu` (which is for epoch-ms send timestamps).
- Australian date format throughout: `DD/MM/YYYY`.
- No new npm dependencies.

---

### Task 1: Test harness

Establishes a runnable test suite where none exists, and locks in current dashboard behaviour before anything changes.

**Files:**
- Modify: `package.json`
- Create: `test/helpers/fixtures.js`
- Create: `test/dashboard-render.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `makeEnv({ customers, drafts, rules })` returning a stub with a `DB.prepare().bind().all()/.first()` chain; `baseCustomer(overrides)` and `baseDraft(overrides)` fixture builders. Later tasks import these from `../helpers/fixtures.js` and `./helpers/fixtures.js` respectively.

- [ ] **Step 1: Add the test script and ESM type**

In `package.json`, add `"type": "module"` at the top level and a `test` script:

```json
{
  "name": "renewal-autopilot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "tracks recurring-service due dates per customer and queues renewal reminders for staff approval.",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "node --test test/",
    "db:init": "wrangler d1 execute renewal-autopilot-db --local --file=./schema.sql",
    "db:init:remote": "wrangler d1 execute renewal-autopilot-db --remote --file=./schema.sql"
  },
  "devDependencies": {
    "wrangler": "^4.112.0"
  }
}
```

`"type": "module"` matches how `src/*.js` is already written and silences Node's reparse warning.

- [ ] **Step 2: Verify the build still works with "type": "module"**

Run: `npx wrangler deploy --dry-run`
Expected: `Total Upload: ...` with no error. If this fails, remove `"type": "module"` and rename test files to `.mjs` instead.

- [ ] **Step 3: Write the fixtures helper**

Create `test/helpers/fixtures.js`:

```js
// Minimal stand-ins for the D1 rows renderDashboardHtml reads. Only the
// columns the dashboard actually touches are present -- adding the rest
// would just be noise that drifts from schema.sql.
export function baseCustomer(overrides = {}) {
  return {
    id: "cust1",
    tenant_id: "t",
    category_config_id: "cfg1",
    servicem8_company_uuid: "co1",
    address_key: "1 test st",
    address_display: "1 Test St",
    servicem8_category_uuid: "cat1",
    last_job_uuid: "job1",
    last_job_number: "357",
    last_completed_at: "2025-08-06 09:00:00",
    bucket: "due",
    suppressed_reason: null,
    dismissed_at: null,
    contact_name_cache: "Test Customer",
    contact_email_cache: "test@example.com",
    contact_phone_cache: "0412345678",
    last_job_notes_cache: null,
    reminder_round: 1,
    last_reminder_sent_at: null,
    ...overrides,
  };
}

export function baseDraft(overrides = {}) {
  return {
    id: "draft1",
    tenant_id: "t",
    due_customer_id: "cust1",
    channel: "sms",
    round: 1,
    draft_subject: null,
    draft_body: "hello",
    status: "pending",
    created_at: 1786000000000,
    sent_at: null,
    delivery_status: null,
    opened_at: null,
    error: null,
    ...overrides,
  };
}

// Stubs the D1 binding by matching on table name in the SQL text, which is
// how renderDashboardHtml's three queries differ from each other.
export function makeEnv({ customers = [], drafts = [], rules = [{ id: "cfg1", interval_months: 12 }] } = {}) {
  function rowsFor(sql) {
    if (sql.includes("due_customers")) return customers;
    if (sql.includes("reminder_drafts")) return drafts;
    if (sql.includes("category_config")) return rules;
    return [];
  }
  return {
    DB: {
      prepare(sql) {
        const q = {
          bind: () => q,
          all: async () => ({ results: rowsFor(sql) }),
          first: async () => rowsFor(sql)[0] || null,
        };
        return q;
      },
    },
  };
}

// Splits rendered HTML into one string per customer row.
export function rowsOf(html) {
  return html.split('<tr class="job-row"').slice(1);
}

// The row for a given customer name, or undefined.
export function rowFor(html, name) {
  return rowsOf(html).find((r) => r.includes(`>${name}<`));
}

// True when `needle` appears before the collapsed composer in this row --
// i.e. staff can see it without expanding anything.
export function isVisible(row, needle) {
  const at = row.indexOf(needle);
  if (at === -1) return false;
  const details = row.indexOf('<details class="draft-wrap"');
  return details === -1 || at < details;
}
```

- [ ] **Step 4: Write the characterisation test**

Create `test/dashboard-render.test.js`. This asserts the delivery chips shipped on 2026-08-12 and, crucially, that they are visible:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/dashboard.js";
import { makeEnv, baseCustomer, baseDraft, rowFor, isVisible } from "./helpers/fixtures.js";

test("an opened email shows a green chip with the open time", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Opened Once", reminder_round: 2 })],
    drafts: [baseDraft({ status: "sent", sent_at: 1785975576662, delivery_status: "confirmed", opened_at: "2026-08-06 11:35:28", channel: "email" })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Opened Once");
  assert.match(row, /EMAIL opened 06\/08\/2026 11:35/);
  assert.ok(isVisible(row, "opened-chip"), "opened chip must not be hidden inside the composer");
});

test("a confirmed delivery shows delivered, not sent", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Delivered Only", reminder_round: 2 })],
    drafts: [baseDraft({ status: "sent", sent_at: 1786485399259, delivery_status: "confirmed" })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Delivered Only");
  assert.match(row, /SMS delivered/);
  assert.ok(isVisible(row, "delivered-chip"));
});

test("an unverified send shows sent, and never claims SMS was received", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Just Sent", reminder_round: 2 })],
    drafts: [baseDraft({ status: "sent", sent_at: 1786515503154, delivery_status: null })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Just Sent");
  assert.match(row, /SMS sent/);
  assert.ok(isVisible(row, "sent-chip"));
  assert.doesNotMatch(html, /SMS received/);
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: 3 tests pass. `renderDashboardHtml` logs a category-lookup error to stderr because there are no OAuth tokens for the stub tenant; that is caught and handled in the source and does not fail the test.

- [ ] **Step 6: Commit**

```bash
git add package.json test/
git commit -m "Add a test harness and lock in the dashboard delivery chips"
```

---

### Task 2: The shared date helper

One function, used by both the engine's generate decision and the dashboard's display.

**Files:**
- Modify: `src/due-engine.js` (add export near `FOLLOWUP_LEAD_DAYS` ~line 390; rewrite `maybeCreateFollowUpDraft` ~lines 407-416)
- Create: `test/next-followup-date.test.js`

**Interfaces:**
- Consumes: `baseCustomer` from `./helpers/fixtures.js`.
- Produces: `nextFollowUpDraftDate(dueCustomer, intervalMonths) -> Date | null`, exported from `src/due-engine.js`. Task 3 imports it into `src/dashboard.js`.

- [ ] **Step 1: Write the failing test**

Create `test/next-followup-date.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextFollowUpDraftDate } from "../src/due-engine.js";
import { baseCustomer } from "./helpers/fixtures.js";

// last service 2025-08-06 + 12 months = due 2026-08-06.
// Round 2 drafts 5 days before that, round 3 drafts 2 days before.
test("round 2 drafts five days before the due date", () => {
  const at = nextFollowUpDraftDate(baseCustomer({ reminder_round: 2 }), 12);
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 7); // August
  assert.equal(at.getDate(), 1);
});

test("round 3 drafts two days before the due date", () => {
  const at = nextFollowUpDraftDate(baseCustomer({ reminder_round: 3 }), 12);
  assert.equal(at.getDate(), 4);
});

test("round 1 has no scheduled auto-draft", () => {
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 1 }), 12), null);
});

test("round 4 is the exhausted sequence and has none either", () => {
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 4 }), 12), null);
});

test("an unknown completion date or interval yields null", () => {
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 2, last_completed_at: null }), 12), null);
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 2 }), undefined), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `SyntaxError: The requested module '../src/due-engine.js' does not provide an export named 'nextFollowUpDraftDate'`

- [ ] **Step 3: Add the helper**

In `src/due-engine.js`, directly beneath the `FOLLOWUP_LEAD_DAYS` declaration, add:

```js
// The date the next auto-drafted follow-up is due to appear: the customer's
// due date, minus this round's lead time. Exported because the dashboard
// shows staff this exact date -- deriving it there instead would duplicate
// FOLLOWUP_LEAD_DAYS and let the display drift from what the engine really
// does the moment the schedule is tuned.
//
// Returns null when no round is scheduled: round 1 is sent by hand, and
// round 4 means the sequence is exhausted and nothing further will ever be
// generated.
export function nextFollowUpDraftDate(dueCustomer, intervalMonths) {
  const leadDays = FOLLOWUP_LEAD_DAYS[dueCustomer.reminder_round];
  if (!leadDays || !intervalMonths) return null;
  const completedAt = parseServiceM8Date(dueCustomer.last_completed_at);
  if (!completedAt) return null;
  return addDays(addMonths(completedAt, intervalMonths), -leadDays);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass (3 from Task 1 + 5 new).

- [ ] **Step 5: Make the engine use it**

Replace the opening of `maybeCreateFollowUpDraft` in `src/due-engine.js` so the trigger date comes from the helper rather than being recomputed. Change:

```js
  const round = dueCustomer.reminder_round;
  const leadDays = FOLLOWUP_LEAD_DAYS[round];
  if (!leadDays) return; // round 1 (not sent yet) or round 4+ (sequence already exhausted)

  const completedAt = parseServiceM8Date(dueCustomer.last_completed_at);
  if (!completedAt) return;
  const dueDate = addMonths(completedAt, intervalMonths);
  const triggerFrom = addDays(dueDate, -leadDays);
  if (new Date() < triggerFrom) return; // not time yet for this round
```

to:

```js
  const round = dueCustomer.reminder_round;
  const triggerFrom = nextFollowUpDraftDate(dueCustomer, intervalMonths);
  if (!triggerFrom) return; // round 1 (sent by hand) or round 4+ (sequence exhausted)
  if (new Date() < triggerFrom) return; // not time yet for this round
```

`round` is still used further down to pick the template, so it stays.

- [ ] **Step 6: Verify nothing else broke**

Run: `npm test && npx wrangler deploy --dry-run`
Expected: all tests pass; build reports `Total Upload: ...`.

- [ ] **Step 7: Commit**

```bash
git add src/due-engine.js test/next-followup-date.test.js
git commit -m "Derive the follow-up trigger date from one shared helper"
```

---

### Task 3: Render the chip

**Files:**
- Modify: `src/dashboard.js` (imports ~line 7; icons ~line 64; row builder ~lines 170-310; CSS ~line 455)
- Create: `test/next-reminder-chip.test.js`

**Interfaces:**
- Consumes: `nextFollowUpDraftDate` from `./due-engine.js`; fixtures from `./helpers/fixtures.js`.
- Produces: no new exports. Renders `.next-chip` and `.next-chip.warn` inside a `.sent-row`.

- [ ] **Step 1: Write the failing test**

Create `test/next-reminder-chip.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/dashboard.js";
import { makeEnv, baseCustomer, baseDraft, rowFor, isVisible } from "./helpers/fixtures.js";

// A contacted customer: one sent draft, nothing left pending.
function contacted(overrides = {}) {
  return baseCustomer({ reminder_round: 2, ...overrides });
}
const sentDraft = baseDraft({ status: "sent", sent_at: 1786485399259, delivery_status: "confirmed" });

test("a future auto-draft shows its date and a relative time", async () => {
  // Completed 2199-01-01 keeps the trigger date far in the future regardless
  // of when this test runs, so it can never flip to the 'tonight' branch.
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "Future Draft", last_completed_at: "2199-01-01 09:00:00" })],
    drafts: [sentDraft],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Future Draft");
  assert.match(row, /Next reminder drafts 27\/12\/2199/);
  assert.ok(isVisible(row, "next-chip"), "next-reminder chip must not be hidden inside the composer");
});

test("a trigger date already passed says tonight", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "Overdue Draft", last_completed_at: "2020-01-01 09:00:00" })],
    drafts: [sentDraft],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Overdue Draft");
  assert.match(row, /Next reminder drafts tonight/);
  assert.ok(isVisible(row, "next-chip"));
});

test("an exhausted sequence is flagged as having nothing scheduled", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "All Done", reminder_round: 4 })],
    drafts: [sentDraft],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "All Done");
  assert.match(row, /nothing further scheduled/);
  assert.ok(isVisible(row, "next-chip warn"));
});

test("a customer still awaiting their first send gets no chip", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Not Yet", reminder_round: 1 })],
    drafts: [baseDraft({ status: "pending" })],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Not Yet");
  assert.doesNotMatch(row, /next-chip/);
});

test("the chip never claims the reminder sends itself", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "Wording", last_completed_at: "2199-01-01 09:00:00" })],
    drafts: [sentDraft],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Wording");
  assert.doesNotMatch(row, /auto-?sends|will be sent automatically/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — the `Next reminder drafts` assertions fail because no chip is rendered yet.

- [ ] **Step 3: Import the helper and add the icon**

In `src/dashboard.js`, add to the imports at the top:

```js
import { nextFollowUpDraftDate } from "./due-engine.js";
```

(`due-engine.js` imports only `util.js` and `servicem8-api.js`, so this introduces no import cycle.)

Beside the other icon constants (~line 64) add:

```js
const IC_CLOCK = `<svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
```

- [ ] **Step 4: Add the chip builder**

In `src/dashboard.js`, above `renderDashboardHtml`, add:

```js
// What happens next for a customer who has already been contacted. Rounds 2
// and 3 are auto-DRAFTED by the nightly cron and then wait for a human to
// approve them -- so this says "drafts", never "sends". Claiming otherwise
// would let staff assume a customer is being chased when nobody has pressed
// the button.
//
// After round 3 nothing further is ever generated, and that customer goes
// silent permanently unless someone notices -- hence the warning variant,
// which is as much the point of this chip as the date is.
function nextReminderChip(r, intervalMonths) {
  if ((r.reminder_round || 1) >= 4) {
    return `<div class="sent-row"><span class="next-chip warn" title="All three reminders have been sent. Nothing further is scheduled for this customer -- chase them by hand, or dismiss the row.">&#9888; Final reminder sent &mdash; nothing further scheduled</span></div>`;
  }
  const at = nextFollowUpDraftDate(r, intervalMonths);
  if (!at) return "";
  const days = Math.round((at.getTime() - Date.now()) / 86400000);
  const tip = "The next reminder is drafted automatically on this date and waits here for you to approve and send it. This row moves back into its urgency tab when that happens.";
  const label =
    days > 0
      ? `Next reminder drafts ${escapeHtml(formatJsDate(at))} &middot; ${escapeHtml(dueChipText(days))}`
      : "Next reminder drafts tonight";
  return `<div class="sent-row"><span class="next-chip" title="${escapeHtml(tip)}">${IC_CLOCK}${label}</span></div>`;
}
```

- [ ] **Step 5: Call it from the row builder**

In `src/dashboard.js`, immediately after the line that computes `alreadyContacted` (`const alreadyContacted = everSent && !pendingChannels.length;`), add:

```js
      // Only Contacted rows: a row still in an urgency bucket has a draft
      // waiting right now, so a future date there would just be noise.
      const nextNote = alreadyContacted ? nextReminderChip(r, intervalByConfig.get(r.category_config_id)) : "";
```

Then add `nextNote` to **both** `draftHtml` branches, after `sentNote`.

Change the no-composer branch from:

```js
        draftHtml = failedNote + firstContactNote + (sentNote || (drafts.length ? "" : `<div class="draft-none">No draft yet</div>`));
```

to:

```js
        draftHtml = failedNote + firstContactNote + (sentNote || (drafts.length ? "" : `<div class="draft-none">No draft yet</div>`)) + nextNote;
```

And the composer branch from:

```js
        draftHtml = `${failedNote}${firstContactNote}${sentNote}<details class="draft-wrap">
```

to:

```js
        draftHtml = `${failedNote}${firstContactNote}${sentNote}${nextNote}<details class="draft-wrap">
```

Both keep the chip outside the collapsed composer, per the global constraint.

- [ ] **Step 6: Add the styles**

In the `<style>` block of `src/dashboard.js`, beneath the `.delivered-chip` rule, add:

```css
  /* What the system will do next, unprompted. Deliberately quieter than the
     delivery chips -- it reports a schedule, not an outcome. */
  .next-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 650; color: #475569; background: #f1f5f9; border: 1px solid var(--line-2); border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; }
  .next-chip .ic { color: var(--faint); }
  /* The sequence has run out: this customer will never be contacted again
     unless a human acts, so it earns a warning colour. */
  .next-chip.warn { color: #92400e; background: #fef3c7; border-color: #fde68a; }
  .next-chip.warn .ic { color: #b45309; }
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: all pass (3 + 5 + 5 = 13 tests).

- [ ] **Step 8: Build**

Run: `npx wrangler deploy --dry-run`
Expected: `Total Upload: ...`, no errors.

- [ ] **Step 9: Commit**

```bash
git add src/dashboard.js test/next-reminder-chip.test.js
git commit -m "Show contacted customers when their next reminder is drafted"
```

---

### Task 4: Deploy and verify against live data

**Files:** none modified.

**Interfaces:**
- Consumes: the deployed Worker.
- Produces: confirmation the chip renders for the 12 real Contacted customers.

- [ ] **Step 1: Confirm what the live data should produce**

Run:

```bash
npx wrangler d1 execute renewal-autopilot-db --remote --command "SELECT reminder_round, COUNT(*) FROM due_customers WHERE suppressed_reason IS NULL AND dismissed_at IS NULL GROUP BY reminder_round"
```

Expected: rows for `reminder_round` 2 and 3 (12 customers total as of 2026-08-12). Those are the rows that should gain a chip. Note the counts.

- [ ] **Step 2: Deploy**

Run: `npx wrangler deploy`
Expected: `Deployed renewal-autopilot triggers` and a new Version ID.

Note: pushing to `master` also deploys via the Cloudflare Workers Git integration, so deploying by hand here is only to see it immediately.

- [ ] **Step 3: Verify the deployed bundle carries the chip**

Confirm the built output contains `next-chip` and that the chip precedes the composer in the template:

```bash
npx wrangler deploy --dry-run --outdir /tmp/ra-verify && grep -c "next-chip" /tmp/ra-verify/index.js && grep -o 'sentNote}\${nextNote}<details' /tmp/ra-verify/index.js
```

Expected: a non-zero count, and the `sentNote}${nextNote}<details` fragment printed — proving the chip renders outside the collapsed composer.

- [ ] **Step 4: Eyeball the real dashboard**

Open the dashboard, switch to the **Contacted 1** tab, and confirm each row shows a `Next reminder drafts DD/MM/YYYY` chip without expanding anything.

If any Contacted row shows no chip, that customer has no derivable due date — check their `last_completed_at` and their rule's `interval_months` before assuming a bug.

- [ ] **Step 5: Commit nothing, report**

No code change in this task. Report the deployed Version ID and the number of Contacted rows now showing a chip.

---

## Notes for the implementer

- **Run `npm test` after every change.** The suite is fast and the position assertions are the only thing standing between a working chip and one nobody can see.
- `renderDashboardHtml` logs `failed to load categories` to stderr under test. That is expected — there are no OAuth tokens for a stub tenant, the source catches it, and service names fall back to "Unknown".
- Do not reach for `formatEpochAu` here. It formats epoch milliseconds in the Australia/Sydney zone and is for send timestamps; this chip's date comes from date-only arithmetic and uses `formatJsDate`.
- The badge hand-off is a **separate** plan against `docs/superpowers/specs/2026-08-12-badge-handoff-design.md`. Do not start it here; it writes to ServiceM8 and needs its own review.
