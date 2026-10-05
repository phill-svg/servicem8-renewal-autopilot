import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFollowUpTexts, isPastDue, refreshOverdueFollowUpDrafts, generateFollowUpDraftsForTenant, CATEGORY_UUID } from "../src/due-engine.js";
import { makeSqliteEnv } from "./helpers/sqlite-d1.js";

// Phill, 2026-10-06: "even if the service is overdue it still says in the sms
// and email templates 'soon'". Rounds 2/3 said "coming up due" / "due very
// soon" even for customers well past their due date.

const SETTINGS = { business_name: "TCB Pest Control" };
const CATEGORIES = [null, CATEGORY_UUID.generalPest, CATEGORY_UUID.rodent, CATEGORY_UUID.termiteStations, CATEGORY_UUID.termiteInspection];
const SOON = /soon|coming up due|upcoming|lapses/i;

function customer(category) {
  return { contact_name_cache: "Sarah Lim", servicem8_category_uuid: category, last_job_description_cache: "" };
}
function allText(t) {
  return [t.sms, t.smsAlt, t.emailSubject, t.email, t.emailAltSubject, t.emailAlt].filter(Boolean);
}

test("past due: every category, round, channel and option says overdue and never 'soon'", () => {
  for (const cat of CATEGORIES) {
    for (const round of [2, 3]) {
      const t = buildFollowUpTexts(customer(cat), round, SETTINGS, true);
      for (const text of allText(t)) {
        assert.doesNotMatch(text, SOON, `${cat} round ${round}: ${text}`);
        assert.match(text, /overdue/i, `${cat} round ${round}: ${text}`);
      }
      assert.match(t.sms, /^Hi Sarah,/);
      assert.match(t.sms, /- TCB Pest Control$/);
    }
  }
});

test("not yet due: the existing 'coming up' wording is unchanged", () => {
  const t2 = buildFollowUpTexts(customer(CATEGORY_UUID.generalPest), 2, SETTINGS, false);
  assert.equal(
    t2.sms,
    "Hi Sarah, just a friendly follow-up -- your general pest treatment is coming up due. Reply here or give us a call to lock in a time!\n\n- TCB Pest Control"
  );
  const t3 = buildFollowUpTexts(customer(CATEGORY_UUID.generalPest), 3, SETTINGS, false);
  assert.equal(t3.emailSubject, "Final reminder -- your general pest treatment is due");
});

test("the agreed overdue wording", () => {
  const t2 = buildFollowUpTexts(customer(CATEGORY_UUID.generalPest), 2, null, true);
  assert.equal(t2.sms, "Hi Sarah, just a friendly follow-up -- your general pest treatment is now overdue. Reply here or give us a call to book a time!");
  const t3 = buildFollowUpTexts(customer(CATEGORY_UUID.generalPest), 3, null, true);
  assert.equal(t3.sms, "Hi Sarah, final reminder -- your general pest treatment is overdue. Reply here or call us to book in and keep your home protected!");
  assert.equal(t3.emailSubject, "Final reminder -- your general pest treatment is overdue");
});

test("the termite-specific sentences survive in the overdue round 3", () => {
  assert.match(buildFollowUpTexts(customer(CATEGORY_UUID.termiteStations), 3, null, true).email, /essential to keep your termite protection active/);
  assert.match(buildFollowUpTexts(customer(CATEGORY_UUID.termiteInspection), 3, null, true).email, /catch termite activity early/);
});

test("isPastDue: on or after last service + interval", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  assert.equal(isPastDue({ last_completed_at: "2025-10-05 00:00:00" }, 12, now), true);
  assert.equal(isPastDue({ last_completed_at: "2025-10-06 00:00:00" }, 12, now), true, "due today counts");
  assert.equal(isPastDue({ last_completed_at: "2025-10-07 00:00:00" }, 12, now), false);
  assert.equal(isPastDue({ last_completed_at: "2026-07-01 00:00:00" }, 3, now), true);
  assert.equal(isPastDue({ last_completed_at: null }, 12, now), false);
  assert.equal(isPastDue({ last_completed_at: "2025-01-01 00:00:00" }, null, now), false);
});

// ---- engine -------------------------------------------------------------------

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10) + " 09:00:00";
}

function envWithCustomer({ completed, round }) {
  const env = makeSqliteEnv();
  env.db.prepare("INSERT INTO tenants (servicem8_account_uuid, installed_at) VALUES ('t', 0)").run();
  env.db.prepare("INSERT INTO tenant_settings (tenant_id, business_name) VALUES ('t', 'TCB Pest Control')").run();
  env.db.prepare("INSERT INTO category_config (id, tenant_id, servicem8_category_uuid, interval_months) VALUES ('rule1', 't', 'cat1', 12)").run();
  env.db
    .prepare(
      `INSERT INTO due_customers (id, tenant_id, category_config_id, servicem8_company_uuid, address_key, servicem8_category_uuid, last_completed_at, bucket, reminder_round, contact_name_cache, contact_phone_cache, contact_email_cache, computed_at)
       VALUES ('dc1', 't', 'rule1', 'co1', '1 test street', ?, ?, 'due', ?, 'Sarah Lim', '0412345678', 'sarah@example.com', 0)`
    )
    .run(CATEGORY_UUID.generalPest, completed, round);
  return env;
}
const draft = (env, channel, round) => env.db.prepare("SELECT * FROM reminder_drafts WHERE channel = ? AND round = ?").get(channel, round);

test("a round-2 customer a month past due gets overdue drafts", async () => {
  const env = envWithCustomer({ completed: monthsAgo(13), round: 2 });
  await generateFollowUpDraftsForTenant(env, "t");
  assert.match(draft(env, "sms", 2).draft_body, /now overdue/);
  assert.equal(draft(env, "email", 2).draft_subject, "Following up -- your general pest treatment is overdue");
});

test("a round-2 customer not yet due keeps the 'coming up due' wording", async () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 12);
  d.setDate(d.getDate() + 3); // due in 3 days -> inside round 2's 5-day lead
  const env = envWithCustomer({ completed: d.toISOString().slice(0, 10) + " 09:00:00", round: 2 });
  await generateFollowUpDraftsForTenant(env, "t");
  assert.match(draft(env, "sms", 2).draft_body, /coming up due/);
});

test("a queued 'due very soon' round-3 draft is rewritten once the customer is past due", async () => {
  const env = envWithCustomer({ completed: monthsAgo(13), round: 3 });
  const soon = buildFollowUpTexts({ contact_name_cache: "Sarah Lim", servicem8_category_uuid: CATEGORY_UUID.generalPest }, 3, SETTINGS, false);
  env.db
    .prepare("INSERT INTO reminder_drafts (id, tenant_id, due_customer_id, channel, round, draft_subject, draft_body, alt_draft_subject, alt_draft_body, status, created_at) VALUES ('e3', 't', 'dc1', 'email', 3, ?, ?, ?, ?, 'pending', 0)")
    .run(soon.emailSubject, soon.email, soon.emailAltSubject, soon.emailAlt);
  env.db
    .prepare("INSERT INTO reminder_drafts (id, tenant_id, due_customer_id, channel, round, draft_body, alt_draft_body, status, created_at) VALUES ('s3', 't', 'dc1', 'sms', 3, ?, ?, 'pending', 0)")
    .run(soon.sms, soon.smsAlt);

  assert.equal(await refreshOverdueFollowUpDrafts(env, "t"), 2);
  assert.equal(draft(env, "email", 3).draft_subject, "Final reminder -- your general pest treatment is overdue");
  assert.doesNotMatch(draft(env, "email", 3).alt_draft_body, SOON);
  assert.match(draft(env, "sms", 3).draft_body, /is overdue/);
  assert.equal(await refreshOverdueFollowUpDrafts(env, "t"), 0, "idempotent");
});

test("a pending draft that isn't our generated text, or one already sent, is left alone", async () => {
  const env = envWithCustomer({ completed: monthsAgo(13), round: 3 });
  const soon = buildFollowUpTexts({ contact_name_cache: "Sarah Lim", servicem8_category_uuid: CATEGORY_UUID.generalPest }, 3, SETTINGS, false);
  env.db
    .prepare("INSERT INTO reminder_drafts (id, tenant_id, due_customer_id, channel, round, draft_body, status, created_at) VALUES ('custom', 't', 'dc1', 'sms', 3, 'Hi Sarah, custom words due soon', 'pending', 0)")
    .run();
  env.db
    .prepare("INSERT INTO reminder_drafts (id, tenant_id, due_customer_id, channel, round, draft_body, alt_draft_body, status, created_at) VALUES ('sent', 't', 'dc1', 'email', 3, ?, ?, 'sent', 0)")
    .run(soon.email, soon.emailAlt);

  assert.equal(await refreshOverdueFollowUpDrafts(env, "t"), 0);
  assert.equal(draft(env, "sms", 3).draft_body, "Hi Sarah, custom words due soon");
  assert.equal(draft(env, "email", 3).draft_body, soon.email);
});
