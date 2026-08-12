import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStreet } from "../src/due-engine.js";

// The whole engine groups jobs into "one customer at one property" with this,
// so a collision silently merges two homes -- and since the badge hand-off, it
// would move a badge across them in ServiceM8.
test("a unit address does not collapse into a different street number", () => {
  const unit = normalizeStreet("2/9 Hopman Pl\nHolt ACT 2615");
  const house = normalizeStreet("29 Hopman Pl\nHolt ACT 2615");
  assert.notEqual(unit, house, "2/9 and 29 Hopman Pl must not be the same customer");
});

test("keeps the slash so the unit number survives", () => {
  assert.equal(normalizeStreet("2/9 Hopman Pl\nHolt ACT 2615"), "2/9 hopman plholt act 2615");
});

test("the same address still normalises to the same key", () => {
  assert.equal(normalizeStreet("2/9 Hopman Pl\nHolt ACT 2615"), normalizeStreet("2/9 hopman pl\nholt act 2615"));
});

test("splits on a comma so a trailing suburb is dropped", () => {
  assert.equal(normalizeStreet("Unit 18/11 Starcevich Cres,\nJacka ACT 2914"), "unit 18/11 starcevich cres");
});

test("empty and missing addresses yield an empty key, which callers skip", () => {
  assert.equal(normalizeStreet(""), "");
  assert.equal(normalizeStreet(null), "");
  assert.equal(normalizeStreet(undefined), "");
});
