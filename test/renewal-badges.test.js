import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RENEWAL_BADGES } from "../src/due-engine.js";

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
