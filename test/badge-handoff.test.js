import { test } from "node:test";
import assert from "node:assert/strict";
import { planBadgeMoves } from "../src/due-engine.js";

const BADGE = "badge-renewal-12mo";
const OTHER_BADGE = "badge-something-else";
const WARRANTY = new Set(["cat-warranty"]);

// ServiceM8 returns `badges` as a JSON-encoded string, not a real array --
// the production quirk parseBadges exists for. Fixtures mimic that so these
// tests exercise the same parsing path as live data.
function job({ uuid, number, completed, badges = [], company = "co1", address = "1 Test St, Canberra", category = "cat-pest" }) {
  return {
    uuid,
    generated_job_id: number,
    company_uuid: company,
    job_address: address,
    completion_date: completed,
    category_uuid: category,
    badges: JSON.stringify(badges),
  };
}

const OLD = { uuid: "old", number: "100", completed: "2025-08-06 09:00:00" };
const NEW = { uuid: "new", number: "101", completed: "2026-02-01 09:00:00" };

test("plans a move to the newer job and clears the old one", () => {
  const moves = planBadgeMoves([job({ ...OLD, badges: [BADGE] }), job(NEW)], BADGE, WARRANTY);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].addTo.uuid, "new");
  assert.deepEqual(moves[0].removeFrom.map((j) => j.uuid), ["old"]);
  assert.equal(moves[0].dateChanged, true);
});

test("groups by company and address, exposing the due_customers natural key", () => {
  const moves = planBadgeMoves([job({ ...OLD, badges: [BADGE] }), job(NEW)], BADGE, WARRANTY);
  assert.equal(moves[0].companyUuid, "co1");
  assert.equal(moves[0].addressKey, "1 test st");
});

test("does nothing when the latest job already carries the badge", () => {
  const moves = planBadgeMoves([job(OLD), job({ ...NEW, badges: [BADGE] })], BADGE, WARRANTY);
  assert.deepEqual(moves, [], "the common case must plan no writes at all");
});

test("never introduces tracking for a customer with no badged job", () => {
  const moves = planBadgeMoves([job(OLD), job(NEW)], BADGE, WARRANTY);
  assert.deepEqual(moves, []);
});

test("a warranty callback does not take the badge", () => {
  const moves = planBadgeMoves(
    [job({ ...OLD, badges: [BADGE] }), job({ ...NEW, category: "cat-warranty" })],
    BADGE,
    WARRANTY
  );
  assert.deepEqual(moves, [], "warranty jobs must not push the renewal out");
});

test("a job at a different address does not take the badge", () => {
  const moves = planBadgeMoves(
    [job({ ...OLD, badges: [BADGE] }), job({ ...NEW, address: "99 Other Rd, Canberra" })],
    BADGE,
    WARRANTY
  );
  assert.deepEqual(moves, []);
});

test("a job for a different company does not take the badge", () => {
  const moves = planBadgeMoves([job({ ...OLD, badges: [BADGE] }), job({ ...NEW, company: "co2" })], BADGE, WARRANTY);
  assert.deepEqual(moves, []);
});

test("jobs with a blank address are excluded rather than grouped together", () => {
  const moves = planBadgeMoves(
    [job({ ...OLD, badges: [BADGE], address: "" }), job({ ...NEW, address: "" })],
    BADGE,
    WARRANTY
  );
  assert.deepEqual(moves, [], "a blank address must not collapse a company's jobs into one group");
});

test("consolidates multiple badged jobs onto the latest", () => {
  const moves = planBadgeMoves(
    [
      job({ uuid: "old1", number: "100", completed: "2024-08-06 09:00:00", badges: [BADGE] }),
      job({ uuid: "old2", number: "101", completed: "2025-08-06 09:00:00", badges: [BADGE] }),
      job({ uuid: "new", number: "102", completed: "2026-02-01 09:00:00" }),
    ],
    BADGE,
    WARRANTY
  );
  assert.equal(moves[0].addTo.uuid, "new");
  assert.deepEqual(moves[0].removeFrom.map((j) => j.uuid).sort(), ["old1", "old2"]);
});

// If a previous run added the badge to the newer job but died before clearing
// the older one, the stale badge must be cleaned up rather than stranded.
test("heals a half-finished previous run without rewriting the correct job", () => {
  const moves = planBadgeMoves([job({ ...OLD, badges: [BADGE] }), job({ ...NEW, badges: [BADGE] })], BADGE, WARRANTY);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].addTo, null, "the already-correct job must not be rewritten");
  assert.deepEqual(moves[0].removeFrom.map((j) => j.uuid), ["old"]);
  assert.equal(moves[0].dateChanged, false, "tidying a duplicate is not a date change");
});

test("only considers the rule's own badge", () => {
  const moves = planBadgeMoves([job({ ...OLD, badges: [OTHER_BADGE] }), job(NEW)], BADGE, WARRANTY);
  assert.deepEqual(moves, []);
});

test("a job with no completion date cannot become the latest", () => {
  const moves = planBadgeMoves(
    [job({ ...OLD, badges: [BADGE] }), job({ uuid: "nodate", number: "9", completed: null })],
    BADGE,
    WARRANTY
  );
  assert.deepEqual(moves, [], "the badged job is still the newest datable one");
});

test("handles independent customers in one pass", () => {
  const moves = planBadgeMoves(
    [
      job({ ...OLD, badges: [BADGE] }),
      job(NEW),
      job({ uuid: "b-old", number: "200", completed: "2025-01-01 09:00:00", badges: [BADGE], company: "co2", address: "5 Elm St" }),
      job({ uuid: "b-new", number: "201", completed: "2026-03-01 09:00:00", company: "co2", address: "5 Elm St" }),
    ],
    BADGE,
    WARRANTY
  );
  assert.equal(moves.length, 2);
  assert.deepEqual(moves.map((m) => m.addTo.uuid).sort(), ["b-new", "new"]);
});
