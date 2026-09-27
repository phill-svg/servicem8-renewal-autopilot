import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/dashboard.js";
import { makeEnv, baseCustomer, baseDraft, rowFor, isVisible } from "./helpers/fixtures.js";

// "Contacted" means something was sent and nothing is left pending, which is
// what moves a customer out of their urgency bucket.
function contacted(overrides = {}) {
  return baseCustomer({ reminder_round: 2, ...overrides });
}
const sentDraft = baseDraft({ status: "sent", sent_at: 1786485399259, delivery_status: "confirmed" });

test("a future auto-draft shows its date and a relative time", async () => {
  // A far-future completion date keeps the trigger ahead of now whenever this
  // test runs, so it can never drift into the 'tonight' branch.
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "Future Draft", last_completed_at: "2199-01-01 09:00:00" })],
    drafts: [sentDraft],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Future Draft");
  assert.match(row, /Next reminder drafts 27\/12\/2199/);
  assert.ok(isVisible(row, "next-chip"), "next-reminder chip must not be hidden inside the collapsed composer");
});

test("a trigger date already passed says tonight", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "Overdue Draft", last_completed_at: "2020-01-01 09:00:00" })],
    drafts: [sentDraft],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Overdue Draft");
  assert.match(row, /Next reminder drafts tonight/);
  assert.ok(isVisible(row, "next-chip"));
});

test("after the final reminder the customer becomes a call task", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "All Done", reminder_round: 4 })],
    drafts: [sentDraft],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "All Done");
  assert.match(row, /data-bucket="call"/);
  assert.match(row, />Call customer</);
  assert.ok(isVisible(row, 'class="call-btn"'), "call button must not be hidden inside the composer");
  assert.ok(isVisible(row, 'data-called="cust1"'), "mark-called button must be visible");
  assert.match(html, /data-tab-bucket="call">Call customer <span class="n">1</);
});

test("a call task with no phone says so instead of a dead call button", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "No Phone", reminder_round: 4, contact_phone_cache: null })],
    drafts: [baseDraft({ status: "sent", sent_at: 1786485399259, channel: "email" })],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "No Phone");
  assert.doesNotMatch(row, /class="call-btn"/);
  assert.match(row, /No phone number to call/);
});

test("once marked called the row moves to Called and shows when", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "Rang Them", reminder_round: 4, called_at: 1786485399259 })],
    drafts: [sentDraft],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Rang Them");
  assert.match(row, /data-bucket="called"/);
  assert.ok(isVisible(row, "called-chip"));
  assert.doesNotMatch(row, /data-called=/);
  assert.match(html, /<option value="called">Called \(1\)</);
});

test("a customer still awaiting their first send gets no chip", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Not Yet", reminder_round: 1 })],
    drafts: [baseDraft({ status: "pending" })],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Not Yet");
  assert.doesNotMatch(row, /next-chip/);
});

// The engine auto-DRAFTS rounds 2 and 3; a human still has to press send.
// Wording that implies otherwise would let staff assume a customer is being
// chased when nobody has actioned it.
test("the chip never claims the reminder sends itself", async () => {
  const env = makeEnv({
    customers: [contacted({ contact_name_cache: "Wording", last_completed_at: "2199-01-01 09:00:00" })],
    drafts: [sentDraft],
  });
  const row = rowFor(await renderDashboardHtml(env, "t", "tok"), "Wording");
  assert.doesNotMatch(row, /auto-?sends|sends automatically|will be sent automatically/i);
  assert.match(row, /drafts/);
});
