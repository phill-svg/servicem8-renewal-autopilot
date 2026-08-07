// Tenant-aware ServiceM8 REST client -- every call is scoped to one
// installing business's own OAuth access token, unlike tcbpestcontriol's and
// tcb-customer-portal's single-tenant X-API-Key clients (TCB's own account
// only). Adapts their confirmed patterns (odata filter operators, field
// names, zero-date sentinel) to per-tenant Bearer auth.
//
// NEEDS LIVE CONFIRMATION (flagged, not guessed): OAuth API calls are
// assumed to use `Authorization: Bearer <access_token>` per standard OAuth2 --
// tcb-customer-portal's only real API traffic uses X-API-Key, so this
// project has no prior confirmed example of the Bearer-auth path. Verify on
// the very first live call in Phase 1 and adjust here if wrong.

import { getValidAccessToken } from "./servicem8-oauth.js";

const API_BASE = "https://api.servicem8.com/api_1.0";
// The Messaging API (platform_service_sms/email) lives at the API root, NOT
// under /api_1.0 like every other resource -- confirmed live (2026-08-03) via
// a "not an authorised object type" 400, the same misleading symptom the
// webhook_subscriptions path issue gave earlier this session. Docs confirm:
// https://api.servicem8.com/platform_service_sms, no /api_1.0 prefix.
const PLATFORM_BASE = "https://api.servicem8.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with retry on rate-limit / transient errors. A full recompute fires
// hundreds of reads in quick succession and ServiceM8 rate-limits per minute
// (429); without retry those reads fail and callers (e.g. the contact lookup)
// silently cache blanks -- which showed up as "Unknown" customers. Backs off
// on 429 and 5xx, honouring Retry-After when present.
async function sm8Fetch(env, tenantId, path, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getValidAccessToken(env, tenantId);
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`ServiceM8 API ${path} failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
}

async function sm8PostForm(env, tenantId, path, form) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API POST ${path} failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function sm8PostJson(env, tenantId, path, body) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API POST ${path} failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function platformPostJson(env, tenantId, path, body) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${PLATFORM_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API POST ${path} failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ServiceM8's Messaging API requires E.164 ("+61412345678"), not local
// Australian format ("0412 345 678" / "0412345678") -- confirmed in the docs
// alongside the endpoint-path fix above.
//
// Real contact records are messier than that. Seen live in TCB's account:
// two numbers crammed into one field ("61403232912,0403232912"), a trailing
// note ("0410414736 husband"), and numbers already carrying the country code
// but no plus ("61417894656"). Stripping non-digits alone concatenated the
// first case into "614032329120403232912", which ServiceM8 rejected with
// errorCode 405 -- so take only the FIRST number in the field and normalize
// the country code explicitly rather than assuming a leading 0.
export function toE164Au(phone) {
  const first = String(phone || "").split(/[,;/]| or /i)[0];
  const digits = first.replace(/[^0-9+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("0")) return "+61" + digits.slice(1);
  if (digits.startsWith("61")) return "+" + digits; // country code, missing plus
  if (digits.startsWith("4") && digits.length === 9) return "+61" + digits; // leading 0 lost
  return digits;
}

// Guard before spending a send on a number that cannot work. AU numbers are
// held to the mobile shape (+614xxxxxxxx) since SMS to a landline is always
// rejected; anything else only has to look like plausible E.164, so an
// overseas customer isn't blocked by an AU-centric rule.
export function isSendableMobile(phone) {
  const e164 = toE164Au(phone);
  if (!/^\+\d{8,15}$/.test(e164)) return false;
  return e164.startsWith("+61") ? /^\+614\d{8}$/.test(e164) : true;
}

// ServiceM8's filter language only supports eq/ne/gt/lt -- no substring, no
// AND documented beyond simple expressions -- confirmed in
// tcbpestcontriol/src/servicem8.js. Combine multiple conditions with " and ".
function odataFilter(expr) {
  return `%24filter=${encodeURIComponent(expr)}`;
}

export async function getJob(env, tenantId, jobUuid) {
  return sm8Fetch(env, tenantId, `/job/${jobUuid}.json`);
}

// Raw passthrough for one-off investigation (see /debug/raw) -- not part of
// the live due-detection path.
export async function rawGet(env, tenantId, pathAndQuery) {
  return sm8Fetch(env, tenantId, pathAndQuery);
}

export async function listBadges(env, tenantId) {
  return sm8Fetch(env, tenantId, `/badge.json`);
}

// ServiceM8 "delete" just sets active=0 (hidden from UI, still API-visible) --
// used to retire the badly-styled first-attempt custom-image badges.
export async function deleteBadge(env, tenantId, badgeUuid) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${API_BASE}/badge/${badgeUuid}.json`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API DELETE /badge/${badgeUuid}.json failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
}

// Updates an existing badge -- used to force ServiceM8 to re-fetch a changed
// sprite image at the same file_name URL (it appears to cache/copy the image
// at creation time rather than proxying it live).
export async function updateBadge(env, tenantId, badgeUuid, { fileUrl }) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${API_BASE}/badge/${badgeUuid}.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ file_name: fileUrl }),
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API POST /badge/${badgeUuid}.json failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
}

// Creates a Badge -- name is required, file_name is an optional public URL to
// a custom 3-state sprite PNG (inactive/hover/active stacked vertically,
// confirmed via ServiceM8 community docs: "don't change the dimensions, just
// edit the three examples in place" -- exact pixel size undocumented).
// Requires manage_badges scope. Like other ServiceM8 create endpoints, the
// response body is empty -- the new UUID comes back in the x-record-uuid
// header (mirrors tcbpestcontriol/src/servicem8.js's sm8Create).
export async function createBadge(env, tenantId, { name, fileUrl }) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${API_BASE}/badge.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name, ...(fileUrl ? { file_name: fileUrl } : {}) }),
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API POST /badge.json failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
  const uuid = res.headers.get("x-record-uuid");
  if (!uuid) throw new Error("ServiceM8 POST /badge.json returned no record UUID");
  return uuid;
}

// Updates fields on an existing job -- ServiceM8's REST convention is POST to
// the record's own .json URL with only the changed fields (same shape as
// creating, per their docs). Used for one-off historical-data cleanup (see
// /debug/reclassify-jobs), not part of the live due-detection path.
// Creates a Company Contact -- used to attach a test phone number to the
// throwaway test job/company for end-to-end reminder-send verification.
export async function createCompanyContact(env, tenantId, { companyUuid, first, last, mobile, isPrimary }) {
  return sm8PostJson(env, tenantId, `/companycontact.json`, {
    company_uuid: companyUuid,
    first,
    last: last || "",
    mobile,
    is_primary_contact: isPrimary ? "1" : "0",
  });
}

export async function updateJobCategory(env, tenantId, jobUuid, categoryUuid) {
  return sm8PostJson(env, tenantId, `/job/${jobUuid}.json`, { category_uuid: categoryUuid });
}

// Badges must be WRITTEN as a JSON-encoded string ("must be a JSON array
// encoded string" per a live 400) -- same encoding as how they come back on
// read (see parseBadges), so this is symmetric after all once written
// correctly. A raw JS array in the request body is rejected.
export async function updateJobBadges(env, tenantId, jobUuid, badgesArray) {
  return sm8PostJson(env, tenantId, `/job/${jobUuid}.json`, { badges: JSON.stringify(badgesArray) });
}

// All jobs regardless of status -- badges can be applied to jobs in any
// status (Quote, Work Order, Completed), not just Completed ones, so the
// due-detection engine's listAllCompletedJobs (status-filtered) isn't
// sufficient for a badge-driven bulk operation across every job.
export async function listAllJobsAnyStatus(env, tenantId) {
  return sm8Fetch(env, tenantId, `/job.json`);
}

// Completed jobs for a category, optionally only those completed *before* a
// cursor date -- this is the chunking mechanism for backfill (see
// src/due-engine.js): each chunk asks for the next slice moving backward in
// time instead of relying on unconfirmed API-level pagination/offset
// support.
export async function listCompletedJobsForCategory(env, tenantId, categoryUuid, { before } = {}) {
  const clauses = [`status eq 'Completed'`, `category_uuid eq '${categoryUuid}'`];
  if (before) clauses.push(`completion_date lt '${before}'`);
  return sm8Fetch(env, tenantId, `/job.json?${odataFilter(clauses.join(" and "))}`);
}

// All completed jobs regardless of category, optionally chunked by
// completion date like listCompletedJobsForCategory. Used by the debug
// category breakdown, and by badge-based rules -- ServiceM8's `badges` field
// is a JSON array embedded on the job record, not a separately filterable
// object, so badge matching has to happen client-side over the full list
// (see listCompletedJobsForBadge below).
export async function listAllCompletedJobs(env, tenantId, { before } = {}) {
  const clauses = [`status eq 'Completed'`];
  if (before) clauses.push(`completion_date lt '${before}'`);
  return sm8Fetch(env, tenantId, `/job.json?${odataFilter(clauses.join(" and "))}`);
}

// ServiceM8 sends `badges` as a JSON-*encoded string* (e.g. `'["uuid1","uuid2"]'`),
// not a real array, on both list and single-job responses -- confirmed live
// (2026-08-03). Parse defensively; a malformed/empty value just means no badges.
export function parseBadges(badgesField) {
  if (Array.isArray(badgesField)) return badgesField;
  if (typeof badgesField !== "string" || !badgesField) return [];
  try {
    const parsed = JSON.parse(badgesField);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Completed jobs carrying a specific Job Badge -- no dedicated filterable
// endpoint for the job/badge relationship, so this fetches the (optionally
// date-chunked) completed-jobs list and filters client-side.
export async function listCompletedJobsForBadge(env, tenantId, badgeUuid, { before } = {}) {
  const jobs = await listAllCompletedJobs(env, tenantId, { before });
  return (jobs || []).filter((j) => parseBadges(j.badges).includes(badgeUuid));
}

// Open (in-pipeline) jobs for a company -- used by the due-engine's
// already-rebooked exclusion, mirrors findOpenQuoteJob in
// tcbpestcontriol/src/servicem8.js generalized to also catch Work Order.
//
// Confirmed live (2026-08-03): ServiceM8's `ne` filter operator doesn't
// actually exclude anything -- `status ne 'Completed'` still returned
// Completed jobs, which made every customer look "already rebooked" and
// suppressed the entire due queue. Fetch by company_uuid only and filter
// status client-side instead of trusting `ne`.
const CLOSED_STATUSES = new Set(["Completed", "Unsuccessful"]);
export async function listOpenJobsForCompany(env, tenantId, companyUuid) {
  const jobs = await sm8Fetch(env, tenantId, `/job.json?${odataFilter(`company_uuid eq '${companyUuid}'`)}`);
  return (jobs || []).filter((j) => !CLOSED_STATUSES.has(j.status));
}

// A job's actual tech-written notes (e.g. "No issues, paid cc") -- a
// separate object from the job record itself, gated behind its own
// read_job_notes scope (confirmed live via a 403 "insufficient_scope").
// work_done_description on the job record is NOT this -- it's usually just a
// restatement of the service type ("Premium pest treatment"), sometimes
// blank, and duplicates what the category already shows.
//
// Confirmed live (2026-08-04): related_object_uuid/related_object, same
// polymorphic-attachment convention as dboattachment. Fields are uuid,
// create_date, edit_date, active, note, related_object, related_object_uuid
// -- no `timestamp` field (see due-engine.js's sort-by-create_date).
export async function listNotesForJob(env, tenantId, jobUuid) {
  return sm8Fetch(env, tenantId, `/note.json?${odataFilter(`related_object_uuid eq '${jobUuid}'`)}`);
}

// The installing account's OWN business name, from its Vendor record
// (/vendor.json, "vendor" scope). Used as the sign-off appended to reminder
// message bodies so each tenant's messages are signed with their own
// business. Returns "" if the scope isn't granted yet or the call fails.
export async function getVendorName(env, tenantId) {
  try {
    const vendors = await sm8Fetch(env, tenantId, `/vendor.json`);
    const v = Array.isArray(vendors) ? vendors[0] : vendors;
    return (v?.name || "").trim();
  } catch (err) {
    console.error(`getVendorName failed for tenant ${tenantId}:`, err);
    return "";
  }
}

// Job Categories configured on the tenant's account, for the setup wizard's
// category picker (Phase 2) -- NEEDS LIVE CONFIRMATION of the resource name;
// assumed `category.json` by ServiceM8's general naming convention
// (company.json, companycontact.json, job.json all follow singular-noun.json).
export async function listCategories(env, tenantId) {
  return sm8Fetch(env, tenantId, `/category.json`);
}

// A single Company record by uuid.
export async function getCompany(env, tenantId, companyUuid) {
  try {
    return await sm8Fetch(env, tenantId, `/company/${companyUuid}.json`);
  } catch (err) {
    console.error(`getCompany failed for ${companyUuid}:`, err);
    return null;
  }
}

// A Company's contactable email/phone live on its Company Contact record(s),
// not the Company itself -- confirmed in both existing repos. Prefers the
// primary contact; falls back to the first contact with the field set.
//
// For an INDIVIDUAL customer (is_individual=1) ServiceM8 often stores the
// person's name on the Company record's own `name` field with no separate
// named contact -- so when no contact name is found, fall back to the
// company name rather than leaving it blank (which the dashboard renders as
// "Unknown"). Only fetches the company in that fallback case, to avoid an
// extra API call per customer on every recompute.
export async function getPrimaryContact(env, tenantId, companyUuid) {
  const contacts = await sm8Fetch(env, tenantId, `/companycontact.json?${odataFilter(`company_uuid eq '${companyUuid}'`)}`);
  const list = Array.isArray(contacts) ? contacts : [];
  const primary = list.find((c) => String(c.is_primary_contact) === "1");
  const pick = (field) => (primary && primary[field]) || (list.find((c) => c[field]) || {})[field] || "";
  let name = [primary?.first, primary?.last].filter(Boolean).join(" ") || list[0]?.first || "";
  if (!name) {
    const company = await getCompany(env, tenantId, companyUuid);
    name = (company?.name || "").trim();
  }
  return {
    name,
    email: pick("email"),
    mobile: pick("mobile"),
    phone: pick("phone"),
  };
}

// ---- webhook subscription management ---------------------------------
//
// CORRECTED 2026-08-02 against a live 400 during Phase 1 TCB install
// testing: ServiceM8 actually has two distinct endpoints --
// /webhook_subscriptions/object (field-level changes on an object type --
// what tcb-customer-portal's company.created/updated registration is really
// hitting, confirmed via developer.servicem8.com/reference/post_object_webhook_subscription)
// and /webhook_subscriptions/event (named business events, e.g.
// job.completed -- developer.servicem8.com/reference/post_event_webhook_subscription).
// The bare /webhook_subscriptions path used here originally is neither --
// it produced "webhook_subscriptions is not an authorised object type",
// which was a misleading symptom (it read like a scope/permission error,
// it was actually just the wrong URL). Confirmed request fields from the
// official reference: event, callback_url, unique_id (optional).
export async function registerWebhook(env, tenantId, { event, callbackUrl }) {
  const uniqueId = `renewal-autopilot:${tenantId}:${event}`;
  const res = await sm8PostForm(env, tenantId, `/webhook_subscriptions/event`, {
    event,
    callback_url: callbackUrl,
    unique_id: uniqueId,
  });
  return res;
}

// ---- outbound messaging (Phase 2, wired here so Phase 1's callers already
// have the shape) -- platform_service_sms/email confirmed via developer
// docs, sends through the tenant's OWN ServiceM8 account (their SMS
// credits/sender ID), no separate SMS provider needed.

// HTTP 200 from the Messaging API does NOT mean the send succeeded. Confirmed
// live (2026-08-07): sends that never reached the customer still returned 2xx
// but with no messageID in the body -- the docs' success shape is errorCode 0
// plus a messageID, and every delivered send had one while every silent
// failure didn't. So a 200 body without a messageID is treated as a failure
// here, with the raw body preserved in the error for the audit trail.
export async function sendPlatformSms(env, tenantId, { to, message, regardingJobUuid }) {
  // Fail with something staff can act on. ServiceM8's own rejection quotes the
  // mangled digits back ("614032329120403232912 is not a valid mobile number")
  // without saying which contact or what to do about it.
  if (!isSendableMobile(to)) {
    throw new Error(
      `Invalid mobile number "${to}" -- SMS not sent. Fix this contact's phone in ServiceM8: it needs to be a single Australian mobile (e.g. 0412 345 678).`
    );
  }
  const result = await platformPostJson(env, tenantId, `/platform_service_sms`, {
    to: toE164Au(to),
    message,
    ...(regardingJobUuid ? { regardingJobUUID: regardingJobUuid } : {}),
  });
  const errorCode = result && typeof result.errorCode === "number" ? result.errorCode : null;
  const messageId = result && (result.messageID || result.messageUUID);
  if ((errorCode !== null && errorCode !== 0) || !messageId) {
    throw new Error(`ServiceM8 SMS send not accepted (HTTP 200 but no messageID): ${JSON.stringify(result)}`);
  }
  return result;
}

// Job SMS history (api_1.0/sms.json, needs the read_sms scope). Delivered
// messages -- including Messaging API sends -- show up here; failed ones
// never do, which is the only delivery signal ServiceM8 exposes (the sms
// record has no status field, and the Job Diary's "Delivery Failed" state
// isn't in any public object). Only some filter fields are accepted:
// related_object_uuid works, timestamp/to_phone are rejected.
export async function listJobSmsRecords(env, tenantId, jobUuid) {
  return sm8Fetch(env, tenantId, `/sms.json?${odataFilter(`related_object_uuid eq '${jobUuid}'`)}`);
}

// Job email history (api_1.0/email.json, needs the read_email scope). Unlike
// sms.json this carries explicit delivery signal -- `bounced` for hard
// failures and `opened`/`first_opened_at` for read receipts (the same data
// behind the job diary's "Email opened at ..." line). message_text comes back
// byte-identical to the textBody we sent, so drafts match on body exactly as
// they do for SMS.
export async function listJobEmailRecords(env, tenantId, jobUuid) {
  return sm8Fetch(env, tenantId, `/email.json?${odataFilter(`related_object_uuid eq '${jobUuid}'`)}`);
}

// Diagnostic: same send but returns the raw HTTP status + parsed body
// (errorCode / messageID / etc) instead of throwing, so we can inspect
// exactly what ServiceM8's Messaging API returns for a given send.
export async function sendPlatformSmsRaw(env, tenantId, { to, message, regardingJobUuid }) {
  const token = await getValidAccessToken(env, tenantId);
  const payload = { to: toE164Au(to), message, ...(regardingJobUuid ? { regardingJobUUID: regardingJobUuid } : {}) };
  const res = await fetch(`${PLATFORM_BASE}/platform_service_sms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, sentTo: payload.to, body };
}

export async function sendPlatformEmail(env, tenantId, { to, subject, htmlBody, textBody, regardingJobUuid }) {
  const result = await platformPostJson(env, tenantId, `/platform_service_email`, {
    to,
    subject,
    ...(htmlBody ? { htmlBody } : {}),
    ...(textBody ? { textBody } : {}),
    ...(regardingJobUuid ? { regardingJobUUID: regardingJobUuid } : {}),
  });
  // Same 200-with-error-body trap as SMS. No live evidence yet of what a
  // failed email response looks like, so only reject on an explicit non-zero
  // errorCode rather than also requiring a messageID.
  if (result && typeof result.errorCode === "number" && result.errorCode !== 0) {
    throw new Error(`ServiceM8 email send not accepted: ${JSON.stringify(result)}`);
  }
  return result;
}
