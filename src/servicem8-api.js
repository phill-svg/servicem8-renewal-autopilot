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

async function sm8Fetch(env, tenantId, path) {
  const token = await getValidAccessToken(env, tenantId);
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 API ${path} failed for tenant ${tenantId}: ${res.status} ${await res.text()}`);
  }
  return res.json();
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

// ServiceM8's filter language only supports eq/ne/gt/lt -- no substring, no
// AND documented beyond simple expressions -- confirmed in
// tcbpestcontriol/src/servicem8.js. Combine multiple conditions with " and ".
function odataFilter(expr) {
  return `%24filter=${encodeURIComponent(expr)}`;
}

export async function getJob(env, tenantId, jobUuid) {
  return sm8Fetch(env, tenantId, `/job/${jobUuid}.json`);
}

// Updates fields on an existing job -- ServiceM8's REST convention is POST to
// the record's own .json URL with only the changed fields (same shape as
// creating, per their docs). Used for one-off historical-data cleanup (see
// /debug/reclassify-jobs), not part of the live due-detection path.
export async function updateJobCategory(env, tenantId, jobUuid, categoryUuid) {
  return sm8PostJson(env, tenantId, `/job/${jobUuid}.json`, { category_uuid: categoryUuid });
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

// All completed jobs regardless of category -- used by the debug category
// breakdown to show which category labels actually appear on real historical
// jobs, since a tenant's category naming/tagging can't be assumed up front.
export async function listAllCompletedJobs(env, tenantId) {
  return sm8Fetch(env, tenantId, `/job.json?${odataFilter(`status eq 'Completed'`)}`);
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

// Job Categories configured on the tenant's account, for the setup wizard's
// category picker (Phase 2) -- NEEDS LIVE CONFIRMATION of the resource name;
// assumed `category.json` by ServiceM8's general naming convention
// (company.json, companycontact.json, job.json all follow singular-noun.json).
export async function listCategories(env, tenantId) {
  return sm8Fetch(env, tenantId, `/category.json`);
}

// A Company's contactable email/phone live on its Company Contact record(s),
// not the Company itself -- confirmed in both existing repos. Prefers the
// primary contact; falls back to the first contact with the field set.
export async function getPrimaryContact(env, tenantId, companyUuid) {
  const contacts = await sm8Fetch(env, tenantId, `/companycontact.json?${odataFilter(`company_uuid eq '${companyUuid}'`)}`);
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  const primary = contacts.find((c) => String(c.is_primary_contact) === "1");
  const pick = (field) => (primary && primary[field]) || (contacts.find((c) => c[field]) || {})[field] || "";
  return {
    name: [primary?.first, primary?.last].filter(Boolean).join(" ") || contacts[0]?.first || "",
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

export async function sendPlatformSms(env, tenantId, { to, message, regardingJobUuid }) {
  return sm8PostJson(env, tenantId, `/platform_service_sms`, {
    to,
    message,
    ...(regardingJobUuid ? { regardingJobUUID: regardingJobUuid } : {}),
  });
}

export async function sendPlatformEmail(env, tenantId, { to, subject, htmlBody, textBody, regardingJobUuid }) {
  return sm8PostJson(env, tenantId, `/platform_service_email`, {
    to,
    subject,
    ...(htmlBody ? { htmlBody } : {}),
    ...(textBody ? { textBody } : {}),
    ...(regardingJobUuid ? { regardingJobUUID: regardingJobUuid } : {}),
  });
}
