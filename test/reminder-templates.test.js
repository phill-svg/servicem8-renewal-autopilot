import { test } from "node:test";
import assert from "node:assert/strict";
import { templateForCategory } from "../src/due-engine.js";

const templates = {
  default: { sms: "generic" },
  "cat-a": { sms: "category A" },
};

test("templateForCategory: returns the matching category's template", () => {
  assert.equal(templateForCategory(templates, "cat-a").sms, "category A");
});

test("templateForCategory: falls back to default for an unrecognized category", () => {
  assert.equal(templateForCategory(templates, "cat-unknown").sms, "generic");
});

test("templateForCategory: falls back to default when the category is null/missing", () => {
  assert.equal(templateForCategory(templates, null).sms, "generic");
  assert.equal(templateForCategory(templates, undefined).sms, "generic");
});
