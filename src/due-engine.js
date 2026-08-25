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
import { listCompletedJobsForCategory, listCompletedJobsForBadge, listOpenJobsForCompany, getPrimaryContact, listCategories, listNotesForJob, listBadges, createBadge, updateBadge, listJobSmsRecords, listJobEmailRecords, listAllCompletedJobs, listAllJobsAnyStatus, parseBadges, updateJobBadges } from "./servicem8-api.js";

// Renewal Autopilot's own badges, auto-created in every installing tenant's
// ServiceM8 account so a new business doesn't have to hand-make one before
// the add-on is useful. Each points at a generic pre-designed 3-state sprite
// (64x192, three stacked 64x64 states -- inactive/hover/active, the format
// ServiceM8 requires) that just shows the cadence in plain text ("1 YEAR" /
// "6 MONTH" / "3 MONTH"), so they're business-agnostic. v9 recolors the
// three states to match ServiceM8's own default badge convention -- gray
// (inactive) / yellow (hover) / green (active) -- instead of v8's solid
// green in all three states. A bare API-created badge with no image renders
// blank (verified 2026-08-04), which is why a real file_name is essential
// here rather than relying on ServiceM8 to draw the badge itself.
export const RENEWAL_BADGES = [
  { name: "3 month auto", file: "phill-3month-v9.png", intervalMonths: 3 },
  { name: "6 month auto", file: "phill-6month-v9.png", intervalMonths: 6 },
  { name: "1 year auto", file: "phill-1year-v9.png", intervalMonths: 12 },
];

// Pure planning step, split out from ensureRenewalBadges for testing without
// a live account: decides which RENEWAL_BADGES need creating (no existing
// badge with that exact name) vs. re-fetching (a badge with that name exists,
// but its stored file_name doesn't match the URL we'd create it with today).
// ServiceM8 copies/caches the image at the file_name URL rather than
// proxying it live, so a badge created (or last refreshed) against a
// since-changed sprite -- e.g. the v9 gray/yellow/green recolor -- silently
// keeps showing the old image until something re-POSTs the current
// file_name. /debug/update-badge-images (see src/index.js) does this
// on demand; the sweep below does it automatically so nobody has to run it.
export function planBadgeSync(existingBadges, renewalBadges, origin) {
  const existingByName = new Map((existingBadges || []).map((b) => [b.name, b]));
  const toCreate = [];
  const toRefresh = [];
  for (const { name, file } of renewalBadges) {
    const fileUrl = `${origin}/assets/images/${file}`;
    const existing = existingByName.get(name);
    if (!existing) {
      toCreate.push({ name, fileUrl });
    } else if (existing.file_name !== fileUrl) {
      toRefresh.push({ name, uuid: existing.uuid, fileUrl });
    }
  }
  return { toCreate, toRefresh };
}

// Idempotent -- safe to run on every install AND on a recurring sweep (see
// the cron wiring in src/index.js): a badge whose name and file_name already
// match RENEWAL_BADGES is left alone, so steady state is a no-op. Returns a
// { name: uuid } map of all Renewal badges now present. Does NOT wire a
// tracking rule -- that's the setup wizard's job (the business picks which
// cadence to track and confirms the interval/templates).
export async function ensureRenewalBadges(env, tenantId, origin) {
  let existing = [];
  try {
    existing = (await listBadges(env, tenantId)) || [];
  } catch (err) {
    console.error(`ensureRenewalBadges: failed to list badges for tenant ${tenantId}`, err);
  }

  const uuidByName = {};
  for (const b of existing) {
    if (RENEWAL_BADGES.some((r) => r.name === b.name)) uuidByName[b.name] = b.uuid;
  }

  const { toCreate, toRefresh } = planBadgeSync(existing, RENEWAL_BADGES, origin);

  for (const { name, fileUrl } of toCreate) {
    try {
      uuidByName[name] = await createBadge(env, tenantId, { name, fileUrl });
    } catch (err) {
      console.error(`ensureRenewalBadges: failed to create badge "${name}" for tenant ${tenantId}`, err);
    }
  }
  for (const { name, uuid, fileUrl } of toRefresh) {
    try {
      await updateBadge(env, tenantId, uuid, { fileUrl });
    } catch (err) {
      console.error(`ensureRenewalBadges: failed to refresh image for badge "${name}" (tenant ${tenantId})`, err);
    }
  }
  return uuidByName;
}

// One-off legacy-badge migration: "1 Year Follow-up" predates "1 year auto"
// and is no longer a tracked rule (is_tracked = 0 in category_config), so any
// job that only carries the old badge is invisible to the engine. Every job
// carrying fromBadgeUuid but not toBadgeUuid should also carry toBadgeUuid --
// read-modify-write, preserving whatever else is on the job. Pure planning
// step so the "which jobs need this" decision is testable without a live
// account. Safe to run repeatedly: a job already carrying both is skipped, and
// if a property ends up with toBadgeUuid on more than one job (an older
// migrated job plus a newer one already using it), the existing badge
// hand-off pass (reassignBadgesForTenant) already knows how to consolidate
// multiple badged jobs onto the latest -- see "consolidates multiple badged
// jobs onto the latest" in test/badge-handoff.test.js.
export function planLegacyBadgeMigration(jobsList, fromBadgeUuid, toBadgeUuid) {
  return (jobsList || []).filter((job) => {
    const badges = parseBadges(job.badges);
    return badges.includes(fromBadgeUuid) && !badges.includes(toBadgeUuid);
  });
}

export async function migrateLegacyFollowUpBadges(env, tenantId) {
  let badgesList = [];
  try {
    badgesList = (await listBadges(env, tenantId)) || [];
  } catch (err) {
    console.error(`migrateLegacyFollowUpBadges: failed to list badges for tenant ${tenantId}`, err);
    return;
  }
  const fromBadge = badgesList.find((b) => b.name === "1 Year Follow-up");
  const toBadge = badgesList.find((b) => b.name === "1 year auto");
  if (!fromBadge || !toBadge) return; // nothing to migrate for a tenant without both badges

  let allJobs = [];
  try {
    allJobs = (await listAllJobsAnyStatus(env, tenantId)) || [];
  } catch (err) {
    console.error(`migrateLegacyFollowUpBadges: failed to list jobs for tenant ${tenantId}`, err);
    return;
  }

  const toMigrate = planLegacyBadgeMigration(allJobs, fromBadge.uuid, toBadge.uuid);
  for (const job of toMigrate) {
    try {
      const next = [...new Set([...parseBadges(job.badges), toBadge.uuid])];
      await updateJobBadges(env, tenantId, job.uuid, next);
    } catch (err) {
      console.error(`migrateLegacyFollowUpBadges: failed to update job ${job.uuid} (tenant ${tenantId})`, err);
    }
  }
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

// The dedupe key that decides which jobs belong to the same customer at the
// same property. Exported for tests because getting it wrong silently merges
// two properties into one -- and since 2026-08-12 that mistake is visible in
// ServiceM8, where the badge hand-off would move a badge across them.
//
// The slash is KEPT: stripping it turned "2/9 Hopman Pl" into "29 hopman pl",
// identical to a real 29 Hopman Pl on the same street. 14% of TCB's tracked
// addresses are units, so this was one property-manager client away from
// merging two homes. No such collision existed in the live data when this was
// fixed, which is why the key migration was a clean rename.
export function normalizeStreet(addr) {
  return (addr || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 /]/g, "");
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

// "Due now" starts either once the exact due date has passed (up to
// overdueGraceDays later, before flipping to "overdue"), OR as soon as the
// due date falls within the next 1 month from today, even if the exact day
// hasn't arrived yet -- a rolling window (today .. today+1 month), not tied
// to calendar-month boundaries, so a renewal due early next month shows as
// "due now" the same way one due late next month would once it's within a
// month out.
function bucketFor(today, dueDate, dueSoonLeadDays, overdueGraceDays, overdueMaxDays, dueLaterLeadDays) {
  const daysPastDue = daysBetween(dueDate, today);

  // Beyond overdueMaxDays past the due date, stop surfacing it at all --
  // this old, it's a stale/lost-cause case, not worth cluttering the queue.
  if (overdueMaxDays != null && daysPastDue >= overdueMaxDays) return null;

  if (daysPastDue >= overdueGraceDays) return "overdue";
  if (daysPastDue >= 0) return "due";
  if (dueDate <= addMonths(today, 1)) return "due";

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
    // job.job_description is the original booking description (NOT
    // work_done_description -- see listNotesForJob's comment in
    // servicem8-api.js). Used to tell apart what a badge-/category-matched
    // job actually was when the category alone doesn't say, e.g. "Termite
    // Management Treatment" covering both bait-station checks and
    // inspections -- see templateForCategory below.
    const jobDescription = job.job_description || job.description || "";

    const row = await env.DB.prepare(
      `INSERT INTO due_customers (
         id, tenant_id, category_config_id, servicem8_company_uuid, address_key, address_display, servicem8_category_uuid,
         last_job_uuid, last_job_number, last_completed_at, bucket, suppressed_reason, dismissed_at,
         contact_name_cache, contact_email_cache, contact_phone_cache, last_job_notes_cache, last_job_description_cache, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, servicem8_company_uuid, address_key, category_config_id) DO UPDATE SET
         servicem8_category_uuid = excluded.servicem8_category_uuid,
         last_job_uuid = excluded.last_job_uuid,
         last_job_number = CASE WHEN excluded.last_job_number IS NOT NULL THEN excluded.last_job_number ELSE due_customers.last_job_number END,
         last_completed_at = excluded.last_completed_at,
         bucket = excluded.bucket,
         suppressed_reason = excluded.suppressed_reason,
         -- A staff dismiss only applies to the cycle it was clicked on -- once
         -- a new completed job moves last_completed_at forward, that's a
         -- fresh cycle, so clear it. Otherwise leave whatever's there alone.
         dismissed_at = CASE WHEN excluded.last_completed_at != due_customers.last_completed_at THEN NULL ELSE due_customers.dismissed_at END,
         -- Never overwrite a good cached contact/name with a blank: a failed
         -- or rate-limited lookup returns "" and would otherwise wipe details
         -- we'd previously fetched (this is what produced "Unknown" rows).
         contact_name_cache = CASE WHEN excluded.contact_name_cache != '' THEN excluded.contact_name_cache ELSE due_customers.contact_name_cache END,
         contact_email_cache = CASE WHEN excluded.contact_email_cache != '' THEN excluded.contact_email_cache ELSE due_customers.contact_email_cache END,
         contact_phone_cache = CASE WHEN excluded.contact_phone_cache != '' THEN excluded.contact_phone_cache ELSE due_customers.contact_phone_cache END,
         last_job_notes_cache = CASE WHEN excluded.last_job_notes_cache != '' THEN excluded.last_job_notes_cache ELSE due_customers.last_job_notes_cache END,
         last_job_description_cache = CASE WHEN excluded.last_job_description_cache != '' THEN excluded.last_job_description_cache ELSE due_customers.last_job_description_cache END,
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
        job.generated_job_id || null,
        job.completion_date,
        bucket,
        suppressedReason,
        contact?.name || "",
        contact?.email || "",
        contact?.mobile || contact?.phone || "",
        jobNotes,
        jobDescription,
        now
      )
      .first();

    if (!suppressedReason) {
      await maybeCreateReminderDraft(env, tenantId, row.id);
    }
  }
}

async function insertDraftIfMissing(env, tenantId, dueCustomerId, channel, round, subject, body, altSubject = null, altBody = null) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO reminder_drafts (id, tenant_id, due_customer_id, channel, round, draft_subject, draft_body, alt_draft_subject, alt_draft_body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(randomId(), tenantId, dueCustomerId, channel, round, subject, body, altSubject, altBody, Date.now())
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
// Round-1 message templates keyed by ServiceM8 Job Category UUID, so a
// termite inspection reminder reads like a termite inspection reminder
// instead of the old one-size-fits-all "pest treatment" wording. "default"
// covers any category without its own entry (Commercial Treatment, Wildlife
// Control, etc.) -- these UUIDs are TCB's own live category ids, confirmed
// 2026-08-24 via list_categories.
export const CATEGORY_UUID = {
  generalPest: "97af1d3c-07ac-4aae-8862-23184055ce5b", // Premium Pest Treatment
  rodent: "65374f33-5111-4411-976d-232fc24a43ab", // Rodent Treatment
  termiteStations: "4b0df417-bd76-44a5-b9b9-231843331c3b", // Termite Management Treatment (bait station servicing)
  termiteInspection: "41bd4556-8fed-4626-b853-241e0b8b876b", // Termite Inspection
};

const REMINDER_TEMPLATES = {
  default: {
    sms: "Hi {{name}}, it's been about 12 months since your last pest treatment -- time to book your next service to keep your home protected. Reply here or give us a call to book a time!",
    emailSubject: "Time for your next pest treatment",
    email:
      "Hi {{name}},\n\nIt's been about 12 months since your last pest treatment. Regular treatments are the best way to keep your home protected against pests all year round.\n\nReply to this email or give us a call to book your next appointment.",
  },
  [CATEGORY_UUID.generalPest]: {
    sms: "Hi {{name}}, it's time to book your next general pest treatment to keep your home protected. Reply here or give us a call to book a time!",
    emailSubject: "Time for your next general pest treatment",
    email:
      "Hi {{name}},\n\nIt's time for your next general pest treatment. Regular treatments are the best way to keep your home protected against pests all year round.\n\nReply to this email or give us a call to book your next appointment.",
  },
  [CATEGORY_UUID.rodent]: {
    sms: "Hi {{name}}, it's time for your next rodent treatment check-up. Reply here or give us a call to book a time!",
    emailSubject: "Time for your next rodent treatment",
    email:
      "Hi {{name}},\n\nIt's time for your next rodent treatment check-up. Regular monitoring keeps your property protected against rodent activity.\n\nReply to this email or give us a call to book your next appointment.",
  },
  [CATEGORY_UUID.termiteStations]: {
    sms: "Hi {{name}}, your termite bait stations are due for their next check. Reply here or give us a call to book a time!",
    emailSubject: "Your termite bait stations are due for a check",
    email:
      "Hi {{name}},\n\nYour termite bait stations are due for their next check. Regular monitoring is essential to keep your termite protection active.\n\nReply to this email or give us a call to book your next appointment.",
  },
  [CATEGORY_UUID.termiteInspection]: {
    sms: "Hi {{name}}, it's time for your next termite inspection. Reply here or give us a call to book a time!",
    emailSubject: "Time for your next termite inspection",
    email:
      "Hi {{name}},\n\nIt's time for your annual termite inspection. Regular inspections are the best way to catch termite activity early, before it causes damage.\n\nReply to this email or give us a call to book your next appointment.",
  },
  // Not a real category -- a second style for General Pest customers to
  // toggle to (see secondaryTemplateFor), the same way termite's two real
  // categories double as each other's alternate.
  generalPestAlt: {
    sms: "Hi {{name}}, your general pest treatment is due! Get in touch to lock in a time that suits you.",
    emailSubject: "Your general pest treatment is due",
    email:
      "Hi {{name}},\n\nYour general pest treatment is due. A quick treatment now keeps pests from creeping back in.\n\nGet in touch or give us a call to arrange a time that works for you.",
  },
  rodentAlt: {
    sms: "Hi {{name}}, your rodent treatment check-up is due! Get in touch to lock in a time that suits you.",
    emailSubject: "Your rodent treatment check-up is due",
    email:
      "Hi {{name}},\n\nYour rodent treatment check-up is due. Staying on top of this keeps rodent activity from building back up.\n\nGet in touch or give us a call to arrange a time that works for you.",
  },
};

// Falls back to "default" for any category without its own entry -- pulled
// out as a pure function so the category->template mapping is testable
// without touching the DB.
export function templateForCategory(templates, categoryUuid) {
  return templates[categoryUuid] || templates.default;
}

// ServiceM8's "Termite Management Treatment" category covers both bait
// station servicing AND inspections in practice -- staff book both under it,
// so the category UUID alone doesn't say which one a given job actually was
// (confirmed 2026-08-25 by reading descriptions: most turned out to be
// inspections). Rather than guess wrong and only offer one wording, default
// to whichever the description suggests and always offer the other one too
// (see secondaryTemplateFor) so a wrong guess is a toggle, not a mistake a
// customer sees. Pure/testable: takes the raw category+description in,
// no DB access.
export function resolveCategoryUuid(categoryUuid, description) {
  if (categoryUuid === CATEGORY_UUID.termiteStations && /inspection/i.test(description || "")) {
    return CATEGORY_UUID.termiteInspection;
  }
  return categoryUuid;
}

// The second draft option staff can toggle to instead of the default --
// termite's two categories double as each other's alternate (a wrong
// stations/inspection guess is one click to fix); general pest and rodent
// get a differently-styled second wording. Returns null for any category
// with no meaningful alternate (Commercial Treatment, Wildlife Control, ...).
export function secondaryTemplateFor(templates, categoryUuid) {
  if (categoryUuid === CATEGORY_UUID.termiteStations) return templates[CATEGORY_UUID.termiteInspection];
  if (categoryUuid === CATEGORY_UUID.termiteInspection) return templates[CATEGORY_UUID.termiteStations];
  if (categoryUuid === CATEGORY_UUID.generalPest) return templates.generalPestAlt;
  if (categoryUuid === CATEGORY_UUID.rodent) return templates.rodentAlt;
  return null;
}

async function maybeCreateReminderDraft(env, tenantId, dueCustomerId) {
  const settings = await env.DB.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").bind(tenantId).first();
  const dueCustomer = await env.DB.prepare("SELECT * FROM due_customers WHERE id = ?").bind(dueCustomerId).first();
  const effectiveCategory = resolveCategoryUuid(dueCustomer.servicem8_category_uuid, dueCustomer.last_job_description_cache);
  const tmpl = templateForCategory(REMINDER_TEMPLATES, effectiveCategory);
  const altTmpl = secondaryTemplateFor(REMINDER_TEMPLATES, effectiveCategory);

  // First name only in the message body -- contact_name_cache stores the
  // full name (used elsewhere for staff-facing display), but "Hi Sarah" reads
  // far more natural than "Hi Sarah Lim" in an actual reminder.
  const firstName = (dueCustomer.contact_name_cache || "").trim().split(/\s+/)[0] || "there";

  // A tenant-configured override (Phase 2 setup wizard) still wins for
  // everyone, same as before this change -- the category templates only
  // kick in when no custom template has been set. A custom override has no
  // concept of a second option, so no alt is offered when one's set.
  if (dueCustomer.contact_phone_cache) {
    if (settings?.sms_template) {
      const body = signOff(settings.sms_template.replace("{{name}}", firstName), settings);
      await insertDraftIfMissing(env, tenantId, dueCustomerId, "sms", 1, null, body);
    } else {
      const body = signOff(tmpl.sms.replace("{{name}}", firstName), settings);
      const altBody = altTmpl ? signOff(altTmpl.sms.replace("{{name}}", firstName), settings) : null;
      await insertDraftIfMissing(env, tenantId, dueCustomerId, "sms", 1, null, body, null, altBody);
    }
  }
  if (dueCustomer.contact_email_cache) {
    if (settings?.email_body_template) {
      const subject = settings.email_subject_template || tmpl.emailSubject;
      const body = signOff(settings.email_body_template.replace("{{name}}", firstName), settings);
      await insertDraftIfMissing(env, tenantId, dueCustomerId, "email", 1, subject, body);
    } else {
      const body = signOff(tmpl.email.replace("{{name}}", firstName), settings);
      const altSubject = altTmpl?.emailSubject || null;
      const altBody = altTmpl ? signOff(altTmpl.email.replace("{{name}}", firstName), settings) : null;
      await insertDraftIfMissing(env, tenantId, dueCustomerId, "email", 1, tmpl.emailSubject, body, altSubject, altBody);
    }
  }
}

// Appends the installing business's own name as a sign-off, so every reminder
// is clearly from them (captured from /vendor.json on install -- see
// tenant_settings.business_name). No-op if the name isn't known yet or is
// already present at the end of the body.
function signOff(body, settings) {
  const name = (settings?.business_name || "").trim();
  if (!name) return body;
  if (body.trimEnd().endsWith(name)) return body;
  return `${body}\n\n- ${name}`;
}

// Auto-generated follow-up rounds, confirmed with the user 2026-08-04: round
// 1 is always sent manually; if it's actioned and the customer is still
// coming due, round 2 auto-drafts once within 5 days of the due date, and
// round 3 (the last one) auto-drafts once within 2 days of the due date --
// ordered by lead time (5 then 2) so round 3 always lands closer to the due
// date than round 2, regardless of which number the user calls it.
const FOLLOWUP_LEAD_DAYS = { 2: 5, 3: 2 };

// The date the next auto-drafted follow-up is due to appear: the customer's
// due date, minus this round's lead time. Exported because the dashboard
// shows staff this exact date -- deriving it there instead would duplicate
// FOLLOWUP_LEAD_DAYS and let the display drift from what the engine really
// does the moment the schedule is tuned.
//
// Returns null when no round is scheduled: round 1 is sent by hand, and
// round 4 means the sequence is exhausted and nothing further will ever be
// generated.
export function nextFollowUpDraftDate(dueCustomer, intervalMonths) {
  const leadDays = FOLLOWUP_LEAD_DAYS[dueCustomer.reminder_round];
  if (!leadDays || !intervalMonths) return null;
  const completedAt = parseServiceM8Date(dueCustomer.last_completed_at);
  if (!completedAt) return null;
  return addDays(addMonths(completedAt, intervalMonths), -leadDays);
}

// Same per-category flavoring as REMINDER_TEMPLATES (round 1), keeping each
// round's own escalating tone -- "just following up" for round 2, "final
// reminder" for round 3.
const FOLLOWUP_TEMPLATES = {
  2: {
    default: {
      sms: "Hi {{name}}, just a friendly follow-up -- your pest treatment is coming up due. Reply here or give us a call to lock in a time!",
      emailSubject: "Following up -- your pest treatment is due soon",
      email:
        "Hi {{name}},\n\nJust following up on your upcoming pest treatment -- it's due soon and we'd love to get you booked in.\n\nReply to this email or give us a call to arrange a time.",
    },
    [CATEGORY_UUID.generalPest]: {
      sms: "Hi {{name}}, just a friendly follow-up -- your general pest treatment is coming up due. Reply here or give us a call to lock in a time!",
      emailSubject: "Following up -- your general pest treatment is due soon",
      email:
        "Hi {{name}},\n\nJust following up on your upcoming general pest treatment -- it's due soon and we'd love to get you booked in.\n\nReply to this email or give us a call to arrange a time.",
    },
    [CATEGORY_UUID.rodent]: {
      sms: "Hi {{name}}, just a friendly follow-up -- your rodent treatment check-up is coming up due. Reply here or give us a call to lock in a time!",
      emailSubject: "Following up -- your rodent treatment is due soon",
      email:
        "Hi {{name}},\n\nJust following up on your upcoming rodent treatment check-up -- it's due soon and we'd love to get you booked in.\n\nReply to this email or give us a call to arrange a time.",
    },
    [CATEGORY_UUID.termiteStations]: {
      sms: "Hi {{name}}, just a friendly follow-up -- your termite bait station check is coming up due. Reply here or give us a call to lock in a time!",
      emailSubject: "Following up -- your termite bait station check is due soon",
      email:
        "Hi {{name}},\n\nJust following up on your upcoming termite bait station check -- it's due soon and we'd love to get you booked in.\n\nReply to this email or give us a call to arrange a time.",
    },
    [CATEGORY_UUID.termiteInspection]: {
      sms: "Hi {{name}}, just a friendly follow-up -- your termite inspection is coming up due. Reply here or give us a call to lock in a time!",
      emailSubject: "Following up -- your termite inspection is due soon",
      email:
        "Hi {{name}},\n\nJust following up on your upcoming termite inspection -- it's due soon and we'd love to get you booked in.\n\nReply to this email or give us a call to arrange a time.",
    },
    generalPestAlt: {
      sms: "Hi {{name}}, your general pest treatment is coming up due -- get in touch to lock in a time!",
      emailSubject: "Your general pest treatment is coming up due",
      email:
        "Hi {{name}},\n\nYour general pest treatment is coming up due. Get in touch or give us a call to arrange a time that works for you.",
    },
    rodentAlt: {
      sms: "Hi {{name}}, your rodent treatment check-up is coming up due -- get in touch to lock in a time!",
      emailSubject: "Your rodent treatment check-up is coming up due",
      email:
        "Hi {{name}},\n\nYour rodent treatment check-up is coming up due. Get in touch or give us a call to arrange a time that works for you.",
    },
  },
  3: {
    default: {
      sms: "Hi {{name}}, final reminder -- your pest treatment is due very soon. Reply here or call us to book before it lapses!",
      emailSubject: "Final reminder -- your pest treatment is due",
      email:
        "Hi {{name}},\n\nThis is a final reminder that your pest treatment is due very soon.\n\nReply to this email or give us a call to book your next appointment before it lapses.",
    },
    [CATEGORY_UUID.generalPest]: {
      sms: "Hi {{name}}, final reminder -- your general pest treatment is due very soon. Reply here or call us to book before it lapses!",
      emailSubject: "Final reminder -- your general pest treatment is due",
      email:
        "Hi {{name}},\n\nThis is a final reminder that your general pest treatment is due very soon.\n\nReply to this email or give us a call to book your next appointment before it lapses.",
    },
    [CATEGORY_UUID.rodent]: {
      sms: "Hi {{name}}, final reminder -- your rodent treatment check-up is due very soon. Reply here or call us to book before it lapses!",
      emailSubject: "Final reminder -- your rodent treatment is due",
      email:
        "Hi {{name}},\n\nThis is a final reminder that your rodent treatment check-up is due very soon.\n\nReply to this email or give us a call to book your next appointment before it lapses.",
    },
    [CATEGORY_UUID.termiteStations]: {
      sms: "Hi {{name}}, final reminder -- your termite bait station check is due very soon. Reply here or call us to book before it lapses!",
      emailSubject: "Final reminder -- your termite bait station check is due",
      email:
        "Hi {{name}},\n\nThis is a final reminder that your termite bait station check is due very soon. Keeping this up to date is essential to keep your termite protection active.\n\nReply to this email or give us a call to book your next appointment before it lapses.",
    },
    [CATEGORY_UUID.termiteInspection]: {
      sms: "Hi {{name}}, final reminder -- your termite inspection is due very soon. Reply here or call us to book before it lapses!",
      emailSubject: "Final reminder -- your termite inspection is due",
      email:
        "Hi {{name}},\n\nThis is a final reminder that your termite inspection is due very soon. Regular inspections are the best way to catch termite activity early, before it causes damage.\n\nReply to this email or give us a call to book your next appointment before it lapses.",
    },
    generalPestAlt: {
      sms: "Hi {{name}}, final reminder -- your general pest treatment is due very soon. Get in touch to book before it lapses!",
      emailSubject: "Final reminder -- your general pest treatment is due",
      email:
        "Hi {{name}},\n\nThis is a final reminder that your general pest treatment is due very soon. Get in touch or give us a call to book before it lapses.",
    },
    rodentAlt: {
      sms: "Hi {{name}}, final reminder -- your rodent treatment check-up is due very soon. Get in touch to book before it lapses!",
      emailSubject: "Final reminder -- your rodent treatment check-up is due",
      email:
        "Hi {{name}},\n\nThis is a final reminder that your rodent treatment check-up is due very soon. Get in touch or give us a call to book before it lapses.",
    },
  },
};

async function maybeCreateFollowUpDraft(env, tenantId, dueCustomer, intervalMonths) {
  const round = dueCustomer.reminder_round;
  const triggerFrom = nextFollowUpDraftDate(dueCustomer, intervalMonths);
  if (!triggerFrom) return; // round 1 (sent by hand) or round 4+ (sequence exhausted)
  if (new Date() < triggerFrom) return; // not time yet for this round

  const firstName = (dueCustomer.contact_name_cache || "").trim().split(/\s+/)[0] || "there";
  const effectiveCategory = resolveCategoryUuid(dueCustomer.servicem8_category_uuid, dueCustomer.last_job_description_cache);
  const tmpl = templateForCategory(FOLLOWUP_TEMPLATES[round], effectiveCategory);
  const altTmpl = secondaryTemplateFor(FOLLOWUP_TEMPLATES[round], effectiveCategory);
  const settings = await env.DB.prepare("SELECT business_name FROM tenant_settings WHERE tenant_id = ?").bind(tenantId).first();

  if (dueCustomer.contact_phone_cache) {
    const altBody = altTmpl ? signOff(altTmpl.sms.replace("{{name}}", firstName), settings) : null;
    await insertDraftIfMissing(
      env,
      tenantId,
      dueCustomer.id,
      "sms",
      round,
      null,
      signOff(tmpl.sms.replace("{{name}}", firstName), settings),
      null,
      altBody
    );
  }
  if (dueCustomer.contact_email_cache) {
    const altSubject = altTmpl?.emailSubject || null;
    const altBody = altTmpl ? signOff(altTmpl.email.replace("{{name}}", firstName), settings) : null;
    await insertDraftIfMissing(
      env,
      tenantId,
      dueCustomer.id,
      "email",
      round,
      tmpl.emailSubject,
      signOff(tmpl.email.replace("{{name}}", firstName), settings),
      altSubject,
      altBody
    );
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

// ---- badge hand-off -------------------------------------------------------

// A badge-based rule only ever sees jobs that CARRY the badge. So when a
// customer is serviced again before their renewal falls due, the newer job is
// invisible to the engine, last_completed_at never moves, and the customer
// gets chased for a service they already had.
//
// Category-based rules don't have this problem: their candidate list is every
// job in the category, and upsertJobsAsDueCandidates already keeps the most
// recently completed one per (company, address).
//
// This closes that gap by moving the badge onto the newer job. Two properties
// matter more than anything else here, because this WRITES to ServiceM8 and
// edits badges staff applied by hand:
//
//   1. It only ever RELOCATES a badge. If no job in a group carries the badge,
//      the group is skipped -- so the set of tracked customers can shrink or
//      consolidate, but never grow behind anyone's back.
//   2. It is idempotent and self-healing. Adding to the new job and removing
//      from the old ones are separate API calls; if the process dies between
//      them the badge is briefly on both, which is harmless (the engine keeps
//      the most recent job anyway) and is cleaned up on the next run.
// The decision half, kept pure and exported so every rule below can be tested
// without stubbing ServiceM8: given jobs, it returns the writes that should
// happen. reassignBadgeForRule performs them. Deciding and writing are split
// because deciding is where the risk lives -- a wrong grouping rule here
// edits real jobs.
//
// Each move: { companyUuid, addressKey, addTo: job|null, removeFrom: [job],
// dateChanged: bool }. addTo is null when the newest job is already correct
// and only stale duplicates need clearing.
export function planBadgeMoves(jobs, badgeUuid, warrantyCategoryUuids = new Set()) {
  const groups = new Map();
  for (const job of jobs) {
    if (warrantyCategoryUuids.has(job.category_uuid)) continue; // a warranty callback must not push the renewal out
    const addressKey = normalizeStreet(job.job_address);
    // A blank address would collapse every job at this company into one
    // group and hand the badge to an unrelated property's job.
    if (!addressKey || !job.company_uuid) continue;
    const completedAt = parseServiceM8Date(job.completion_date);
    if (!completedAt) continue;
    const key = `${job.company_uuid}|${addressKey}`;
    if (!groups.has(key)) groups.set(key, { companyUuid: job.company_uuid, addressKey, entries: [] });
    groups.get(key).entries.push({ job, completedAt });
  }

  const moves = [];
  for (const [, group] of groups) {
    const carries = (job) => parseBadges(job.badges).includes(badgeUuid);
    const badged = group.entries.filter((e) => carries(e.job));
    if (!badged.length) continue; // see property 1 above -- never introduces tracking

    const latest = group.entries.reduce((a, b) => (a.completedAt >= b.completedAt ? a : b));
    const latestAlreadyBadged = carries(latest.job);
    const stale = badged.filter((e) => e.job.uuid !== latest.job.uuid);
    // Checking `stale` as well as `latestAlreadyBadged` is what makes a
    // half-finished previous run heal rather than strand a badge on an old job.
    if (latestAlreadyBadged && !stale.length) continue;

    moves.push({
      companyUuid: group.companyUuid,
      addressKey: group.addressKey,
      addTo: latestAlreadyBadged ? null : latest.job,
      removeFrom: stale.map((e) => e.job),
      // Only a badge landing on a different job changes the due date; merely
      // tidying a duplicate does not.
      dateChanged: !latestAlreadyBadged,
    });
  }
  return moves;
}

async function reassignBadgeForRule(env, tenantId, rule, jobs, warrantyCategoryUuids) {
  const moves = planBadgeMoves(jobs, rule.servicem8_badge_uuid, warrantyCategoryUuids);
  let moved = 0;
  for (const move of moves) {
    try {
      if (move.addTo) {
        // Read-modify-write: updateJobBadges replaces the whole field, so a
        // blind write would silently destroy other badges staff rely on.
        const next = [...new Set([...parseBadges(move.addTo.badges), rule.servicem8_badge_uuid])];
        await updateJobBadges(env, tenantId, move.addTo.uuid, next);
      }
      for (const job of move.removeFrom) {
        await updateJobBadges(
          env,
          tenantId,
          job.uuid,
          parseBadges(job.badges).filter((b) => b !== rule.servicem8_badge_uuid)
        );
      }
    } catch (err) {
      console.error(`badge hand-off: failed moving badge ${rule.servicem8_badge_uuid} for tenant ${tenantId}`, err);
      continue;
    }

    const target = move.addTo ? `#${move.addTo.generated_job_id || "?"} (${move.addTo.uuid})` : "(already correct)";
    const from = move.removeFrom.map((j) => `#${j.generated_job_id || "?"} (${j.uuid})`).join(", ") || "nothing";
    console.log(`badge hand-off: badge ${rule.servicem8_badge_uuid} -> ${target}, cleared from ${from} -- tenant ${tenantId}`);

    if (move.dateChanged) {
      moved++;
      await resetReminderSequenceForGroup(env, tenantId, rule, move);
    }
  }
  return moved;
}

// The customer was serviced, so any unsent reminder from the old cycle is now
// wrong -- left in the queue, a staff member could send "your treatment is
// due" to someone serviced last week. Superseded drafts match none of the
// dashboard's pending/failed/sent filters, so they leave the queue while
// staying auditable.
//
// The due_customers row is found by its natural key, which is exactly the
// grouping key already in hand. dismissed_at needs no handling: the upsert
// clears it automatically once last_completed_at moves forward.
async function resetReminderSequenceForGroup(env, tenantId, rule, move) {
  const row = await env.DB.prepare(
    `SELECT id FROM due_customers WHERE tenant_id = ? AND servicem8_company_uuid = ? AND address_key = ? AND category_config_id = ?`
  )
    .bind(tenantId, move.companyUuid, move.addressKey, rule.id)
    .first();
  if (!row) return; // not tracked yet -- the recompute that follows will create it against the new date
  await env.DB.prepare("UPDATE reminder_drafts SET status = 'superseded' WHERE due_customer_id = ? AND status = 'pending'")
    .bind(row.id)
    .run();
  await env.DB.prepare("UPDATE due_customers SET reminder_round = 1, last_reminder_sent_at = NULL WHERE id = ?").bind(row.id).run();
}

// Runs on the nightly cron immediately before the recompute, so the recompute
// sees the corrected badges in the same pass.
export async function reassignBadgesForTenant(env, tenantId) {
  const { results: rules } = await env.DB.prepare(
    "SELECT * FROM category_config WHERE tenant_id = ? AND signal_type = 'badge' AND is_tracked = 1 AND servicem8_badge_uuid IS NOT NULL"
  )
    .bind(tenantId)
    .all();
  if (!rules || !rules.length) return { moved: 0 };

  let jobs;
  try {
    // The same fetch listCompletedJobsForBadge already performs, so reusing it
    // here costs no extra API calls.
    jobs = await listAllCompletedJobs(env, tenantId);
  } catch (err) {
    console.error(`badge hand-off: failed to list completed jobs for tenant ${tenantId}`, err);
    return { moved: 0 };
  }

  const warrantyCategoryUuids = await getWarrantyCategoryUuids(env, tenantId);
  let moved = 0;
  for (const rule of rules) {
    try {
      moved += await reassignBadgeForRule(env, tenantId, rule, jobs || [], warrantyCategoryUuids);
    } catch (err) {
      console.error(`badge hand-off: rule ${rule.id} failed for tenant ${tenantId}`, err);
    }
  }
  return { moved };
}

// ---- delivery verification ------------------------------------------------
//
// A 2xx from the Messaging API only means ServiceM8 accepted the request;
// delivery can still fail afterwards (job diary shows "Delivery Failed") with
// nothing surfaced to the API caller. Per channel:
//
//   SMS   -- sms.json has no status field at all, so delivery is inferred
//            from presence: a delivered SMS appears in the job's history, a
//            failed one never does (confirmed live 2026-08-07 against three
//            silently-failed sends).
//   Email -- email.json is explicit: `bounced` marks a hard failure and
//            `opened`/`first_opened_at` give a read receipt, so absence is
//            only the fallback signal.

const DELIVERY_CHECK_MIN_AGE_MS = 10 * 60_000; // give ServiceM8 time to write the record
const DELIVERY_CHECK_MAX_AGE_MS = 14 * 24 * 3600_000; // don't churn ancient rows forever
// Opens can land days after delivery, so confirmed-but-unopened emails are
// re-polled -- but only this often, or the 2-minute sweep would hammer the
// API for a fortnight per email.
const OPEN_POLL_INTERVAL_MS = 6 * 3600_000;

// Both sms.json's `message` and email.json's `message_text` come back as the
// exact text we sent; compare whitespace-normalized anyway so an invisible
// formatting difference can't produce a false "failed".
function normalizeSmsText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// A tenant authorized before these scopes existed can't be verified at all
// until they re-connect. Detected by the scope name in ServiceM8's 403 so the
// sweep can skip quietly instead of marking everything failed.
function isMissingScopeError(err, scope) {
  return String(err && err.message).includes(scope);
}

// Shared by both channels: flip the draft to a re-sendable failed state and
// roll the customer's reminder_round back so they return to their urgency
// bucket in the dashboard instead of sitting in "Contacted" as if the message
// went out.
async function markDeliveryFailed(env, draft, reason) {
  await env.DB.prepare(
    "UPDATE reminder_drafts SET status = 'failed', delivery_status = 'failed', delivery_checked_at = ?, error = ? WHERE id = ?"
  )
    .bind(Date.now(), reason, draft.id)
    .run();
  await env.DB.prepare(
    "UPDATE due_customers SET reminder_round = CASE WHEN reminder_round > ? THEN ? ELSE reminder_round END WHERE id = ?"
  )
    .bind(draft.round, draft.round, draft.due_customer_id)
    .run();
}

export async function verifySmsDeliveriesForTenant(env, tenantId) {
  const now = Date.now();
  const { results: drafts } = await env.DB.prepare(
    `SELECT rd.*, dc.last_job_uuid FROM reminder_drafts rd
     JOIN due_customers dc ON dc.id = rd.due_customer_id
     WHERE rd.tenant_id = ? AND rd.channel = 'sms' AND rd.status = 'sent'
       AND rd.delivery_status IS NULL AND rd.sent_at IS NOT NULL
       AND rd.sent_at <= ? AND rd.sent_at >= ?`
  )
    .bind(tenantId, now - DELIVERY_CHECK_MIN_AGE_MS, now - DELIVERY_CHECK_MAX_AGE_MS)
    .all();
  if (!drafts || !drafts.length) return;

  // One sms.json fetch per job, not per draft.
  const smsByJob = new Map();
  for (const draft of drafts) {
    if (!draft.last_job_uuid) continue;
    let records = smsByJob.get(draft.last_job_uuid);
    if (records === undefined) {
      try {
        records = (await listJobSmsRecords(env, tenantId, draft.last_job_uuid)) || [];
      } catch (err) {
        const message = String(err && err.message);
        // Tenant authorized before the read_sms scope existed -- verification
        // is impossible until they re-connect. Leave delivery_status NULL so
        // these drafts are re-checked automatically once the scope arrives;
        // never mark failed on a scope error.
        if (isMissingScopeError(err, "read_sms")) {
          console.error(`sms delivery verification skipped for tenant ${tenantId}: token lacks read_sms scope (re-connect required)`);
          return;
        }
        console.error(`sms delivery verification: sms.json fetch failed for job ${draft.last_job_uuid}`, err);
        records = null; // transient -- retry this job next sweep
      }
      smsByJob.set(draft.last_job_uuid, records);
    }
    if (records === null) continue;

    const wanted = normalizeSmsText(draft.draft_body);
    const found = records.some((r) => r.direction === "outbound" && normalizeSmsText(r.message) === wanted);
    if (found) {
      await env.DB.prepare("UPDATE reminder_drafts SET delivery_status = 'confirmed', delivery_checked_at = ? WHERE id = ?")
        .bind(now, draft.id)
        .run();
      continue;
    }

    // Absent after the grace window = delivery failed.
    console.error(`sms delivery FAILED for draft ${draft.id} (tenant ${tenantId}, job ${draft.last_job_uuid}): message never appeared in job SMS history`);
    await markDeliveryFailed(
      env,
      draft,
      "Delivery failed: SMS never appeared in the job's SMS history (ServiceM8 accepted the send but did not deliver it)"
    );
  }
}

// Email verification, plus read receipts. Unlike SMS this has real delivery
// signal, so absence is only the last resort: an explicit `bounced` record
// fails immediately, and a found record confirms delivery and carries the
// open timestamp. Confirmed-but-unopened emails keep getting re-polled (at
// OPEN_POLL_INTERVAL_MS) because an open can land days after delivery.
export async function verifyEmailDeliveriesForTenant(env, tenantId) {
  const now = Date.now();
  const { results: drafts } = await env.DB.prepare(
    `SELECT rd.*, dc.last_job_uuid FROM reminder_drafts rd
     JOIN due_customers dc ON dc.id = rd.due_customer_id
     WHERE rd.tenant_id = ? AND rd.channel = 'email' AND rd.status = 'sent'
       AND rd.sent_at IS NOT NULL AND rd.sent_at <= ? AND rd.sent_at >= ?
       AND (rd.delivery_status IS NULL
            OR (rd.delivery_status = 'confirmed' AND rd.opened_at IS NULL
                AND (rd.delivery_checked_at IS NULL OR rd.delivery_checked_at <= ?)))`
  )
    .bind(tenantId, now - DELIVERY_CHECK_MIN_AGE_MS, now - DELIVERY_CHECK_MAX_AGE_MS, now - OPEN_POLL_INTERVAL_MS)
    .all();
  if (!drafts || !drafts.length) return;

  const emailsByJob = new Map();
  for (const draft of drafts) {
    if (!draft.last_job_uuid) continue;
    let records = emailsByJob.get(draft.last_job_uuid);
    if (records === undefined) {
      try {
        records = (await listJobEmailRecords(env, tenantId, draft.last_job_uuid)) || [];
      } catch (err) {
        if (isMissingScopeError(err, "read_email")) {
          console.error(`email delivery verification skipped for tenant ${tenantId}: token lacks read_email scope (re-connect required)`);
          return;
        }
        console.error(`email delivery verification: email.json fetch failed for job ${draft.last_job_uuid}`, err);
        records = null; // transient -- retry this job next sweep
      }
      emailsByJob.set(draft.last_job_uuid, records);
    }
    if (records === null) continue;

    const wanted = normalizeSmsText(draft.draft_body);
    const record = records.find((r) => r.direction === "outbound" && normalizeSmsText(r.message_text) === wanted);

    if (record && record.bounced) {
      console.error(`email BOUNCED for draft ${draft.id} (tenant ${tenantId}, job ${draft.last_job_uuid})`);
      await markDeliveryFailed(env, draft, "Delivery failed: the email bounced (ServiceM8 reported a hard bounce for this address)");
      continue;
    }

    if (record) {
      await env.DB.prepare("UPDATE reminder_drafts SET delivery_status = 'confirmed', delivery_checked_at = ?, opened_at = ? WHERE id = ?")
        .bind(now, record.first_opened_at || null, draft.id)
        .run();
      continue;
    }

    // Never appeared. Only meaningful on the first pass -- a draft already
    // confirmed is just being re-polled for an open, and a transient gap in
    // the history must not retroactively fail it.
    if (draft.delivery_status === "confirmed") continue;
    console.error(`email delivery FAILED for draft ${draft.id} (tenant ${tenantId}, job ${draft.last_job_uuid}): message never appeared in job email history`);
    await markDeliveryFailed(
      env,
      draft,
      "Delivery failed: email never appeared in the job's email history (ServiceM8 accepted the send but did not deliver it)"
    );
  }
}

// Both channels, all active tenants. One channel's failure never blocks the
// other, so a tenant that granted read_sms but not read_email still gets SMS
// verification.
export async function verifyDeliveries(env) {
  const { results: tenants } = await env.DB.prepare("SELECT servicem8_account_uuid FROM tenants WHERE status = 'active'").all();
  for (const tenant of tenants || []) {
    const tenantId = tenant.servicem8_account_uuid;
    try {
      await verifySmsDeliveriesForTenant(env, tenantId);
    } catch (err) {
      console.error(`sms delivery verification failed for tenant ${tenantId}`, err);
    }
    try {
      await verifyEmailDeliveriesForTenant(env, tenantId);
    } catch (err) {
      console.error(`email delivery verification failed for tenant ${tenantId}`, err);
    }
  }
}
