import { test } from "node:test";
import assert from "node:assert/strict";
import { planLegacyBadgeMigration } from "../src/due-engine.js";

const FROM = "follow-up-uuid";
const TO = "auto-uuid";

// ServiceM8 returns `badges` as a JSON-encoded string, not a real array --
// fixtures mimic that so these tests exercise the same parsing path as live
// data (see badge-handoff.test.js's job() helper for the same convention).
function job(uuid, badges) {
  return { uuid, badges: JSON.stringify(badges) };
}

test("a job carrying the old badge but not the new one is queued for migration", () => {
  const toMigrate = planLegacyBadgeMigration([job("j1", [FROM])], FROM, TO);
  assert.deepEqual(toMigrate.map((j) => j.uuid), ["j1"]);
});

test("a job already carrying both badges is left alone", () => {
  const toMigrate = planLegacyBadgeMigration([job("j1", [FROM, TO])], FROM, TO);
  assert.deepEqual(toMigrate, []);
});

test("a job carrying neither badge is left alone", () => {
  const toMigrate = planLegacyBadgeMigration([job("j1", ["some-other-badge"])], FROM, TO);
  assert.deepEqual(toMigrate, []);
});

test("a job carrying only the new badge is left alone", () => {
  const toMigrate = planLegacyBadgeMigration([job("j1", [TO])], FROM, TO);
  assert.deepEqual(toMigrate, []);
});

test("other badges on the job are irrelevant to the decision either way", () => {
  const toMigrate = planLegacyBadgeMigration([job("j1", [FROM, "unrelated-badge"])], FROM, TO);
  assert.deepEqual(toMigrate.map((j) => j.uuid), ["j1"]);
});

test("handles a mixed batch, migrating only the ones that need it", () => {
  const jobs = [
    job("needs-migration", [FROM]),
    job("already-migrated", [FROM, TO]),
    job("unrelated", ["something-else"]),
  ];
  const toMigrate = planLegacyBadgeMigration(jobs, FROM, TO);
  assert.deepEqual(toMigrate.map((j) => j.uuid), ["needs-migration"]);
});

test("an empty job list produces nothing to migrate", () => {
  assert.deepEqual(planLegacyBadgeMigration([], FROM, TO), []);
});
