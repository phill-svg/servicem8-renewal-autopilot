// Due-detection engine: generalizes the bucketing logic hand-validated this
// session against a real ServiceM8 job export (grouping by customer,
// months-since-last-completed-service, excluding already-rebooked
// customers) into a per-tenant, per-configured-category, D1-backed engine.
//
// The address-normalization approach here is the direct fix for a real bug
// found this session: grouping by company+full-address produced duplicate
// customer rows when the same property's address was formatted slightly
// differently across job records (suburb/state/postcode present on one job,
// missing on another). Keying on the street-address line only fixed it.

import { randomId, parseServiceM8Date, isoDate } from "./util.js";
import { listCompletedJobsForCategory, listCompletedJobsForBadge, listOpenJobsForCompany, getPrimaryContact, listCategories, listNotesForJob } from "./servicem8-api.js";

// Dispatches a tracking rule to the right job-fetch strategy. See
// schema.sql's category_config comment for why a rule can be either kind.
async function fetchJobsForRule(env, tenantId, rule, { before } = {}) {
  if (rule.signal_type === "badge") {
    return listCompletedJobsForBadge(env, tenantId, rule.servicem8_badge_uuid, { before });
  }
  return listCompletedJobsForCategory(env, tenantId, rule.servicem8_category_uuid, { before });
}

const BACKFILL_CHUNK_DAYS = 180; // ~6 months per chunk, keeps each API call and D1 batch bounded

function normalizeStreet(addr) {
  return (addr || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "");
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
function isSameCalendarMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// "Due now" starts either once the exact due date has passed (up to
// overdueGraceDays later, before flipping to "overdue"), OR as soon as the
// due date falls within the current calendar month even if the exact day
// hasn't arrived yet -- confirmed with the user: a renewal due Aug 28 should
// show as "due now" for all of August, not wait until the 28th.
function bucketFor(today, dueDate, dueSoonLeadDays, overdueGraceDays, overdueMaxDays, dueLaterLeadDays) {
  const daysPastDue = daysBetween(dueDate, today);

  // Beyond overdueMaxDays past the due date, stop surfacing it at all --
  // this old, it's a stale/lost-cause case, not worth cluttering the queue.
  if (overdueMaxDays != null && daysPastDue >= overdueMaxDays) return null;

  if (daysPastDue >= overdueGraceDays) return "overdue";
  if (daysPastDue >= 0) return "due";
  if (isSameCalendarMonth(today, dueDate)) return "due";

  const dueSoonStart = addDays(dueDate, -dueSoonLeadDays);
  if (today >= dueSoonStart) return "due_soon";

  // "Due later" -- a further-out, separate lookahead window past due_soon
  // (e.g. due_soon out to 2 months, due_later out to 3) so staff can see
  // what's coming without it being lumped into the same actionable "due
  // soon" list. NULL means this rule has no such extended window.
  if (dueLaterLeadDays != null) {
    const dueLaterStart = addDays(dueDate, -dueLaterLeadDays);
    if (today >= dueLaterStart) return "due_later";
  }
  return null; // not yet in any actionable bucket
}

// One chunk of historical backfill for a tenant: pulls jobs completed before
// the current cursor, in a bounded window, and advances the cursor. Called
// repeatedly by the short-interval cron sweep (see src/index.js's
// scheduled()) until backfill_complete=1. Kept separate from
// computeDueForTenant so a large tenant's full history is never fetched in
// one Worker invocation.
export async function backfillChunk(env, tenant) {
  const rules = await env.DB.prepare(
    "SELECT * FROM category_config WHERE tenant_id = ? AND is_tracked = 1"
  )
    .bind(tenant.servicem8_account_uuid)
    .all();

  const cursor = tenant.backfill_cursor ? new Date(tenant.backfill_cursor) : new Date();
  const chunkStart = addDays(cursor, -BACKFILL_CHUNK_DAYS);

  let sawAnyJob = false;
  for (const rule of rules.results || []) {
    const jobs = await fetchJobsForRule(env, tenant.servicem8_account_uuid, rule, { before: isoDate(cursor) });
    if (Array.isArray(jobs) && jobs.length) sawAnyJob = true;
    await upsertJobsAsDueCandidates(env, tenant.servicem8_account_uuid, rule, jobs || []);
  }

  const now = Date.now();
  if (chunkStart <= new Date("2000-01-01") || !sawAnyJob) {
    // Reached a sane floor, or this chunk found nothing at all -- treat as
    // done rather than walking back to the epoch forever on a quiet chunk.
    // (A tenant with a genuine multi-decade history but a gap in one
    // 6-month window would stop early here -- acceptable for v1, flagged as
    // a known simplification rather than silently "correct.")
    await env.DB.prepare("UPDATE tenants SET backfill_complete = 1, backfill_cursor = NULL WHERE servicem8_account_uuid = ?")
      .bind(tenant.servicem8_account_uuid)
      .run();
  } else {
    await env.DB.prepare("UPDATE tenants SET backfill_cursor = ? WHERE servicem8_account_uuid = ?")
      .bind(isoDate(chunkStart), tenant.servicem8_account_uuid)
      .run();
  }
}

// A warranty callback (free re-treatment if pests come back within the
// warranty period) isn't a real renewal-driving service visit -- it's a
// follow-up ON the job it's warrantying, not a fresh 12-month cycle. If one
// happens to be a customer's most recently *completed* job, picking it as
// the "last service" would push their due date out based on a free callback
// instead of their actual last paid treatment. Matched by name (not a
// hardcoded uuid) since category uuids are tenant-specific.
async function getWarrantyCategoryUuids(env, tenantId) {
  try {
    const categories = await listCategories(env, tenantId);
    return new Set((categories || []).filter((c) => /warranty/i.test(c.name || "")).map((c) => c.uuid));
  } catch (err) {
    console.error(`due-engine: failed to load categories for tenant ${tenantId}`, err);
    return new Set();
  }
}

// Groups raw jobs by (company_uuid, normalized street address), keeps the
// most-recently-completed job per group, and upserts a candidate row --
// shared by both the backfill path and the live webhook-triggered path.
async function upsertJobsAsDueCandidates(env, tenantId, rule, jobs) {
  const warrantyCategoryUuids = await getWarrantyCategoryUuids(env, tenantId);

  const groups = new Map();
  for (const job of jobs) {
    if (warrantyCategoryUuids.has(job.category_uuid)) continue; // see getWarrantyCategoryUuids
    const completedAt = parseServiceM8Date(job.completion_date);
    if (!completedAt || !job.company_uuid) continue;
    const key = `${job.company_uuid}|${normalizeStreet(job.job_address)}`;
    const existing = groups.get(key);
    if (!existing || completedAt > existing.completedAt) {
      groups.set(key, { job, completedAt, addressKey: normalizeStreet(job.job_address) });
    }
  }

  const today = new Date();
  for (const [, { job, completedAt, addressKey }] of groups) {
    const dueDate = addMonths(completedAt, rule.interval_months);
    const bucket = bucketFor(today, dueDate, rule.due_soon_lead_days, rule.overdue_grace_days, rule.overdue_max_days, rule.due_later_lead_days);
    if (!bucket) continue; // not due yet -- don't create noise rows for every customer, only actionable ones

    let suppressedReason = null;
    try {
      // Filter by matching address, not just company -- a client managing
      // multiple properties (e.g. a property manager) would otherwise have
      // an open job at ANY of their properties wrongly suppress reminders
      // for ALL of them. Confirmed live: a client with an open job at
      // "12/26 Cynthea Teague Crescent" was suppressing a due reminder for
      // their unrelated "117 Clift Crescent" property.
      const openJobs = await listOpenJobsForCompany(env, tenantId, job.company_uuid);
      const openJobsAtThisAddress = (openJobs || []).filter((oj) => normalizeStreet(oj.job_address) === addressKey);
      if (openJobsAtThisAddress.length > 0) suppressedReason = "open_pipeline_job";
    } catch (err) {
      // If the open-jobs check itself fails, don't block the due-candidate
      // row on it -- worst case a customer who's actually already rebooked
      // shows up in the queue once, which a human reviewing it will notice.
      console.error(`due-engine: open-jobs check failed for company ${job.company_uuid}:`, err);
    }

    let contact = null;
    try {
      contact = await getPrimaryContact(env, tenantId, job.company_uuid);
    } catch (err) {
      console.error(`due-engine: contact lookup failed for company ${job.company_uuid}:`, err);
    }

    // Real tech notes for the "Show job" teaser (src/dashboard.js) -- most
    // recent note first, since that's usually the on-site wrap-up ("No
    // issues, paid cc") rather than an earlier scheduling note.
    //
    // Excludes auto-logged call records from TCB's Aircall phone integration
    // (confirmed live 2026-08-04: every one of these came from the same
    // staff_uuid, a non-technician integration account, and reads like "Agent:
    // Farah Emara\nrecording: https://...\nDirection: inbound" -- picking
    // "most recent note" without this filter kept surfacing a call log from
    // months after the visit instead of the tech's actual completion note).
    const AIRCALL_INTEGRATION_STAFF_UUID = "88349e5a-d474-45b5-b299-23231e3c3c1b";
    function looksLikeCallLog(note) {
      return /recording:|^agent:|^call from|missed call from client/i.test(note || "");
    }
    let jobNotes = "";
    try {
      const notes = await listNotesForJob(env, tenantId, job.uuid);
      if (Array.isArray(notes) && notes.length) {
        // create_date, not timestamp -- confirmed live via /debug/raw once
        // read_job_notes was granted; note.json has no `timestamp` field.
        const realNotes = notes.filter(
          (n) => n.edit_by_staff_uuid !== AIRCALL_INTEGRATION_STAFF_UUID && !looksLikeCallLog(n.note)
        );
        const sorted = [...realNotes].sort((a, b) => new Date(b.create_date || 0) - new Date(a.create_date || 0));
        jobNotes = sorted[0]?.note || "";
      }
    } catch (err) {
      console.error(`due-engine: notes lookup failed for job ${job.uuid}:`, err);
    }

    const now = Date.now();
    // RETURNING id -- ON CONFLICT DO UPDATE keeps the row's *original* id, not
    // the freshly generated one bound below, so the id used for the reminder
    // draft lookup must come from what SQLite actually persisted. Keyed by
    // rule.id, not the job's category -- see schema.sql's comment on why a
    // badge-based rule's "current" category can change between recomputes.
    const row = await env.DB.prepare(
      `INSERT INTO due_customers (
         id, tenant_id, category_config_id, servicem8_company_uuid, address_key, address_display, servicem8_category_uuid,
         last_job_uuid, last_completed_at, bucket, suppressed_reason, dismissed_at,
         contact_name_cache, contact_email_cache, contact_phone_cache, last_job_notes_cache, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, servicem8_company_uuid, address_key, category_config_id) DO UPDATE SET
         servicem8_category_uuid = excluded.servicem8_category_uuid,
         last_job_uuid = excluded.last_job_uuid,
         last_completed_at = excluded.last_completed_at,
         bucket = excluded.bucket,
         suppressed_reason = excluded.suppressed_reason,
         -- A staff dismiss only applies to the cycle it was clicked on -- once
         -- a new completed job moves last_completed_at forward, that's a
         -- fresh cycle, so clear it. Otherwise leave whatever's there alone.
         dismissed_at = CASE WHEN excluded.last_completed_at != due_customers.last_completed_at THEN NULL ELSE due_customers.dismissed_at END,
         contact_name_cache = excluded.contact_name_cache,
         contact_email_cache = excluded.contact_email_cache,
         contact_phone_cache = excluded.contact_phone_cache,
         last_job_notes_cache = excluded.last_job_notes_cache,
         computed_at = excluded.computed_at
       RETURNING id`
    )
      .bind(
        randomId(),
        tenantId,
        rule.id,
        job.company_uuid,
        addressKey,
        job.job_address || "",
        job.category_uuid || null,
        job.uuid,
        job.completion_date,
        bucket,
        suppressedReason,
        contact?.name || "",
        contact?.email || "",
        contact?.mobile || contact?.phone || "",
        jobNotes,
        now
      )
      .first();

    if (!suppressedReason) {
      await maybeCreateReminderDraft(env, tenantId, row.id);
    }
  }
}

async function insertDraftIfMissing(env, tenantId, dueCustomerId, channel, round, subject, body) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO reminder_drafts (id, tenant_id, due_customer_id, channel, round, draft_subject, draft_body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(randomId(), tenantId, dueCustomerId, channel, round, subject, body, Date.now())
    .run();
}

// Creates draft reminders the first time a due_customers row enters an
// actionable bucket -- UNIQUE(due_customer_id, channel, round) makes
// re-running the engine idempotent, so this never spams duplicate drafts on
// repeat runs. Draft content is a sensible default until the tenant
// configures a real template in the Phase 2 setup wizard
// (tenant_settings.sms_template).
//
// Creates a draft for BOTH sms and email whenever the corresponding contact
// info exists, rather than only whichever channel tenant_settings.default_channel
// picks -- staff choose which one(s) to actually approve & send per customer
// in the dashboard, not locked into one channel account-wide.
//
// This is always round 1 -- the one staff send manually. Rounds 2/3 are the
// auto-generated follow-ups, see generateFollowUpDraftsForTenant below.
async function maybeCreateReminderDraft(env, tenantId, dueCustomerId) {
  const settings = await env.DB.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").bind(tenantId).first();
  const dueCustomer = await env.DB.prepare("SELECT * FROM due_customers WHERE id = ?").bind(dueCustomerId).first();

  // Generic "treatment"/"service", not "spray" -- this rule covers general
  // pest, rodent, commercial, and other job types, not just spray visits.
  const DEFAULT_SMS =
    "Hi {{name}}, it's been about 12 months since your last pest treatment -- time to book your next service to keep your home protected. Reply here or give us a call to book a time!";
  const DEFAULT_EMAIL_BODY =
    "Hi {{name}},\n\nIt's been about 12 months since your last pest treatment. Regular treatments are the best way to keep your home protected against pests all year round.\n\nReply to this email or give us a call to book your next appointment.";

  // First name only in the message body -- contact_name_cache stores the
  // full name (used elsewhere for staff-facing display), but "Hi Sarah" reads
  // far more natural than "Hi Sarah Lim" in an actual reminder.
  const firstName = (dueCustomer.contact_name_cache || "").trim().split(/\s+/)[0] || "there";

  if (dueCustomer.contact_phone_cache) {
    const body = (settings?.sms_template || DEFAULT_SMS).replace("{{name}}", firstName);
    await insertDraftIfMissing(env, tenantId, dueCustomerId, "sms", 1, null, body);
  }
  if (dueCustomer.contact_email_cache) {
    const subject = settings?.email_subject_template || "Time for your next pest treatment";
    const body = (settings?.email_body_template || DEFAULT_EMAIL_BODY).replace("{{name}}", firstName);
    await insertDraftIfMissing(env, tenantId, dueCustomerId, "email", 1, subject, body);
  }
}

// Auto-generated follow-up rounds, confirmed with the user 2026-08-04: round
// 1 is always sent manually; if it's actioned and the customer is still
// coming due, round 2 auto-drafts once within 5 days of the due date, and
// round 3 (the last one) auto-drafts once within 2 days of the due date --
// ordered by lead time (5 then 2) so round 3 always lands closer to the due
// date than round 2, regardless of which number the user calls it.
const FOLLOWUP_LEAD_DAYS = { 2: 5, 3: 2 };

const FOLLOWUP_TEMPLATES = {
  2: {
    sms: "Hi {{name}}, just a friendly follow-up -- your pest treatment is coming up due. Reply here or give us a call to lock in a time!",
    emailSubject: "Following up -- your pest treatment is due soon",
    email:
      "Hi {{name}},\n\nJust following up on your upcoming pest treatment -- it's due soon and we'd love to get you booked in.\n\nReply to this email or give us a call to arrange a time.",
  },
  3: {
    sms: "Hi {{name}}, final reminder -- your pest treatment is due very soon. Reply here or call us to book before it lapses!",
    emailSubject: "Final reminder -- your pest treatment is due",
    email:
      "Hi {{name}},\n\nThis is a final reminder that your pest treatment is due very soon.\n\nReply to this email or give us a call to book your next appointment before it lapses.",
  },
};

async function maybeCreateFollowUpDraft(env, tenantId, dueCustomer, intervalMonths) {
  const round = dueCustomer.reminder_round;
  const leadDays = FOLLOWUP_LEAD_DAYS[round];
  if (!leadDays) return; // round 1 (not sent yet) or round 4+ (sequence already exhausted)

  const completedAt = parseServiceM8Date(dueCustomer.last_completed_at);
  if (!completedAt) return;
  const dueDate = addMonths(completedAt, intervalMonths);
  const triggerFrom = addDays(dueDate, -leadDays);
  if (new Date() < triggerFrom) return; // not time yet for this round

  const firstName = (dueCustomer.contact_name_cache || "").trim().split(/\s+/)[0] || "there";
  const tmpl = FOLLOWUP_TEMPLATES[round];

  if (dueCustomer.contact_phone_cache) {
    await insertDraftIfMissing(env, tenantId, dueCustomer.id, "sms", round, null, tmpl.sms.replace("{{name}}", firstName));
  }
  if (dueCustomer.contact_email_cache) {
    await insertDraftIfMissing(env, tenantId, dueCustomer.id, "email", round, tmpl.emailSubject, tmpl.email.replace("{{name}}", firstName));
  }
}

// Called from the nightly cron alongside recomputeAllCategoriesForTenant.
// Only considers customers already mid-sequence (reminder_round 2 or 3) --
// round 1 is created by upsertJobsAsDueCandidates/maybeCreateReminderDraft
// when a customer first becomes due, not here. Naturally stops the sequence
// for a customer who's since become suppressed (rebooked) or been dismissed,
// since both are filtered out of the WHERE clause below.
export async function generateFollowUpDraftsForTenant(env, tenantId) {
  const { results: candidates } = await env.DB.prepare(
    `SELECT * FROM due_customers WHERE tenant_id = ? AND suppressed_reason IS NULL AND dismissed_at IS NULL AND reminder_round IN (2, 3)`
  )
    .bind(tenantId)
    .all();
  if (!candidates || !candidates.length) return;

  const { results: rules } = await env.DB.prepare("SELECT * FROM category_config WHERE tenant_id = ?").bind(tenantId).all();
  const intervalByRuleId = new Map((rules || []).map((r) => [r.id, r.interval_months]));

  for (const dueCustomer of candidates) {
    const intervalMonths = intervalByRuleId.get(dueCustomer.category_config_id);
    if (!intervalMonths) continue;
    try {
      await maybeCreateFollowUpDraft(env, tenantId, dueCustomer, intervalMonths);
    } catch (err) {
      console.error(`due-engine: follow-up draft generation failed for due_customer ${dueCustomer.id}`, err);
    }
  }
}

// Full recompute for one rule on one tenant -- used by the live
// webhook-triggered path (a single job.completed doesn't need a backfill
// chunk, it needs this rule's candidates refreshed) and by the nightly
// reconciliation cron as the source-of-truth backstop.
export async function recomputeCategory(env, tenantId, rule) {
  const jobs = await fetchJobsForRule(env, tenantId, rule);
  await upsertJobsAsDueCandidates(env, tenantId, rule, jobs || []);
}

export async function recomputeAllCategoriesForTenant(env, tenantId) {
  const { results } = await env.DB.prepare("SELECT * FROM category_config WHERE tenant_id = ? AND is_tracked = 1")
    .bind(tenantId)
    .all();
  let jobsScanned = 0;
  for (const rule of results || []) {
    const jobs = await fetchJobsForRule(env, tenantId, rule);
    jobsScanned += (jobs || []).length;
    await upsertJobsAsDueCandidates(env, tenantId, rule, jobs || []);
  }
  return { jobsScanned };
}
