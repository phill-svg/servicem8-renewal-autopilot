import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/dashboard.js";
import { makeEnv, baseCustomer, baseDraft } from "./helpers/fixtures.js";
import { runDashboardScript, planTabCount } from "./helpers/fake-dom.js";

// The shape production actually has: the short cadences live in a bucket
// other than the default-selected one, and some of them have been contacted,
// so they aren't in any urgency tab at all -- customer "f" below is the case
// that no amount of tab-switching would have found.
function mixedPlanEnv() {
  return makeEnv({
    rules: [
      { id: "q", interval_months: 3 },
      { id: "h", interval_months: 6 },
      { id: "y", interval_months: 12 },
    ],
    customers: [
      baseCustomer({ id: "a", category_config_id: "q", contact_name_cache: "Quarterly Later", bucket: "due_later" }),
      baseCustomer({ id: "b", category_config_id: "h", contact_name_cache: "Half Later", bucket: "due_later" }),
      baseCustomer({ id: "c", category_config_id: "h", contact_name_cache: "Half Overdue", bucket: "overdue" }),
      baseCustomer({ id: "d", category_config_id: "y", contact_name_cache: "Yearly Soon", bucket: "due_soon" }),
      baseCustomer({ id: "e", category_config_id: "y", contact_name_cache: "Yearly Soon Two", bucket: "due_soon" }),
      baseCustomer({ id: "f", category_config_id: "h", contact_name_cache: "Half Contacted", bucket: "overdue", reminder_round: 2 }),
    ],
    drafts: [baseDraft({ id: "d-f", due_customer_id: "f", status: "sent", sent_at: 1786000000000 })],
  });
}

// The bug staff hit: the 3 month / 6 month tabs carried a non-zero count, but
// clicking one showed "No customers in this view" -- because the counts span
// every bucket while the filter was intersecting with the active urgency tab,
// and those cadences all sat in a bucket other than the one on screen.
test("a plan tab shows every customer on that plan, whichever bucket they sit in", async () => {
  const html = await renderDashboardHtml(mixedPlanEnv(), "t", "tok");
  assert.equal(planTabCount(html, 6), 3, "count is across all buckets, contacted included");

  const dom = runDashboardScript(html);
  dom.clickPlan(6);
  const names = dom.visible().map((r) => r.dataset.rowId);
  assert.deepEqual(names.sort(), ["b", "c", "f"], "every 6-month customer shows, not just the ones in the active tab");
});

test("a plan tab never promises more customers than clicking it reveals", async () => {
  const html = await renderDashboardHtml(mixedPlanEnv(), "t", "tok");
  for (const months of [3, 6, 12]) {
    const dom = runDashboardScript(html);
    dom.clickPlan(months);
    assert.equal(dom.visible().length, planTabCount(html, months), `${months} month tab count must match the rows it reveals`);
  }
});

// A plan choice spans buckets, so leaving an urgency tab highlighted would
// mean the highlighted tab is silently doing nothing.
test("choosing a plan clears the highlighted urgency tab, and All plans restores it", async () => {
  const html = await renderDashboardHtml(mixedPlanEnv(), "t", "tok");
  const dom = runDashboardScript(html);

  dom.clickPlan(6);
  assert.equal(
    dom.tabBtns.filter((b) => b.classList.contains("active")).length,
    0,
    "no urgency tab may look active while a plan spans every bucket"
  );

  dom.clickPlan("");
  const active = dom.tabBtns.filter((b) => b.classList.contains("active"));
  assert.equal(active.length, 1, "All plans returns to a single urgency tab");
  assert.equal(active[0].dataset.tabBucket, "overdue", "back to the default bucket");
  assert.deepEqual(
    dom.visible().map((r) => r.dataset.rowId),
    ["c"]
  );
});

// Picking an urgency tab is the way back out of a plan view; without this the
// tab would appear to do nothing while the plan filter kept spanning buckets.
test("picking an urgency tab clears the plan filter", async () => {
  const html = await renderDashboardHtml(mixedPlanEnv(), "t", "tok");
  const dom = runDashboardScript(html);

  dom.clickPlan(6);
  dom.clickTab("due_soon");
  assert.deepEqual(
    dom.visible().map((r) => r.dataset.rowId).sort(),
    ["d", "e"]
  );
  assert.ok(dom.planBtns.find((b) => b.dataset.tabPlan === "").classList.contains("active"), "All plans is active again");
});

// "All plans" is a button whether or not it's already highlighted, so its
// handler fires either way -- and must not move a view it didn't take over.
test("All plans with no plan selected leaves the urgency tab alone", async () => {
  const html = await renderDashboardHtml(mixedPlanEnv(), "t", "tok");
  const dom = runDashboardScript(html);

  dom.clickTab("due_later");
  dom.clickPlan("");
  assert.deepEqual(
    dom.visible().map((r) => r.dataset.rowId).sort(),
    ["a", "b"]
  );
});

test("the empty message doesn't blame the service filter for a plan-filtered view", async () => {
  const html = await renderDashboardHtml(mixedPlanEnv(), "t", "tok");
  const msg = html.slice(html.indexOf('id="empty-filtered"')).slice(0, 120);
  assert.doesNotMatch(msg, /for that service/);
});
