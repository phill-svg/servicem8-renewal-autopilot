import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendDueDigestForTenant, sendDueDigests, buildDueDigest, sydneyNow, recomputeCategory } from "../src/due-engine.js";
import { makeSqliteEnv } from "./helpers/sqlite-d1.js";

// 9am / 6am on Tue 6 Oct 2026 in Sydney (AEDT, UTC+11).
const NINE_AM = new Date("2026-10-05T22:00:00Z");
const SIX_AM = new Date("2026-10-05T19:00:00Z");
const NEXT_DAY = new Date("2026-10-06T22:00:00Z");

// Stubs ServiceM8: records every POST; inbox returns a uuid, notifications
// succeed unless the recipient is in `badStaff`.
let posts = [];
let inboxFails = false;
let badStaff = new Set();
let jobs = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  posts = [];
  inboxFails = false;
  badStaff = new Set();
  jobs = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push({ url: u, body });
      if (u.endsWith("/inboxmessage.json")) {
        if (inboxFails) return new Response("Missing scope publish_inbox", { status: 403 });
        return new Response(JSON.stringify({ uuid: "inbox-1" }), { status: 201 });
      }
      if (u.endsWith("/notification.json")) {
        if (badStaff.has(body.recipient_staff_uuids[0])) return new Response("invalid recipient", { status: 400 });
        return new Response(JSON.stringify({ created: true }), { status: 201 });
      }
    }
    let body = [];
    if (u.includes("/job.json") && u.includes("status eq 'Completed'")) body = jobs;
    return new Response(JSON.stringify(body), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function freshEnv({ recipients = ["staff-a"] } = {}) {
  const env = makeSqliteEnv();
  env.db.prepare("INSERT INTO tenants (servicem8_account_uuid, installed_at) VALUES ('t', 0)").run();
  env.db.prepare("INSERT INTO oauth_tokens VALUES ('t', 'tok', 'ref', ?, '', 0)").run(Date.now() + 3_600_000);
  env.db.prepare("INSERT INTO category_config (id, tenant_id, servicem8_category_uuid, category_name_cache, interval_months) VALUES ('rule1', 't', 'cat1', '1 year auto', 12)").run();
  for (const s of recipients) env.db.prepare("INSERT INTO notify_recipients VALUES ('t', ?, 0, 0)").run(s);
  return env;
}

let n = 0;
function addCustomer(env, fields = {}) {
  const row = {
    id: `dc${++n}`,
    bucket: "due",
    reminder_round: 1,
    suppressed_reason: null,
    dismissed_at: null,
    contact_name_cache: `Customer ${n}`,
    address_display: `${n} Test St, Canberra`,
    last_completed_at: "2025-09-01 09:00:00",
    ...fields,
  };
  env.db
    .prepare(
      `INSERT INTO due_customers (id, tenant_id, category_config_id, servicem8_company_uuid, address_key, bucket, reminder_round, suppressed_reason, dismissed_at, contact_name_cache, address_display, last_completed_at, computed_at)
       VALUES (?, 't', 'rule1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(row.id, `co-${row.id}`, row.address_display.toLowerCase(), row.bucket, row.reminder_round, row.suppressed_reason, row.dismissed_at, row.contact_name_cache, row.address_display, row.last_completed_at);
  return row.id;
}

const inboxPosts = () => posts.filter((p) => p.url.endsWith("/inboxmessage.json"));
const notifPosts = () => posts.filter((p) => p.url.endsWith("/notification.json"));
const notifiedIds = (env) => env.db.prepare("SELECT id FROM due_customers WHERE due_notified_at IS NOT NULL ORDER BY id").all().map((r) => r.id);

test("sydneyNow gives the Sydney-local date and hour", () => {
  assert.deepEqual({ ...sydneyNow(NINE_AM), label: undefined }, { date: "2026-10-06", hour: 9, label: undefined });
  assert.equal(sydneyNow(SIX_AM).hour, 6);
});

test("due and overdue customers go into one Inbox item plus a notification per recipient that opens it", async () => {
  const env = freshEnv({ recipients: ["staff-a", "staff-b"] });
  const a = addCustomer(env, { bucket: "due" });
  const b = addCustomer(env, { bucket: "overdue" });

  const result = await sendDueDigestForTenant(env, "t", { now: NINE_AM });

  assert.equal(result.sent, 2);
  assert.equal(inboxPosts().length, 1);
  assert.match(inboxPosts()[0].body.subject, /^2 customers due for renewal/);
  assert.match(inboxPosts()[0].body.message_text, /1 year auto \| Overdue/);
  assert.equal(notifPosts().length, 2);
  assert.deepEqual(notifPosts().map((p) => p.body.recipient_staff_uuids), [["staff-a"], ["staff-b"]]);
  for (const p of notifPosts()) assert.equal(p.body.destination_url, "servicem8://inbox/inbox-1");
  assert.deepEqual(notifiedIds(env), [a, b].sort());
});

test("only one digest a day, and already-announced customers aren't repeated the next day", async () => {
  const env = freshEnv();
  addCustomer(env);
  await sendDueDigestForTenant(env, "t", { now: NINE_AM });
  assert.deepEqual(await sendDueDigestForTenant(env, "t", { now: NINE_AM }), { skipped: "already-sent-today" });

  // Next morning: nothing new -> nothing sent.
  posts = [];
  assert.deepEqual(await sendDueDigestForTenant(env, "t", { now: NEXT_DAY }), { sent: 0 });
  assert.equal(posts.length, 0);

  // A customer who became due overnight is announced on its own.
  const c = addCustomer(env, { contact_name_cache: "New Person" });
  await sendDueDigestForTenant(env, "t", { now: new Date("2026-10-07T22:00:00Z") });
  assert.equal(inboxPosts().length, 1);
  assert.match(inboxPosts()[0].body.subject, /^1 customer due for renewal/);
  assert.match(notifPosts()[0].body.message, /New Person/);
  assert.ok(notifiedIds(env).includes(c));
});

test("due soon, contacted, dismissed and suppressed customers are left out", async () => {
  const env = freshEnv();
  addCustomer(env, { bucket: "due_soon" });
  addCustomer(env, { reminder_round: 2 });
  addCustomer(env, { dismissed_at: 1 });
  addCustomer(env, { suppressed_reason: "open_pipeline_job" });
  assert.deepEqual(await sendDueDigestForTenant(env, "t", { now: NINE_AM }), { sent: 0 });
  assert.equal(posts.length, 0);
});

test("nothing is sent before 8am Sydney unless forced", async () => {
  const env = freshEnv();
  addCustomer(env);
  await sendDueDigests(env, { now: SIX_AM });
  assert.deepEqual(await sendDueDigestForTenant(env, "t", { now: SIX_AM }), { skipped: "before-digest-hour" });
  assert.equal(posts.length, 0);

  const forced = await sendDueDigestForTenant(env, "t", { now: SIX_AM, force: true });
  assert.equal(forced.sent, 1);
});

test("with no recipients yet nothing is sent and the day's claim is released", async () => {
  const env = freshEnv({ recipients: [] });
  addCustomer(env);
  assert.deepEqual(await sendDueDigestForTenant(env, "t", { now: NINE_AM }), { skipped: "no-recipients", pending: 1 });
  assert.equal(posts.length, 0);

  // Someone opens the add-on later that morning -> the next sweep sends.
  env.db.prepare("INSERT INTO notify_recipients VALUES ('t', 'staff-a', 0, 0)").run();
  assert.equal((await sendDueDigestForTenant(env, "t", { now: NINE_AM })).sent, 1);
});

test("an Inbox failure leaves customers un-notified for tomorrow and sends no push", async () => {
  const env = freshEnv();
  addCustomer(env);
  inboxFails = true;
  const result = await sendDueDigestForTenant(env, "t", { now: NINE_AM });
  assert.ok(result.error);
  assert.equal(notifPosts().length, 0);
  assert.deepEqual(notifiedIds(env), []);

  inboxFails = false;
  assert.equal((await sendDueDigestForTenant(env, "t", { now: NEXT_DAY })).sent, 1);
});

test("one bad recipient doesn't stop the others being notified", async () => {
  const env = freshEnv({ recipients: ["gone", "staff-a"] });
  addCustomer(env);
  badStaff.add("gone");
  const result = await sendDueDigestForTenant(env, "t", { now: NINE_AM });
  assert.equal(result.notified, 1);
  assert.equal(result.recipients, 2);
});

test("a new service cycle clears due_notified_at so the next cycle is announced", async () => {
  const env = freshEnv();
  const RULE = { id: "rule1", signal_type: "category", servicem8_category_uuid: "cat1", interval_months: 12, due_soon_lead_days: 60, due_later_lead_days: null, overdue_grace_days: 60, overdue_max_days: null };
  const monthsAgo = (m) => {
    const d = new Date();
    d.setMonth(d.getMonth() - m);
    return d.toISOString().slice(0, 10) + " 09:00:00";
  };
  const job = (uuid, completion_date) => ({ uuid, company_uuid: "co1", job_address: "1 Test St, Canberra", category_uuid: "cat1", completion_date, status: "Completed" });

  jobs = [job("j1", monthsAgo(13))];
  await recomputeCategory(env, "t", RULE);
  env.db.prepare("UPDATE due_customers SET due_notified_at = 1").run();

  // Serviced again while still in a bucket -> fresh cycle.
  jobs = [job("j1", monthsAgo(13)), job("j2", monthsAgo(11))];
  await recomputeCategory(env, "t", RULE);
  assert.equal(env.db.prepare("SELECT due_notified_at FROM due_customers").get().due_notified_at, null);
});

test("buildDueDigest escapes names in the notification and caps the list", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ contact_name_cache: i === 0 ? "<script>x</script>" : `P${i}`, bucket: "due", last_completed_at: `2025-09-0${i + 1} 09:00:00` }));
  const d = buildDueDigest(rows, "Tue 6 Oct");
  assert.equal(d.subject, "7 customers due for renewal - Tue 6 Oct");
  assert.ok(!d.notifMessage.includes("<script>"));
  assert.match(d.notifMessage, /&lt;script&gt;/);
  assert.match(d.notifMessage, /and 2 more$/);
  assert.match(d.messageText, /<script>x<\/script>/); // plain-text Inbox body is not HTML
});
