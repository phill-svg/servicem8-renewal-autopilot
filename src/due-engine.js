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
import { listCompletedJobsForCategory, listCompletedJobsForBadge, listOpenJobsForCompany, getPrimaryContact, listBadges, createBadge } from "./servicem8-api.js";

// Renewal Autopilot's own green-branded badges, created fresh in every
// installing tenant's account rather than reusing whatever follow-up badges
// they already have (avoids disturbing an existing workflow) -- see
// 2026-08-03 decision. Only the 1-year one gets auto-wired into a tracking
// rule for now; 3/6-month are created for future use but left unconfigured.
// Plain color + text, no icon glyph -- matches the "CHASE PAYMENT" style
// badge Phill made natively in ServiceM8 (their own "no icon" picker option),
// each with its cadence baked into the image as text since ServiceM8 doesn't
// overlay the badge name as text on custom-image badges the way it does for
// its own icon-picker badges.
const RENEWAL_BADGES = [
  { name: "Renewal Autopilot - 3 Month", file: "badge-3month-v3.png" },
  { name: "Renewal Autopilot - 6 Month", file: "badge-6month-v3.png" },
  { name: "Renewal Autopilot - 1 Year", file: "badge-1year-v3.png" },
];
const AUTO_TRACKED_BADGE_NAME = "Renewal Autopilot - 1 Year";
const AUTO_TRACKED_INTERVAL_MONTHS = 12;

// Idempotent: run on every install/reinstall. Looks up existing badges by
// exact name first so a reinstall never creates duplicates, then ensures the
// 1-year badge has a default tracking rule if this tenant doesn't have one
// yet (does not overwrite a rule the tenant may have since customized).
export async function ensureRenewalBadgesAndDefaultRule(env, tenantId, origin) {
  let existing = [];
  try {
    existing = (await listBadges(env, tenantId)) || [];
  } catch (err) {
    console.error(`ensureRenewalBadges: failed to list existing badges for tenant ${tenantId}`, err);
  }
  const existingByName = new Map(existing.map((b) => [b.name, b.uuid]));

  const uuidByName = {};
  for (const { name, file } of RENEWAL_BADGES) {
    if (existingByName.has(name)) {
      uuidByName[name] = existingByName.get(name);
      continue;
    }
    try {
      uuidByName[name] = await createBadge(env, tenantId, { name, fileUrl: `${origin}/assets/images/${file}` });
    } catch (err) {
      console.error(`ensureRenewalBadges: failed to create badge "${name}" for tenant ${tenantId}`, err);
    }
  }

  const trackedBadgeUuid = uuidByName[AUTO_TRACKED_BADGE_NAME];
  if (!trackedBadgeUuid) return;

  const alreadyConfigured = await env.DB.prepare(
    "SELECT id FROM category_config WHERE tenant_id = ? AND signal_type = 'badge' AND servicem8_badge_uuid = ?"
  )
    .bind(tenantId, trackedBadgeUuid)
    .first();
  if (alreadyConfigured) return;

  await env.DB.prepare(
    `INSERT INTO category_config (id, tenant_id, signal_type, servicem8_badge_uuid, category_name_cache, interval_months)
     VALUES (?, ?, 'badge', ?, ?, ?)`
  )
    .bind(randomId(), tenantId, trackedBadgeUuid, AUTO_TRACKED_BADGE_NAME, AUTO_TRACKED_INTERVAL_MONTHS)
    .run();
}

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
function bucketFor(today, dueDate, dueSoonLeadDays, overdueGraceDays, overdueMaxDays) {
  const daysPastDue = daysBetween(dueDate, today);

  // Beyond overdueMaxDays past the due date, stop surfacing it at all --
  // this old, it's a stale/lost-cause case, not worth cluttering the queue.
  if (overdueMaxDays != null && daysPastDue >= overdueMaxDays) return null;

  if (daysPastDue >= overdueGraceDays) return "overdue";
  if (daysPastDue >= 0) return "due";
  if (isSameCalendarMonth(today, dueDate)) return "due";

  const dueSoonStart = addDays(dueDate, -dueSoonLeadDays);
  if (today >= dueSoonStart) return "due_soon";
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

// Groups raw jobs by (company_uuid, normalized street address), keeps the
// most-recently-completed job per group, and upserts a candidate row --
// shared by both the backfill path and the live webhook-triggered path.
async function upsertJobsAsDueCandidates(env, tenantId, rule, jobs) {
  const groups = new Map();
  for (const job of jobs) {
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
    const bucket = bucketFor(today, dueDate, rule.due_soon_lead_days, rule.overdue_grace_days, rule.overdue_max_days);
    if (!bucket) continue; // not due yet -- don't create noise rows for every customer, only actionable ones

    let suppressedReason = null;
    try {
      const openJobs = await listOpenJobsForCompany(env, tenantId, job.company_uuid);
      if (Array.isArray(openJobs) && openJobs.length > 0) suppressedReason = "open_pipeline_job";
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
         contact_name_cache, contact_email_cache, contact_phone_cache, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
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
        now
      )
      .first();

    if (!suppressedReason) {
      await maybeCreateReminderDraft(env, tenantId, row.id);
    }
  }
}

// Creates draft reminders the first time a due_customers row enters an
// actionable bucket -- UNIQUE(due_customer_id, channel) makes re-running the
// engine idempotent, so this never spams duplicate drafts on repeat runs.
// Draft content is a sensible default until the tenant configures a real
// template in the Phase 2 setup wizard (tenant_settings.sms_template).
//
// Creates a draft for BOTH sms and email whenever the corresponding contact
// info exists, rather than only whichever channel tenant_settings.default_channel
// picks -- staff choose which one(s) to actually approve & send per customer
// in the dashboard, not locked into one channel account-wide.
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

  const channels = [];
  if (dueCustomer.contact_phone_cache) channels.push("sms");
  if (dueCustomer.contact_email_cache) channels.push("email");

  for (const channel of channels) {
    const body =
      channel === "sms"
        ? (settings?.sms_template || DEFAULT_SMS).replace("{{name}}", firstName)
        : (settings?.email_body_template || DEFAULT_EMAIL_BODY).replace("{{name}}", firstName);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO reminder_drafts (id, tenant_id, due_customer_id, channel, draft_subject, draft_body, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(
        randomId(),
        tenantId,
        dueCustomerId,
        channel,
        channel === "email" ? settings?.email_subject_template || "Time for your next pest treatment" : null,
        body,
        Date.now()
      )
      .run();
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
