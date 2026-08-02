// Inbound webhook handling: registration + a defensive multi-shape payload
// parser. The real production payload shape is NOT safe to assume from
// ServiceM8's own docs -- tcb-customer-portal's README notes the live
// company.created payload didn't match either documented shape, and only
// {id, type, data:{...}} was confirmed by actually capturing a real
// delivery. This file follows the same discipline: capture every raw
// delivery to webhook_debug regardless of parse success, and try several
// fallback shapes rather than trusting one.

import { randomId } from "./util.js";
import { registerWebhook } from "./servicem8-api.js";

const TRACKED_EVENTS = ["job.completed", "job.created", "job.status_changed"];

// callbackUrl MUST carry `?tenant=<tenantId>` (built by the caller) --
// this is how an inbound delivery gets attributed to a tenant. We control
// the callback_url at registration time, so this sidesteps the unreliable
// payload-shape problem entirely rather than trying to extract an account
// identifier from ServiceM8's own (unconfirmed, inconsistently-documented)
// event payload.
export async function registerAllWebhooks(env, tenantId, callbackUrl) {
  const now = Date.now();
  for (const event of TRACKED_EVENTS) {
    try {
      await registerWebhook(env, tenantId, { event, callbackUrl });
      await env.DB.prepare(
        `INSERT INTO webhook_subscriptions (id, tenant_id, servicem8_event, status, registered_at)
         VALUES (?, ?, ?, 'active', ?)`
      )
        .bind(randomId(), tenantId, event, now)
        .run();
    } catch (err) {
      // Don't let one event type's registration failure block the others --
      // the nightly cron reconciliation is the backstop either way, and a
      // partial subscription set is still better than none.
      console.error(`webhook registration failed for tenant ${tenantId}, event ${event}:`, err);
    }
  }
}

export async function captureRawDelivery(db, { tenantId, contentType, body }) {
  try {
    await db
      .prepare(`INSERT INTO webhook_debug (id, tenant_id, content_type, body, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(randomId(), tenantId || null, contentType, body, Date.now())
      .run();
  } catch (err) {
    console.error("failed to write webhook_debug row (non-fatal):", err);
  }
}

// Confirmed real shape from tcb-customer-portal's production traffic:
// { id, type, data: {...full object...} }. Named-event docs describe a
// different { eventVersion, eventName, auth, eventArgs } shape -- kept as a
// fallback in case ServiceM8 uses that shape for this newer event type.
// Returns { jobUuid, eventType } with any field that couldn't be found left
// null -- callers must handle partial results.
//
// Deliberately does NOT try to extract a tenant/account identifier from the
// payload -- that's resolved from the callback URL's `?tenant=` query param
// instead (see registerAllWebhooks above), which we control ourselves and
// don't have to guess at.
export function parseWebhookPayload(payload) {
  if (!payload || typeof payload !== "object") return { jobUuid: null, eventType: null };

  const eventType = payload.type || payload.eventName || payload.event || null;

  const jobUuid =
    payload?.data?.uuid ||
    payload?.eventArgs?.jobUUID ||
    payload?.eventArgs?.entry?.[0]?.uuid ||
    payload?.entry?.[0]?.uuid ||
    payload?.uuid ||
    payload?.job_uuid ||
    payload?.object_uuid ||
    null;

  return { jobUuid, eventType };
}

// ServiceM8's verification handshake sends form-encoded mode=subscribe +
// challenge, which must be echoed back verbatim -- confirmed working
// pattern from tcb-customer-portal. Returns a Response if this request WAS
// a handshake, or null if it's a normal delivery the caller should keep
// processing.
export async function maybeHandleHandshake(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return null;
  const form = await request.clone().formData();
  if (form.get("mode") === "subscribe" && form.get("challenge")) {
    return new Response(form.get("challenge"), { headers: { "Content-Type": "text/plain" } });
  }
  return null;
}
