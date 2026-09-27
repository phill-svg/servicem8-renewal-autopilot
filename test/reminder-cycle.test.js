import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recomputeCategory } from "../src/due-engine.js";
import { approveAndSendDraft } from "../src/dashboard.js";
import { verifyDashboardToken, createDashboardToken } from "../src/addon.js";
import { makeSqliteEnv } from "./helpers/sqlite-d1.js";

const RULE = {
  id: "rule1",
  tenant_id: "t",
  signal_type: "category",
  servicem8_category_uuid: "cat1",
  interval_months: 12,
  due_soon_lead_days: 60,
  due_later_lead_days: null,
  overdue_grace_days: 60,
  overdue_max_days: null,
};

function ymd(d) {
  return d.toISOString().slice(0, 10) + " 09:00:00";
}
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return ymd(d);
}
function job(uuid, completion_date) {
  return { uuid, company_uuid: "co1", job_address: "1 Test St, Canberra", category_uuid: "cat1", completion_date, status: "Completed", generated_job_id: uuid };
}

// Stubs ServiceM8: completed jobs come from `jobs`, everything else is empty
// apart from one contact with a mobile.
let jobs = [];
let sends = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  sends = 0;
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    let body = [];
    if (u.includes("platform_service")) {
      sends++;
      await new Promise((r) => setTimeout(r, 5));
      body = { messageID: "m" + sends };
    } else if (u.includes("companycontact.json")) body = [{ first: "Sam", last: "Lee", mobile: "0412345678", is_primary_contact: "1" }];
    else if (u.includes("/job.json") && u.includes("status eq 'Completed'")) body = jobs;
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

// Puts the customer at "Call customer": every round sent.
function exhaustChase(env) {
  env.db.prepare("UPDATE reminder_drafts SET status = 'sent', sent_at = 1").run();
  env.db.prepare("UPDATE due_customers SET reminder_round = 4, called_at = 123").run();
}

test("a new service with the customer still due starts a fresh chase at round 1", async () => {
  const env = freshEnv();
  jobs = [job("j1", monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);
  exhaustChase(env);

  // A 12-month plan serviced 11.5 months later is still in a bucket.
  jobs = [job("j1", monthsAgo(13)), job("j2", monthsAgo(11))];
  await recomputeCategory(env, "t", RULE);

  const row = env.db.prepare("SELECT * FROM due_customers").get();
  assert.equal(row.last_job_uuid, "j2");
  assert.equal(row.reminder_round, 1);
  assert.equal(row.called_at, null);
  const drafts = env.db.prepare("SELECT * FROM reminder_drafts").all();
  assert.ok(drafts.length > 0 && drafts.every((d) => d.status === "pending" && d.round === 1), "a fresh round-1 draft is created, not blocked by last cycle's");
  assert.ok(env.db.prepare("SELECT COUNT(*) n FROM reminder_drafts_archive").get().n > 0, "old drafts are archived, not lost");
});

test("a customer serviced again leaves the queue until they're due again", async () => {
  const env = freshEnv();
  jobs = [job("j1", monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);
  exhaustChase(env);

  jobs = [job("j1", monthsAgo(13)), job("j2", monthsAgo(0))];
  await recomputeCategory(env, "t", RULE);

  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM due_customers").get().n, 0);
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM reminder_drafts").get().n, 0);
});

test("older history (a backfill chunk) never moves a customer backwards", async () => {
  const env = freshEnv();
  jobs = [job("j2", monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);
  exhaustChase(env);

  jobs = [job("j1", monthsAgo(40))];
  await recomputeCategory(env, "t", RULE);

  const row = env.db.prepare("SELECT * FROM due_customers").get();
  assert.equal(row.last_job_uuid, "j2");
  assert.equal(row.reminder_round, 4);
});

test("two simultaneous sends of one draft only send once", async () => {
  const env = freshEnv();
  jobs = [job("j1", monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);
  const draft = env.db.prepare("SELECT id FROM reminder_drafts WHERE channel = 'sms'").get();

  await Promise.all([approveAndSendDraft(env, "t", draft.id, "hi"), approveAndSendDraft(env, "t", draft.id, "hi")]);
  assert.equal(sends, 1);
  assert.equal(env.db.prepare("SELECT status FROM reminder_drafts WHERE id = ?").get(draft.id).status, "sent");
});

test("a dashboard token with extra parts is rejected", async () => {
  const good = await createDashboardToken("secret", "t");
  assert.equal(await verifyDashboardToken("secret", good), "t");
  assert.equal(await verifyDashboardToken("secret", good + ".</script><script>alert(1)</script>"), null);
});
