import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recomputeCategory, shouldRefreshDetails } from "../src/due-engine.js";
import { makeSqliteEnv } from "./helpers/sqlite-d1.js";

// The nightly run re-read every customer's contact + notes from ServiceM8 and
// was cut off at Cloudflare's 15-minute cron limit from 2026-09-17. It now
// only re-reads them when they can matter.

const cached = { last_job_uuid: "j1", contact_name_cache: "Sam Lee", contact_phone_cache: "0412345678", contact_email_cache: "" };
const job = { uuid: "j1", company_uuid: "co1" };

test("new row, new job, or nothing cached: always refresh", () => {
  assert.equal(shouldRefreshDetails(null, job, "due_later"), true);
  assert.equal(shouldRefreshDetails({ ...cached, last_job_uuid: "older" }, job, "due_later"), true);
  assert.equal(shouldRefreshDetails({ ...cached, contact_name_cache: "" }, job, "due_later"), true);
  assert.equal(shouldRefreshDetails({ ...cached, contact_phone_cache: "", contact_email_cache: "" }, job, "due_later"), true);
});

test("customers about to be contacted refresh every night", () => {
  for (const b of ["due_soon", "due", "overdue"]) assert.equal(shouldRefreshDetails(cached, job, b), true, b);
});

test("everyone else refreshes exactly one night a week", () => {
  let nights = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(Date.UTC(2026, 9, 12 + i, 2)); // Mon 12 Oct .. Sun 18 Oct, ~1pm Sydney
    if (shouldRefreshDetails(cached, job, "due_later", day)) nights++;
  }
  assert.equal(nights, 1);
});

// ---- engine: count the ServiceM8 reads -------------------------------------

const RULE = { id: "rule1", signal_type: "category", servicem8_category_uuid: "cat1", interval_months: 12, due_soon_lead_days: 60, due_later_lead_days: 400, overdue_grace_days: 60, overdue_max_days: null };
let jobs = [];
let detailReads = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  detailReads = 0;
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    let body = [];
    if (u.includes("/job.json") && u.includes("status eq 'Completed'")) body = jobs;
    else if (u.includes("companycontact.json") || u.includes("/note.json")) {
      detailReads++;
      if (u.includes("companycontact.json")) body = [{ first: "Sam", last: "Lee", mobile: "0412345678", is_primary_contact: "1" }];
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function freshEnv() {
  const env = makeSqliteEnv();
  env.db.prepare("INSERT INTO tenants (servicem8_account_uuid, installed_at) VALUES ('t', 0)").run();
  env.db.prepare("INSERT INTO oauth_tokens VALUES ('t', 'tok', 'ref', ?, '', 0)").run(Date.now() + 3_600_000);
  env.db.prepare("INSERT INTO category_config (id, tenant_id, servicem8_category_uuid, interval_months) VALUES ('rule1', 't', 'cat1', 12)").run();
  return env;
}
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10) + " 09:00:00";
}
const mkJob = (uuid, company, address, completed) => ({ uuid, company_uuid: company, job_address: address, category_uuid: "cat1", completion_date: completed, status: "Completed" });

test("a re-run skips the ServiceM8 reads for unchanged, not-yet-due customers", async () => {
  const env = freshEnv();
  // 30 customers serviced 2 months ago (due later), 1 customer overdue.
  jobs = Array.from({ length: 30 }, (_, i) => mkJob(`j${i}`, `co${i}`, `${i + 1} Test St\nHolt ACT 2615`, monthsAgo(2)));
  jobs.push(mkJob("jdue", "codue", "99 Due St\nHolt ACT 2615", monthsAgo(13)));
  await recomputeCategory(env, "t", RULE);
  const firstRun = detailReads;
  assert.equal(firstRun, 31 * 2, "first run reads everyone (contact + notes)");

  detailReads = 0;
  await recomputeCategory(env, "t", RULE);
  // The overdue one every night, plus roughly a seventh of the rest.
  assert.ok(detailReads >= 2 && detailReads <= 2 + 2 * 12, `re-run read ${detailReads}`);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM due_customers WHERE contact_name_cache = 'Sam Lee'").get().n, 31, "cached contacts kept");
});

test("a new job for a customer re-reads their contact", async () => {
  const env = freshEnv();
  jobs = [mkJob("j1", "co1", "1 Test St\nHolt ACT 2615", monthsAgo(3))];
  await recomputeCategory(env, "t", RULE);
  detailReads = 0;
  jobs = [mkJob("j1", "co1", "1 Test St\nHolt ACT 2615", monthsAgo(3)), mkJob("j2", "co1", "1 Test St\nHolt ACT 2615", monthsAgo(1))];
  await recomputeCategory(env, "t", RULE);
  assert.equal(detailReads, 2);
});
