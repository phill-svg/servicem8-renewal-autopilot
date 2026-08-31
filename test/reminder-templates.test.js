import { test } from "node:test";
import assert from "node:assert/strict";
import { templateForCategory, resolveCategoryUuid, secondaryTemplateFor, CATEGORY_UUID } from "../src/due-engine.js";

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

// resolveCategoryUuid -- "Termite Management Treatment" covers both bait
// station servicing and inspections in practice (confirmed 2026-08-25 by
// reading live job descriptions), so the category id alone isn't enough.
test("resolveCategoryUuid: a termite-stations job whose description says 'inspection' resolves to the inspection category", () => {
  assert.equal(
    resolveCategoryUuid(CATEGORY_UUID.termiteStations, "Termite inspection\nfound damage under window frame"),
    CATEGORY_UUID.termiteInspection
  );
});

test("resolveCategoryUuid: matches 'inspection' case-insensitively", () => {
  assert.equal(resolveCategoryUuid(CATEGORY_UUID.termiteStations, "TERMITE INSPECTION due"), CATEGORY_UUID.termiteInspection);
});

test("resolveCategoryUuid: a termite-stations job with no 'inspection' wording stays termiteStations", () => {
  assert.equal(
    resolveCategoryUuid(CATEGORY_UUID.termiteStations, "Termite Monitoring and Baiting check"),
    CATEGORY_UUID.termiteStations
  );
});

test("resolveCategoryUuid: only remaps the termiteStations category -- other categories pass through untouched even if the description mentions inspection", () => {
  assert.equal(resolveCategoryUuid(CATEGORY_UUID.generalPest, "inspection"), CATEGORY_UUID.generalPest);
  assert.equal(resolveCategoryUuid(CATEGORY_UUID.termiteInspection, "bait station check"), CATEGORY_UUID.termiteInspection);
});

test("resolveCategoryUuid: handles a missing description without throwing", () => {
  assert.equal(resolveCategoryUuid(CATEGORY_UUID.termiteStations, null), CATEGORY_UUID.termiteStations);
  assert.equal(resolveCategoryUuid(CATEGORY_UUID.termiteStations, undefined), CATEGORY_UUID.termiteStations);
});

// secondaryTemplateFor -- the second draft option staff can toggle to.
const fullTemplates = {
  default: { sms: "generic" },
  [CATEGORY_UUID.generalPest]: { sms: "general pest primary" },
  generalPestAlt: { sms: "general pest alt" },
  [CATEGORY_UUID.rodent]: { sms: "rodent primary" },
  rodentAlt: { sms: "rodent alt" },
  [CATEGORY_UUID.termiteStations]: { sms: "stations primary" },
  [CATEGORY_UUID.termiteInspection]: { sms: "inspection primary" },
};

test("secondaryTemplateFor: termite stations' alt is the inspection template", () => {
  assert.equal(secondaryTemplateFor(fullTemplates, CATEGORY_UUID.termiteStations).sms, "inspection primary");
});

test("secondaryTemplateFor: termite inspection's alt is the stations template", () => {
  assert.equal(secondaryTemplateFor(fullTemplates, CATEGORY_UUID.termiteInspection).sms, "stations primary");
});

test("secondaryTemplateFor: general pest's alt is the general-pest-alt style", () => {
  assert.equal(secondaryTemplateFor(fullTemplates, CATEGORY_UUID.generalPest).sms, "general pest alt");
});

test("secondaryTemplateFor: rodent's alt is the rodent-alt style", () => {
  assert.equal(secondaryTemplateFor(fullTemplates, CATEGORY_UUID.rodent).sms, "rodent alt");
});

test("secondaryTemplateFor: an unrecognized/default category has no meaningful alt", () => {
  assert.equal(secondaryTemplateFor(fullTemplates, "some-other-category-uuid"), null);
  assert.equal(secondaryTemplateFor(fullTemplates, null), null);
});
