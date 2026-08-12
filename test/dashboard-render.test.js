import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/dashboard.js";
import { makeEnv, baseCustomer, baseDraft, rowFor, isVisible } from "./helpers/fixtures.js";

test("an opened email shows a green chip with the open time", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Opened Once", reminder_round: 2 })],
    drafts: [baseDraft({ status: "sent", sent_at: 1785975576662, delivery_status: "confirmed", opened_at: "2026-08-06 11:35:28", channel: "email" })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Opened Once");
  assert.match(row, /EMAIL opened 06\/08\/2026 11:35/);
  assert.ok(isVisible(row, "opened-chip"), "opened chip must not be hidden inside the composer");
});

test("a confirmed delivery shows delivered, not sent", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Delivered Only", reminder_round: 2 })],
    drafts: [baseDraft({ status: "sent", sent_at: 1786485399259, delivery_status: "confirmed" })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Delivered Only");
  assert.match(row, /SMS delivered/);
  assert.ok(isVisible(row, "delivered-chip"));
});

test("an unverified send shows sent, and never claims SMS was received", async () => {
  const env = makeEnv({
    customers: [baseCustomer({ contact_name_cache: "Just Sent", reminder_round: 2 })],
    drafts: [baseDraft({ status: "sent", sent_at: 1786515503154, delivery_status: null })],
  });
  const html = await renderDashboardHtml(env, "t", "tok");
  const row = rowFor(html, "Just Sent");
  assert.match(row, /SMS sent/);
  assert.ok(isVisible(row, "sent-chip"));
  assert.doesNotMatch(html, /SMS received/);
});
