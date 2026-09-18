import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RENEWAL_BADGES, planBadgeSync, planBadgeDedupe, ensureRenewalBadges } from "../src/due-engine.js";

const ORIGIN = "https://renewal-autopilot.phill-abb.workers.dev";

// ensureRenewalBadges hands these filenames straight to ServiceM8 as
// `fileUrl: origin/assets/images/<file>`. A stale filename (the previous
// version pointed at images deleted in a later upload/cleanup) means every
// newly created badge renders blank in ServiceM8 -- silently, since
// createBadge doesn't validate the URL. Guard against that drift by
// asserting the referenced file is actually the one shipped on disk.
const imagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/assets/images");

for (const { name, file } of RENEWAL_BADGES) {
  test(`"${name}" badge image ships in public/assets/images: ${file}`, () => {
    assert.ok(existsSync(path.join(imagesDir, file)), `${file} is missing from public/assets/images`);
  });
}

test("each renewal badge has a distinct name and file", () => {
  assert.equal(new Set(RENEWAL_BADGES.map((b) => b.name)).size, RENEWAL_BADGES.length);
  assert.equal(new Set(RENEWAL_BADGES.map((b) => b.file)).size, RENEWAL_BADGES.length);
});

// ensureRenewalBadges matches against existing ServiceM8 badges by exact
// name. TCB's live account already has these three, hand-made before this
// add-on existed ("3 month auto" / "6 month auto" / "1 year auto") -- any
// other spelling ("Renewal - 3 Month", different case, ...) misses that
// lookup and creates a duplicate badge with the generic placeholder image
// instead of reusing the real one.
test("badge names match TCB's existing live ServiceM8 badges exactly", () => {
  assert.deepEqual(
    RENEWAL_BADGES.map((b) => b.name),
    ["3 month auto", "6 month auto", "1 year auto"]
  );
});

// Regression coverage for the actual bug this fixes: a badge matched by name
// was never checked against RENEWAL_BADGES' file_name, so a sprite change
// (e.g. the v9 gray/yellow/green recolor) never reached an already-installed
// tenant's existing badges without someone manually running
// /debug/update-badge-images. planBadgeSync is what the new sweep in
// src/index.js's runBackfillAndRefreshSweep uses to do this automatically.
test("planBadgeSync: badge missing entirely gets created", () => {
  const { toCreate, toRefresh } = planBadgeSync([], RENEWAL_BADGES, ORIGIN);
  assert.deepEqual(
    toCreate.map((b) => b.name),
    RENEWAL_BADGES.map((b) => b.name)
  );
  assert.deepEqual(toRefresh, []);
});

test("planBadgeSync: badge already correct is left alone (steady-state no-op)", () => {
  const existing = RENEWAL_BADGES.map((b) => ({
    uuid: `uuid-${b.name}`,
    name: b.name,
    file_name: `${ORIGIN}/assets/images/${b.file}`,
  }));
  const { toCreate, toRefresh } = planBadgeSync(existing, RENEWAL_BADGES, ORIGIN);
  assert.deepEqual(toCreate, []);
  assert.deepEqual(toRefresh, []);
});

test("planBadgeSync: badge exists under the right name but a stale file_name (e.g. pre-v9) gets queued for refresh, not recreated", () => {
  const existing = [{ uuid: "existing-uuid", name: "3 month auto", file_name: `${ORIGIN}/assets/images/phill-3month-v8.png` }];
  const { toCreate, toRefresh } = planBadgeSync(existing, RENEWAL_BADGES, ORIGIN);
  assert.deepEqual(
    toCreate.map((b) => b.name),
    ["6 month auto", "1 year auto"]
  );
  assert.deepEqual(toRefresh, [{ name: "3 month auto", uuid: "existing-uuid", fileUrl: `${ORIGIN}/assets/images/phill-3month-v9.png` }]);
});

test("planBadgeSync: a badge with no file_name at all (hand-made, blank) gets queued for refresh", () => {
  const existing = [{ uuid: "existing-uuid", name: "1 year auto", file_name: null }];
  const { toRefresh } = planBadgeSync(existing, RENEWAL_BADGES, ORIGIN);
  assert.deepEqual(toRefresh, [{ name: "1 year auto", uuid: "existing-uuid", fileUrl: `${ORIGIN}/assets/images/phill-1year-v9.png` }]);
});

// ---- duplicate prevention ------------------------------------------------
//
// The live bug (TCB's account, 2026-09-07): three extra badges -- two more
// "6 month auto" and one more "1 year auto" -- appeared alongside the real
// ones created at install. None of the extras is the uuid category_config's
// tracking rules point at, so a job badged with one is invisible to the due
// engine. Every path below is what put them there or lets them persist.

test("planBadgeSync: an existing duplicate is reported, never recreated, and the oldest uuid stays canonical", () => {
  // ServiceM8 badge uuids are time-ordered, so the lowest-sorting one is the
  // original -- the uuid already wired into category_config and onto jobs.
  const existing = [
    { uuid: "01a07a50-newer", name: "6 month auto", file_name: `${ORIGIN}/assets/images/phill-6month-v9.png` },
    { uuid: "01a01433-older", name: "6 month auto", file_name: `${ORIGIN}/assets/images/phill-6month-v9.png` },
  ];
  const { toCreate, toRefresh, duplicates } = planBadgeSync(existing, RENEWAL_BADGES, ORIGIN);
  assert.deepEqual(
    toCreate.map((b) => b.name),
    ["3 month auto", "1 year auto"]
  );
  assert.deepEqual(toRefresh, []);
  assert.deepEqual(duplicates, [{ name: "6 month auto", uuid: "01a07a50-newer", canonicalUuid: "01a01433-older" }]);
});

test("planBadgeSync: only the canonical duplicate is refreshed, so a stale copy doesn't cause a write every run", () => {
  const existing = [
    { uuid: "01a01433-older", name: "1 year auto", file_name: `${ORIGIN}/assets/images/phill-1year-v8.png` },
    { uuid: "01a07a55-newer", name: "1 year auto", file_name: `${ORIGIN}/assets/images/phill-1year-v8.png` },
  ];
  const { toRefresh } = planBadgeSync(existing, RENEWAL_BADGES, ORIGIN);
  assert.deepEqual(toRefresh, [{ name: "1 year auto", uuid: "01a01433-older", fileUrl: `${ORIGIN}/assets/images/phill-1year-v9.png` }]);
});

test("planBadgeSync: a case/whitespace variant of the name matches instead of creating a second badge", () => {
  const existing = [{ uuid: "hand-made", name: " 6 Month Auto ", file_name: `${ORIGIN}/assets/images/phill-6month-v9.png` }];
  const { toCreate, toRefresh, duplicates } = planBadgeSync(existing, RENEWAL_BADGES, ORIGIN);
  assert.ok(!toCreate.some((b) => b.name === "6 month auto"));
  assert.deepEqual(toRefresh, []);
  assert.deepEqual(duplicates, []);
});

test("ensureRenewalBadges: a failed badge list creates nothing (the duplicate bug)", async () => {
  const created = [];
  const result = await ensureRenewalBadges({}, "tenant-1", ORIGIN, {
    listBadges: async () => {
      throw new Error("ServiceM8 API /badge.json failed: 429 rate limited");
    },
    createBadge: async (env, tenantId, { name }) => {
      created.push(name);
      return `new-${name}`;
    },
    updateBadge: async () => {},
  });
  assert.deepEqual(created, [], "a failed read must not look like an empty account");
  assert.deepEqual(result, {});
});

test("ensureRenewalBadges: an empty list from a successful read still provisions a fresh account", async () => {
  const created = [];
  const result = await ensureRenewalBadges({}, "tenant-1", ORIGIN, {
    listBadges: async () => [],
    createBadge: async (env, tenantId, { name }) => {
      created.push(name);
      return `new-${name}`;
    },
    updateBadge: async () => {},
  });
  assert.deepEqual(created, RENEWAL_BADGES.map((b) => b.name));
  assert.equal(result["6 month auto"], "new-6 month auto");
});

test("ensureRenewalBadges: returns the canonical uuid when duplicates exist, not the newest", async () => {
  const result = await ensureRenewalBadges({}, "tenant-1", ORIGIN, {
    listBadges: async () =>
      RENEWAL_BADGES.map((b) => ({ uuid: `01a01433-${b.file}`, name: b.name, file_name: `${ORIGIN}/assets/images/${b.file}` })).concat([
        { uuid: "01a07a50-dupe", name: "6 month auto", file_name: `${ORIGIN}/assets/images/phill-6month-v9.png` },
      ]),
    createBadge: async () => assert.fail("must not create when the badge already exists"),
    updateBadge: async () => assert.fail("everything is already in sync"),
  });
  assert.equal(result["6 month auto"], "01a01433-phill-6month-v9.png");
});

// ---- cleaning up the duplicates already in the account --------------------

test("planBadgeDedupe: jobs move onto the canonical badge, keeping their other badges", () => {
  const existing = [
    { uuid: "01a01433-older", name: "6 month auto", file_name: `${ORIGIN}/assets/images/phill-6month-v9.png` },
    { uuid: "01a07a50-newer", name: "6 month auto", file_name: `${ORIGIN}/assets/images/phill-6month-v9.png` },
  ];
  const jobs = [
    { uuid: "job-1", badges: JSON.stringify(["01a07a50-newer", "warranty-uuid"]) },
    { uuid: "job-2", badges: JSON.stringify(["01a01433-older"]) },
    { uuid: "job-3", badges: JSON.stringify(["unrelated-uuid"]) },
  ];
  const { duplicates, jobUpdates } = planBadgeDedupe(existing, RENEWAL_BADGES, jobs, ORIGIN);
  assert.deepEqual(duplicates.map((d) => d.uuid), ["01a07a50-newer"]);
  assert.deepEqual(jobUpdates, [{ jobUuid: "job-1", badges: ["01a01433-older", "warranty-uuid"] }]);
});

test("planBadgeDedupe: a job carrying both copies ends up with one", () => {
  const existing = [
    { uuid: "01a01433-older", name: "1 year auto", file_name: `${ORIGIN}/assets/images/phill-1year-v9.png` },
    { uuid: "01a07a55-newer", name: "1 year auto", file_name: `${ORIGIN}/assets/images/phill-1year-v9.png` },
  ];
  const jobs = [{ uuid: "job-1", badges: JSON.stringify(["01a01433-older", "01a07a55-newer"]) }];
  const { jobUpdates } = planBadgeDedupe(existing, RENEWAL_BADGES, jobs, ORIGIN);
  assert.deepEqual(jobUpdates, [{ jobUuid: "job-1", badges: ["01a01433-older"] }]);
});

test("planBadgeDedupe: a clean account is a no-op", () => {
  const existing = RENEWAL_BADGES.map((b) => ({
    uuid: `uuid-${b.name}`,
    name: b.name,
    file_name: `${ORIGIN}/assets/images/${b.file}`,
  }));
  const jobs = [{ uuid: "job-1", badges: JSON.stringify(["uuid-6 month auto"]) }];
  const { duplicates, jobUpdates } = planBadgeDedupe(existing, RENEWAL_BADGES, jobs, ORIGIN);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(jobUpdates, []);
});
