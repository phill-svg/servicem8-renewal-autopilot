import { test } from "node:test";
import assert from "node:assert/strict";
import { nextFollowUpDraftDate } from "../src/due-engine.js";
import { baseCustomer } from "./helpers/fixtures.js";

// baseCustomer's last service is 2025-08-06, so +12 months puts the due date
// at 2026-08-06. Round 2 drafts 5 days before that, round 3 two days before.
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

test("round 3 always lands closer to the due date than round 2", () => {
  const two = nextFollowUpDraftDate(baseCustomer({ reminder_round: 2 }), 12);
  const three = nextFollowUpDraftDate(baseCustomer({ reminder_round: 3 }), 12);
  assert.ok(three > two, "round 3 must be the later of the two");
});

test("round 1 has no scheduled auto-draft -- staff send it by hand", () => {
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 1 }), 12), null);
});

test("round 4 is the exhausted sequence and has none either", () => {
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 4 }), 12), null);
});

test("an unknown completion date or interval yields null", () => {
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 2, last_completed_at: null }), 12), null);
  assert.equal(nextFollowUpDraftDate(baseCustomer({ reminder_round: 2 }), undefined), null);
});
