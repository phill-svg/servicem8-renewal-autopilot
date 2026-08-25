import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/dashboard.js";
import { makeEnv, baseCustomer, baseDraft, rowFor } from "./helpers/fixtures.js";

test("a draft with an alt option renders the variant toggle and both bodies as data attributes", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Two Options" })],
    drafts: [baseDraft({ draft_body: "option one text", alt_draft_body: "option two text" })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Two Options");
  assert.match(row, /data-body-sms="option one text"/);
  assert.match(row, /data-body-sms-alt="option two text"/);
  assert.match(row, /class="variant-toggle"[^>]*style=""/);
});

test("a draft with no alt option hides the variant toggle and omits the alt attribute", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "One Option Only" })],
    drafts: [baseDraft({ draft_body: "only text", alt_draft_body: null })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "One Option Only");
  assert.doesNotMatch(row, /data-body-sms-alt=/);
  assert.match(row, /class="variant-toggle"[^>]*style="display:none;"/);
});
