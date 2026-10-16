import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recomputeCategory, generateFollowUpDraftsForTenant, normalizeStreet } from "../src/due-engine.js";
import { renderDashboardHtml, setCustomerStage, bookJobForCustomer, approveAndSendDraft, MissingScopeError, bookingAddress, bookingBillingAddress } from "../src/dashboard.js";
import { makeSqliteEnv } from "./helpers/sqlite-d1.js";

// Staff can move a customer between stages by hand after phoning them, and
// book their next job straight from the row (2026-10-16).

const RULE = { id: "rule1", signal_type: "category", servicem8_category_uuid: "cat1", interval_months: 12, due_soon_lead_days: 60, due_later_lead_days: null, overdue_grace_days: 60, overdue_max_days: null };

let jobs = [];
let posts = [];
let jobCreateStatus = 200;
const realFetch = globalThis.fetch;
beforeEach(() => {
  posts = [];
  jobCreateStatus = 200;
  globalThis.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (init.method === "POST" && u.endsWith("/job.json")) {
      posts.push(JSON.parse(init.body));
      if (jobCreateStatus !== 200) return new Response('{"error":"insufficient_scope"}', { status: jobCreateStatus });
      return new Response('{"errorCode":"0"}', { status: 200, headers: { "x-record-uuid": "newjob-uuid" } });
    }
    let body = [];
    if (u.includes("/job/newjob-uuid.json")) body = { uuid: "newjob-uuid", generated_job_id: "1234" };
    else if (u.includes("platform_service")) body = { messageID: "m1" };
    else if (u.includes("companycontact.json")) body = [{ first: "Sam", last: "Lee", mobile: "0412345678", email: "sam@example.com", is_primary_contact: "1" }];
    else if (u.includes("/job.json") && u.includes("status eq 'Completed'")) body = jobs;
    return new Response(JSON.stringify(body), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10) + " 09:00:00";
}
const mkJob = (uuid, completed) => ({ uuid, company_uuid: "co1", job_address: "1 Test St\nHolt ACT 2615", category_uuid: "cat1", completion_date: completed, status: "Completed", generated_job_id: uuid });

// One customer due now (13 months since a 12-month service) with pending round-1 SMS + email drafts.
async function dueCustomer() {
  const env = makeSqliteEnv();
  env.db.prepare("INSERT INTO tenants (servicem8_account_uuid, installed_at) VALUES ('t', 0)").run();
  env.db.prepare("INSERT INTO oauth_tokens VALUES ('t', 'tok', 'ref', ?, '', 0)").run(Date.now() + 3_600_000);
  env.db.prepare("INSERT INTO category_config (id, tenant_id, servicem8_category_uuid, interval_months) VALUES ('rule1', 't', 'cat1', 12)").run();
  jobs = [mkJob("j1", monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);
  const row = env.db.prepare("SELECT * FROM due_customers").get();
  return { env, id: row.id };
}
const row = (env) => env.db.prepare("SELECT * FROM due_customers").get();
const drafts = (env) => env.db.prepare("SELECT channel, round, status FROM reminder_drafts ORDER BY round, channel").all();
async function tabOf(env, id) {
  const html = await renderDashboardHtml(env, "t", "tok");
  return html.match(new RegExp(`data-row-id="${id}" data-bucket="([a-z_0-9]+)"`))[1];
}

test("each stage lands the row in its tab", async () => {
  const { env, id } = await dueCustomer();
  assert.equal(await tabOf(env, id), "due");
  for (const [stage, tab] of [["contacted1", "contacted1"], ["contacted2", "contacted2"], ["call", "call"], ["called", "called"], ["due", "due"]]) {
    await setCustomerStage(env, "t", id, stage, "");
    assert.equal(await tabOf(env, id), tab, stage);
  }
});

test("Contacted 1 by phone: recorded with the date and note, no reminder sent", async () => {
  const { env, id } = await dueCustomer();
  await setCustomerStage(env, "t", id, "contacted1", "Spoke to Sam, calling back Friday");
  const r = row(env);
  assert.equal(r.reminder_round, 2);
  assert.ok(r.manual_stage_at > 0);
  assert.equal(r.manual_stage_note, "Spoke to Sam, calling back Friday");
  assert.deepEqual(drafts(env), [], "the unsent round-1 drafts are archived");
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM reminder_drafts_archive").get().n, 2);
  const html = await renderDashboardHtml(env, "t", "tok");
  assert.match(html, /Set by hand [^<]*Spoke to Sam, calling back Friday/);
});

test("a blank note gets the stage's default", async () => {
  const { env, id } = await dueCustomer();
  await setCustomerStage(env, "t", id, "contacted2", "   ");
  assert.equal(row(env).manual_stage_note, "Contacted by phone");
});

test("follow-ups carry on from the chosen stage", async () => {
  const { env, id } = await dueCustomer();
  await setCustomerStage(env, "t", id, "contacted1", "");
  await generateFollowUpDraftsForTenant(env, "t");
  assert.deepEqual(drafts(env).map((d) => `${d.channel}${d.round}${d.status}`), ["email2pending", "sms2pending"]);
  assert.equal(await tabOf(env, id), "due", "the round-2 draft brings them back to be actioned, as after a real send");
});

test("moving back a stage lets that round be drafted again", async () => {
  const { env, id } = await dueCustomer();
  await setCustomerStage(env, "t", id, "contacted1", "");
  await generateFollowUpDraftsForTenant(env, "t");
  const sms2 = env.db.prepare("SELECT id FROM reminder_drafts WHERE channel = 'sms' AND round = 2").get();
  await approveAndSendDraft(env, "t", sms2.id, "hi");
  assert.equal(row(env).reminder_round, 3);

  await setCustomerStage(env, "t", id, "contacted1", "");
  assert.equal(row(env).reminder_round, 2);
  assert.deepEqual(drafts(env), [], "round 2's sent draft is archived so it can be redrafted");
  await generateFollowUpDraftsForTenant(env, "t");
  assert.ok(drafts(env).some((d) => d.round === 2 && d.status === "pending"));
});

test("back to Due starts over with fresh round-1 drafts", async () => {
  const { env, id } = await dueCustomer();
  const sms1 = env.db.prepare("SELECT id FROM reminder_drafts WHERE channel = 'sms'").get();
  await approveAndSendDraft(env, "t", sms1.id, "hi");
  assert.equal(await tabOf(env, id), "contacted1");

  await setCustomerStage(env, "t", id, "due", "");
  assert.equal(row(env).reminder_round, 1);
  assert.deepEqual(drafts(env).map((d) => `${d.channel}${d.round}${d.status}`), ["email1pending", "sms1pending"]);
  assert.equal(await tabOf(env, id), "due");
});

test("Called records when", async () => {
  const { env, id } = await dueCustomer();
  await setCustomerStage(env, "t", id, "called", "");
  assert.equal(row(env).reminder_round, 4);
  assert.ok(row(env).called_at > 0);
  await setCustomerStage(env, "t", id, "call", "");
  assert.equal(row(env).called_at, null);
});

test("an unknown stage or another tenant's row is refused", async () => {
  const { env, id } = await dueCustomer();
  await assert.rejects(setCustomerStage(env, "t", id, "contacted9", ""));
  await assert.rejects(setCustomerStage(env, "other", id, "contacted1", ""));
});

test("a new service cycle clears the manual stage", async () => {
  const { env, id } = await dueCustomer();
  await setCustomerStage(env, "t", id, "contacted2", "");
  jobs = [mkJob("j1", monthsAgo(13)), mkJob("j2", monthsAgo(11))];
  await recomputeCategory(env, "t", RULE);
  const r = row(env);
  assert.equal(r.reminder_round, 1);
  assert.equal(r.manual_stage_at, null);
  assert.equal(r.manual_stage_note, null);
});

test("Book job creates a Work Order for the client at the property and takes them out of the queue", async () => {
  const { env, id } = await dueCustomer();
  const res = await bookJobForCustomer(env, "t", id, "General pest - booked after call");
  assert.deepEqual(res, { jobUuid: "newjob-uuid", jobNumber: "1234" });
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { status: "Work Order", company_uuid: "co1", job_address: "1 Test St\nHolt ACT 2615", billing_address: "1 Test St\nHolt ACT 2615", job_description: "General pest - booked after call", category_uuid: "cat1" });
  const r = row(env);
  assert.equal(r.suppressed_reason, "open_pipeline_job");
  assert.equal(r.manual_stage_note, "Booked job #1234");
  assert.doesNotMatch(await renderDashboardHtml(env, "t", "tok"), new RegExp(`data-row-id="${id}"`));
});

test("booking twice (double click) creates one job", async () => {
  const { env, id } = await dueCustomer();
  const [a, b] = await Promise.all([bookJobForCustomer(env, "t", id, "x"), bookJobForCustomer(env, "t", id, "x")]);
  assert.equal(posts.length, 1);
  assert.ok(a.alreadyBooked || b.alreadyBooked);
  assert.deepEqual(await bookJobForCustomer(env, "t", id, "x"), { alreadyBooked: true });
});

test("without the create_jobs permission: a clear error and the row stays in the queue", async () => {
  const { env, id } = await dueCustomer();
  jobCreateStatus = 403;
  await assert.rejects(bookJobForCustomer(env, "t", id, "x"), MissingScopeError);
  assert.equal(row(env).suppressed_reason, null);
});

// Job #1053, 2026-10-16: booked from #693, whose address was typed as
// "12/26 cynthea Teague crescent greenway", so the new job had no postcode.
// ServiceM8 had geocoded it; the booking uses that, shaped like job #929.
const JOB_693 = {
  job_address: "12/26 cynthea Teague crescent greenway",
  billing_address: "12/26 cynthea Teague crescent greenway",
  geo_is_valid: 1, geo_number: "26", geo_street: "Cynthea Teague Crescent", geo_city: "Greenway", geo_state: "ACT", geo_postcode: "2900",
};

test("a booking gets the full address with its postcode, like a properly typed job", () => {
  const addr = bookingAddress(JOB_693);
  assert.equal(addr, "12/26 Cynthea Teague Crescent\nGreenway ACT 2900");
  assert.equal(bookingBillingAddress(JOB_693, addr), addr, "billing follows the job address");
});

test("an address that already has its postcode is used as it is", () => {
  const job = { ...JOB_693, job_address: "4/9 Troughton St\nHolt ACT 2615", billing_address: "4/9 Troughton St\nHolt ACT 2615" };
  assert.equal(bookingAddress(job), "4/9 Troughton St\nHolt ACT 2615");
});

test("a geocode that isn't clearly this address is not used", () => {
  assert.equal(bookingAddress({ ...JOB_693, geo_number: "28" }), JOB_693.job_address, "different street number");
  assert.equal(bookingAddress({ ...JOB_693, geo_street: "Other Street" }), JOB_693.job_address, "different street");
  assert.equal(bookingAddress({ ...JOB_693, geo_is_valid: 0 }), JOB_693.job_address, "not geocoded");
  assert.equal(bookingAddress(null, "5 Smith St"), "5 Smith St", "no job to read");
});

test("billing somewhere else (a property manager) is kept", () => {
  const job = { ...JOB_693, billing_address: "PO Box 12\nBelconnen ACT 2617" };
  assert.equal(bookingBillingAddress(job, "anything"), "PO Box 12\nBelconnen ACT 2617");
});

test("Book job sends the rebuilt address and billing address to ServiceM8", async () => {
  const { env, id } = await dueCustomer();
  env.db.prepare("UPDATE due_customers SET last_job_uuid = 'j693'").run();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes("/job/j693.json") ? new Response(JSON.stringify(JOB_693), { status: 200 }) : inner(url, init));
  await bookJobForCustomer(env, "t", id, "x");
  assert.equal(posts[0].job_address, "12/26 Cynthea Teague Crescent\nGreenway ACT 2900");
  assert.equal(posts[0].billing_address, "12/26 Cynthea Teague Crescent\nGreenway ACT 2900");
});

test("a typed address with no suburb keeps matching its property", () => {
  const job = { ...JOB_693, job_address: "4/9 Troughton St", geo_number: "9", geo_street: "Troughton Street", geo_city: "Banks", geo_postcode: "2906" };
  const addr = bookingAddress(job);
  assert.equal(addr, "4/9 Troughton St\nACT 2906");
  assert.equal(normalizeStreet(addr), normalizeStreet(job.job_address));
});

test("every rebuilt address is the same property as the typed one", () => {
  assert.equal(normalizeStreet(bookingAddress(JOB_693)), normalizeStreet(JOB_693.job_address));
});
