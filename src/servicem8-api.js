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

// Open (in-pipeline) jobs for a company -- used by the due-engine's
// already-rebooked exclusion, mirrors findOpenQuoteJob in
// tcbpestcontriol/src/servicem8.js generalized to also catch Work Order.
export async function listOpenJobsForCompany(env, tenantId, companyUuid) {
  const clauses = [`company_uuid eq '${companyUuid}'`, `status ne 'Completed'`, `status ne 'Unsuccessful'`];
  return sm8Fetch(env, tenantId, `/job.json?${odataFilter(clauses.join(" and "))}`);
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
// Endpoint and form-urlencoded shape confirmed working in
// tcb-customer-portal (registerServiceM8Webhook, company.created/updated,
// X-API-Key auth). Using the tenant's OAuth bearer token here instead of an
// API key -- unconfirmed whether ServiceM8 accepts OAuth bearer auth on this
// specific endpoint the same way; verify in Phase 1 against TCB's own
// account before relying on it for other tenants.

export async function registerWebhook(env, tenantId, { event, callbackUrl }) {
  const uniqueId = `renewal-autopilot:${tenantId}:${event}`;
  const res = await sm8PostForm(env, tenantId, `/webhook_subscriptions`, {
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
