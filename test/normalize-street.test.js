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
  assert.equal(normalizeStreet("2/9 Hopman Pl\nHolt ACT 2615"), "2/9 hopman place holt 2615");
});

test("the same address still normalises to the same key", () => {
  assert.equal(normalizeStreet("2/9 Hopman Pl\nHolt ACT 2615"), normalizeStreet("2/9 hopman pl\nholt act 2615"));
});

test("keeps the suburb and postcode, dropping the state", () => {
  assert.equal(normalizeStreet("Unit 18/11 Starcevich Cres,\nJacka ACT 2914"), "18/11 starcevich crescent jacka 2914");
});

// Elizabeth Zaja, 2026-10-06: the online booking wrote "23 Joyner Cr" where
// her original job said "23 Joyner Crescent", so the new job never counted
// and she stayed "due" after being serviced.
test("abbreviated and full street types are the same property", () => {
  const key = "23 joyner crescent flynn 2615";
  assert.equal(normalizeStreet("23 Joyner Crescent\nFlynn ACT 2615"), key);
  assert.equal(normalizeStreet("23 Joyner Cr\nFlynn ACT 2615"), key);
  assert.equal(normalizeStreet("23 Joyner Cres, Flynn ACT 2615, Australia"), key);
  assert.equal(normalizeStreet("5 Smith St\nHolt ACT 2615"), normalizeStreet("5 Smith Street, Holt ACT 2615"));
  assert.equal(normalizeStreet("8 Cook Pl\nCook ACT 2614"), normalizeStreet("8 Cook Place\nCook ACT 2614"));
});

test("a unit prefix is ignored", () => {
  assert.equal(normalizeStreet("Unit 18/11 Starcevich Cres\nJacka ACT 2914"), normalizeStreet("18/11 Starcevich Crescent\nJacka ACT 2914"));
});

test("the same street in a different suburb is a different property", () => {
  assert.notEqual(normalizeStreet("1 Smith St\nKambah ACT 2902"), normalizeStreet("1 Smith St\nFlynn ACT 2615"));
});

test("empty and missing addresses yield an empty key, which callers skip", () => {
  assert.equal(normalizeStreet(""), "");
  assert.equal(normalizeStreet(null), "");
  assert.equal(normalizeStreet(undefined), "");
});
