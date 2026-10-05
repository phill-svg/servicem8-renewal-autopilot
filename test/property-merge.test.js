import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recomputeCategory } from "../src/due-engine.js";
import { makeSqliteEnv } from "./helpers/sqlite-d1.js";

// One renewal per PROPERTY (2026-10-06): jobs on different client cards at
// the same address, or the same address written differently ("Cr" vs
// "Crescent"), are one customer row, not two.

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

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10) + " 09:00:00";
}
function job(uuid, company, address, completion_date) {
  return { uuid, company_uuid: company, job_address: address, category_uuid: "cat1", completion_date, status: "Completed", generated_job_id: uuid };
}

const CRESCENT = "23 Joyner Crescent\nFlynn ACT 2615";
const CR = "23 Joyner Cr\nFlynn ACT 2615";
const KEY = "23 joyner crescent flynn 2615";

// Stubs ServiceM8: completed jobs come from `jobs`, open ones from `openJobs`.
let jobs = [];
let openJobs = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  jobs = [];
  openJobs = [];
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    let body = [];
    if (u.includes("/job.json") && u.includes("status eq 'Completed'")) body = jobs;
    else if (u.includes("/job.json") && u.includes("status eq 'Work Order'")) body = openJobs;
    else if (u.includes("companycontact.json")) body = [{ first: "Sam", last: "Lee", mobile: "0412345678", is_primary_contact: "1" }];
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

// A row as the engine stored it before 2026-10-06: old-format key.
function insertLegacyRow(env, { id, company, address, oldKey, completed, round = 1 }) {
  env.db
    .prepare(
      `INSERT INTO due_customers (id, tenant_id, category_config_id, servicem8_company_uuid, address_key, address_display, last_job_uuid, last_completed_at, bucket, reminder_round, computed_at)
       VALUES (?, 't', 'rule1', ?, ?, ?, ?, ?, 'due', ?, 0)`
    )
    .run(id, company, oldKey, address, `job-${id}`, completed, round);
  env.db
    .prepare("INSERT INTO reminder_drafts (id, tenant_id, due_customer_id, channel, round, draft_body, status, created_at) VALUES (?, 't', ?, 'sms', 1, 'hi', 'sent', 0)")
    .run(`draft-${id}`, id);
}

const rows = (env) => env.db.prepare("SELECT * FROM due_customers ORDER BY id").all();

test("two client cards at one address become one row, on the card of the latest job", async () => {
  const env = freshEnv();
  jobs = [job("j-eliz", "co-eliz", CRESCENT, monthsAgo(14)), job("j-anna", "co-anna", CRESCENT, monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);

  const all = rows(env);
  assert.equal(all.length, 1);
  assert.equal(all[0].servicem8_company_uuid, "co-anna");
  assert.equal(all[0].last_job_uuid, "j-anna");
  assert.equal(all[0].address_key, KEY);
});

test("Elizabeth Zaja: a newer 'Joyner Cr' job retires both old 'Joyner Crescent' rows", async () => {
  const env = freshEnv();
  // As stored live: two cards, old-format keys, Elizabeth mid-chase.
  insertLegacyRow(env, { id: "dc-eliz", company: "co-eliz", address: CRESCENT, oldKey: "23 joyner crescentflynn act 2615", completed: monthsAgo(12), round: 3 });
  insertLegacyRow(env, { id: "dc-anna", company: "co-anna", address: CRESCENT, oldKey: "23 joyner crescentflynn act 2615", completed: monthsAgo(6) });

  // Her new termite inspection, booked online as "23 Joyner Cr", done last week.
  jobs = [
    job("j121", "co-eliz", CRESCENT, monthsAgo(12)),
    job("j729", "co-anna", CRESCENT, monthsAgo(6)),
    job("j1011", "co-eliz", CR, monthsAgo(0.25)),
  ];
  await recomputeCategory(env, "t", RULE);

  assert.deepEqual(rows(env), [], "serviced last week -- nobody should be chasing her");
  const archived = env.db.prepare("SELECT due_customer_id FROM reminder_drafts_archive ORDER BY due_customer_id").all();
  assert.deepEqual(archived.map((a) => a.due_customer_id), ["dc-anna", "dc-eliz"], "old drafts are kept for audit");
});

test("an old-format key is rekeyed in place, keeping the chase", async () => {
  const env = freshEnv();
  insertLegacyRow(env, { id: "dc1", company: "co1", address: CRESCENT, oldKey: "23 joyner crescentflynn act 2615", completed: monthsAgo(13), round: 2 });
  jobs = [job("job-dc1", "co1", CRESCENT, monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);

  const [row] = rows(env);
  assert.equal(row.id, "dc1");
  assert.equal(row.address_key, KEY);
  assert.equal(row.reminder_round, 2, "same service, so the chase carries on");
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM reminder_drafts WHERE due_customer_id = 'dc1'").get().n, 1);
});

test("two rows that collide after rekeying merge into the newer one", async () => {
  const env = freshEnv();
  insertLegacyRow(env, { id: "dc-old", company: "co1", address: CRESCENT, oldKey: "23 joyner crescentflynn act 2615", completed: monthsAgo(14) });
  insertLegacyRow(env, { id: "dc-new", company: "co1", address: CR, oldKey: "23 joyner crflynn act 2615", completed: monthsAgo(13) });
  jobs = [job("job-dc-new", "co1", CR, monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);

  const all = rows(env);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "dc-new");
});

test("an open booking on another client card at the property suppresses the reminder", async () => {
  const env = freshEnv();
  jobs = [job("j1", "co-eliz", CRESCENT, monthsAgo(13))];
  openJobs = [{ uuid: "open1", company_uuid: "co-anna", job_address: CR, status: "Work Order" }];
  await recomputeCategory(env, "t", RULE);

  assert.equal(rows(env)[0].suppressed_reason, "open_pipeline_job");
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM reminder_drafts").get().n, 0);
});

test("an open booking at a different property does not suppress", async () => {
  const env = freshEnv();
  jobs = [job("j1", "co1", CRESCENT, monthsAgo(13))];
  openJobs = [{ uuid: "open1", company_uuid: "co1", job_address: "117 Clift Crescent\nRichardson ACT 2905", status: "Work Order" }];
  await recomputeCategory(env, "t", RULE);

  assert.equal(rows(env)[0].suppressed_reason, null);
});

test("older history on another card never moves the property backwards", async () => {
  const env = freshEnv();
  jobs = [job("j-new", "co-anna", CRESCENT, monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);

  // A backfill chunk only sees the older job, on Elizabeth's card.
  jobs = [job("j-old", "co-eliz", CR, monthsAgo(20))];
  await recomputeCategory(env, "t", RULE);

  const [row] = rows(env);
  assert.equal(row.last_job_uuid, "j-new");
  assert.equal(row.servicem8_company_uuid, "co-anna");
});
