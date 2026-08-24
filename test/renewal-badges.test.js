import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RENEWAL_BADGES, planBadgeSync } from "../src/due-engine.js";

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
