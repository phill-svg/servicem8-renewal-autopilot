import { test } from "node:test";
import assert from "node:assert/strict";
import { dueNowStartDate, bucketFor } from "../src/due-engine.js";

// "Due now" starts the day ServiceM8's own Job Reminder arrives: 4 weeks
// before the first Monday of the due month. Observed live: every customer due
// in November 2026 got their ServiceM8 reminder on Monday 5 October.

const due = (ymd) => new Date(`${ymd}T09:00:00Z`); // as parseServiceM8Date returns it
// The nightly recompute runs at ~3am Sydney = 16:00 UTC the previous day.
const sydney3am = (ymd) => new Date(new Date(`${ymd}T03:00:00+11:00`).getTime());

test("everyone due in November 2026 starts on Monday 5 October", () => {
  for (const d of ["2026-11-01", "2026-11-02", "2026-11-10", "2026-11-27", "2026-11-30"]) {
    assert.equal(dueNowStartDate(due(d)), "2026-10-05", d);
  }
});

test("other months: 4 weeks before that month's first Monday", () => {
  assert.equal(dueNowStartDate(due("2026-12-15")), "2026-11-09"); // first Monday 7 Dec
  assert.equal(dueNowStartDate(due("2027-02-20")), "2027-01-04"); // first Monday 1 Feb
  assert.equal(dueNowStartDate(due("2026-03-15")), "2026-02-02"); // first Monday 2 Mar
  assert.equal(dueNowStartDate(due("2026-08-20")), "2026-07-06"); // first Monday 3 Aug (SM8: "3rd August 2026")
});

test("the 3am Sydney run on the Monday flips them, not the day after", () => {
  const args = [60, 60, null, 90]; // due_soon, overdue grace, overdue max, due_later
  assert.equal(bucketFor(sydney3am("2026-10-04"), due("2026-11-27"), ...args), "due_soon", "Sunday");
  assert.equal(bucketFor(sydney3am("2026-10-05"), due("2026-11-27"), ...args), "due", "Monday");
});

test("the due date passing and overdue still work as before", () => {
  const args = [60, 60, null, 90];
  assert.equal(bucketFor(due("2026-12-05"), due("2026-12-01"), ...args), "due", "past due, inside grace");
  assert.equal(bucketFor(due("2027-02-15"), due("2026-12-01"), ...args), "overdue");
  assert.equal(bucketFor(due("2026-09-10"), due("2026-12-01"), ...args), "due_later");
});
