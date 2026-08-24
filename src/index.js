// Renewal Autopilot -- router + cron entry points.
// See C:\Users\Phill\.claude\plans\scalable-painting-beacon.md for the full
// design/rationale. Phase 1 scope: OAuth install, webhook receipt, the
// due-detection engine. No staff-facing UI or real message sending yet
// (Phase 2 -- src/addon.js, src/messaging.js).

import { randomId, json, escapeHtml, readJson } from "./util.js";
import { buildAuthorizeUrl, exchangeCodeForTokens, storeTokens, getValidAccessToken } from "./servicem8-oauth.js";
import { getJob, listCategories, rawGet, getVendorName, sendPlatformSmsRaw, toE164Au, isSendableMobile, listAllCompletedJobs, listBadges, updateBadge, parseBadges } from "./servicem8-api.js";
import { registerAllWebhooks, captureRawDelivery, maybeHandleHandshake, parseWebhookPayload } from "./webhooks.js";
import { backfillChunk, recomputeCategory, recomputeAllCategoriesForTenant, generateFollowUpDraftsForTenant, ensureRenewalBadges, migrateLegacyFollowUpBadges, verifyDeliveries, reassignBadgesForTenant, planBadgeMoves, normalizeStreet, RENEWAL_BADGES } from "./due-engine.js";
import { verifyAddonJwt, createDashboardToken, verifyDashboardToken } from "./addon.js";
import { renderDashboardHtml, approveAndSendDraft, dismissDueCustomer } from "./dashboard.js";

// ---- install / OAuth2 ------------------------------------------------

// Entry point a business hits to install (from the ServiceM8 Add-on Store,
// or -- pre-listing -- the Developer Portal's Private Add-on Install URL,
// which is expected to land here too). `state` is a CSRF nonce carried
// through the redirect round-trip via query string (no server-side session
// exists yet at this point -- there's no tenant to attach one to).
async function handleInstallStart(request, env) {
  const url = new URL(request.url);
  const state = randomId(16);
  const authorizeUrl = buildAuthorizeUrl({
    appId: env.SERVICEM8_APP_ID,
    redirectUri: `${url.origin}/oauth/callback`,
    state,
  });
  return Response.redirect(authorizeUrl, 302);
}

function installedPageHtml() {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;max-width:32rem;margin:0 auto;">
    <h2>Job Reminders is now installed</h2>
    <p>Open ServiceM8 and look for job reminders in your Add-ons menu to get started make sure you have the specific month badge appied to the jobs.</p>
  </body></html>`;
}

function installErrorHtml(message) {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#c41613;">${escapeHtml(message)}</body></html>`;
}

// Note: `state` is generated per-install-attempt but not currently verified
// against a stored value (no session to store it in before a tenant exists).
// This is a known gap, not an oversight -- acceptable for Phase 1 testing
// against TCB's own account; revisit before Partner Preview submission if a
// stronger CSRF guarantee is needed for the public flow.
async function handleOAuthCallback(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return new Response(installErrorHtml("Missing authorization code."), { status: 400, headers: { "Content-Type": "text/html" } });

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(env, { code, redirectUri: `${url.origin}/oauth/callback` });
  } catch (err) {
    console.error("oauth callback: token exchange failed", err);
    return new Response(installErrorHtml("Installation failed -- please try again."), { status: 502, headers: { "Content-Type": "text/html" } });
  }

  // We generate our own tenant_id rather than trying to resolve ServiceM8's
  // real accountUUID up front -- there's no confirmed "whoami" endpoint (see
  // plan's open risks), and we don't actually need their UUID as our own
  // primary key. Webhook delivery-to-tenant attribution is handled via a
  // `?tenant=` query param on the callback URL we register (see
  // registerAllWebhooks), not by matching an account identifier out of
  // ServiceM8's payload.
  //
  // Always create a fresh provisional row here rather than guessing "this
  // must be a reinstall of the one tenant that already exists" -- a genuinely
  // new second business installing while exactly one resolved tenant already
  // exists is indistinguishable from that tenant reinstalling at this point
  // (no accountUUID yet), and the old "if exactly one resolved tenant exists,
  // overwrite its tokens" shortcut would silently hijack an existing real
  // tenant's credentials with a brand new business's tokens. Reinstalls of an
  // already-known tenant get reconciled properly once their first
  // addon-callback JWT arrives -- see resolveTenantFromAccountUuid, which
  // migrates the freshest unresolved candidate's tokens onto the correct
  // existing tenant row rather than leaving them orphaned.
  const tenantId = randomId();
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO tenants (servicem8_account_uuid, status, backfill_complete, backfill_cursor, installed_at)
       VALUES (?, 'active', 0, NULL, ?)`
    )
      .bind(tenantId, now)
      .run();
    await storeTokens(env.DB, tenantId, tokens);
    await env.DB.prepare(
      `INSERT INTO tenant_settings (tenant_id, default_channel) VALUES (?, 'sms')`
    )
      .bind(tenantId)
      .run();
  } catch (err) {
    console.error("oauth callback: failed to persist new tenant", err);
    return new Response(installErrorHtml("Installation failed -- please try again."), { status: 502, headers: { "Content-Type": "text/html" } });
  }

  const callbackUrl = `${url.origin}/webhooks/servicem8?tenant=${tenantId}`;
  const registerWebhooks = registerAllWebhooks(env, tenantId, callbackUrl);
  if (ctx && ctx.waitUntil) ctx.waitUntil(registerWebhooks);
  else await registerWebhooks;

  // Auto-create Renewal Autopilot's badges in the new account so the business
  // has something to apply to jobs immediately, rather than hand-making one
  // first. Uses generic pre-designed sprite images (see ensureRenewalBadges)
  // -- a bare API-created badge with no image renders blank, so a real image
  // is required. Which cadence to actually track is chosen later in the setup
  // wizard; this just provisions the badges. Non-fatal if it fails (the
  // business can still make a badge manually), so it never blocks install.
  const provisionBadges = ensureRenewalBadges(env, tenantId, url.origin).catch((err) =>
    console.error(`install: badge provisioning failed for tenant ${tenantId}`, err)
  );
  if (ctx && ctx.waitUntil) ctx.waitUntil(provisionBadges);
  else await provisionBadges;

  // Capture the installing account's own business name (vendor scope) so
  // reminder messages can be signed off with it. Non-fatal -- if the scope
  // isn't granted or the call fails, the sign-off is simply omitted.
  const captureBusinessName = getVendorName(env, tenantId)
    .then((name) => {
      if (name) return env.DB.prepare("UPDATE tenant_settings SET business_name = ? WHERE tenant_id = ?").bind(name, tenantId).run();
    })
    .catch((err) => console.error(`install: business-name capture failed for tenant ${tenantId}`, err));
  if (ctx && ctx.waitUntil) ctx.waitUntil(captureBusinessName);
  else await captureBusinessName;

  return new Response(installedPageHtml(), { headers: { "Content-Type": "text/html" } });
}

// ---- webhooks ----------------------------------------------------------

async function handleWebhook(request, env, ctx) {
  const handshake = await maybeHandleHandshake(request);
  if (handshake) return handshake;

  const tenantId = new URL(request.url).searchParams.get("tenant");
  const contentType = request.headers.get("Content-Type") || "";
  const rawBody = await request.clone().text();
  await captureRawDelivery(env.DB, { tenantId, contentType, body: rawBody });

  if (!tenantId) {
    console.error("webhook: no ?tenant= on callback URL, cannot attribute delivery");
    return json({ ok: true, skipped: "no-tenant" });
  }
  const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE servicem8_account_uuid = ?").bind(tenantId).first();
  if (!tenant || tenant.status !== "active") {
    return json({ ok: true, skipped: "unknown-or-inactive-tenant" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null;
  }
  const { jobUuid } = parseWebhookPayload(payload);
  if (!jobUuid) {
    console.error(`webhook: no job uuid found in payload for tenant ${tenantId}`, rawBody.slice(0, 500));
    return json({ ok: true, skipped: "no-job-uuid" });
  }

  const work = handleJobWebhook(env, tenantId, jobUuid);
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  else await work;

  return json({ ok: true });
}

// A single job changed -- look up its category and recompute just that
// category for this tenant. Not the cheapest possible approach (recompute
// pulls all of that category's completed jobs, not just this one), but
// correct and simple for Phase 1; worth revisiting for efficiency once a
// tenant with real volume is on the system.
async function handleJobWebhook(env, tenantId, jobUuid) {
  let job;
  try {
    job = await getJob(env, tenantId, jobUuid);
  } catch (err) {
    console.error(`webhook: failed to fetch job ${jobUuid} for tenant ${tenantId}`, err);
    return;
  }
  if (!job || job.status !== "Completed") return;

  // A job can match a category-based rule (by job.category_uuid) or a
  // badge-based rule (by job.badges including the rule's badge) -- check
  // every tracked rule for this tenant rather than a single indexed lookup,
  // since which rules exist and what they key on is per-tenant config.
  const { results: rules } = await env.DB.prepare("SELECT * FROM category_config WHERE tenant_id = ? AND is_tracked = 1")
    .bind(tenantId)
    .all();
  // job.badges comes back from ServiceM8 as a JSON-encoded string (see
  // parseBadges), not a real array -- Array.isArray(job.badges) was always
  // false, so badge-based rules never matched here and only ever got picked
  // up by the once-daily nightly cron instead of this real-time webhook path.
  const matchingRules = (rules || []).filter((rule) =>
    rule.signal_type === "badge"
      ? parseBadges(job.badges).includes(rule.servicem8_badge_uuid)
      : job.category_uuid === rule.servicem8_category_uuid
  );
  if (!matchingRules.length) return; // this job doesn't match any tracked rule

  try {
    for (const rule of matchingRules) await recomputeCategory(env, tenantId, rule);
  } catch (err) {
    console.error(`webhook: recompute failed for tenant ${tenantId}, category ${job.category_uuid}`, err);
  }
}

// ---- scheduled (cron) ----------------------------------------------------
//
// Two schedules configured in wrangler.jsonc: a nightly full reconciliation
// (source-of-truth backstop for missed/expired webhooks) and a short
// 2-minute sweep for chunked backfill continuation + proactive token
// refresh. Distinguished by event.cron.

const NIGHTLY_CRON = "0 16 * * *";

// Hardcoded rather than derived from a request -- the cron has no incoming
// request to read an origin from. Matches the URL already hardcoded into
// manifest.json.
const PRODUCTION_ORIGIN = "https://renewal-autopilot.phill-abb.workers.dev";

async function runNightlyReconciliation(env) {
  const { results: tenants } = await env.DB.prepare("SELECT * FROM tenants WHERE status = 'active'").all();
  for (const tenant of tenants || []) {
    const runId = randomId();
    const startedAt = Date.now();
    try {
      // Before the recompute, not after: a customer serviced again since the
      // last run needs their badge on the newer job so the recompute picks up
      // the new date in this same pass rather than a day late.
      await reassignBadgesForTenant(env, tenant.servicem8_account_uuid);
      const { jobsScanned } = await recomputeAllCategoriesForTenant(env, tenant.servicem8_account_uuid);
      await generateFollowUpDraftsForTenant(env, tenant.servicem8_account_uuid);
      await env.DB.prepare(
        `INSERT INTO cron_runs (id, tenant_id, started_at, finished_at, jobs_scanned, due_found, error)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`
      )
        .bind(runId, tenant.servicem8_account_uuid, startedAt, Date.now(), jobsScanned)
        .run();
    } catch (err) {
      console.error(`nightly reconciliation failed for tenant ${tenant.servicem8_account_uuid}`, err);
      await env.DB.prepare(
        `INSERT INTO cron_runs (id, tenant_id, started_at, finished_at, jobs_scanned, due_found, error)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`
      )
        .bind(randomId(), tenant.servicem8_account_uuid, startedAt, Date.now(), String(err && err.message))
        .run();
    }
  }
}

async function runBackfillAndRefreshSweep(env) {
  const { results: pending } = await env.DB.prepare("SELECT * FROM tenants WHERE status = 'active' AND backfill_complete = 0").all();
  for (const tenant of pending || []) {
    try {
      await backfillChunk(env, tenant);
    } catch (err) {
      console.error(`backfill chunk failed for tenant ${tenant.servicem8_account_uuid}`, err);
    }
  }

  // Proactively refresh tokens expiring soon, so a quiet tenant (no webhook
  // traffic) never has its very first API call of the day fail on an
  // expired token -- getValidAccessToken would still handle it inline, but
  // this keeps steady-state latency off the critical path.
  const soon = Date.now() + 5 * 60_000;
  const { results: expiringSoon } = await env.DB.prepare(
    "SELECT tenant_id FROM oauth_tokens WHERE access_token_expires_at < ?"
  )
    .bind(soon)
    .all();
  for (const row of expiringSoon || []) {
    try {
      await getValidAccessToken(env, row.tenant_id);
    } catch (err) {
      console.error(`proactive token refresh failed for tenant ${row.tenant_id}`, err);
    }
  }

  // Verify recently-"sent" drafts actually got delivered -- ServiceM8's 2xx
  // send response alone doesn't prove that (see verifyDeliveries). Cheap in
  // steady state: two D1 queries per tenant unless unverified sends exist.
  await verifyDeliveries(env);

  // Keep each tenant's Renewal badges in sync with RENEWAL_BADGES -- not
  // just present at install time. ensureRenewalBadges only sets a badge's
  // image when it's first created, so a later sprite change (like the v9
  // gray/yellow/green recolor) would otherwise never reach a tenant whose
  // badges already existed under those names, without someone manually
  // running /debug/update-badge-images. This sweep does it automatically;
  // a badge already in sync is a no-op (see ensureRenewalBadges), so it's
  // cheap in steady state.
  const { results: activeTenants } = await env.DB.prepare("SELECT servicem8_account_uuid FROM tenants WHERE status = 'active'").all();
  for (const { servicem8_account_uuid } of activeTenants || []) {
    try {
      await ensureRenewalBadges(env, servicem8_account_uuid, PRODUCTION_ORIGIN);
    } catch (err) {
      console.error(`badge sync sweep failed for tenant ${servicem8_account_uuid}`, err);
    }
    // PAUSED 2026-08-24: this added "1 year auto" to every job carrying
    // "1 Year Follow-up" indiscriminately -- no dedup to the latest job per
    // property (the actual badge hand-off semantics group by company+address
    // and pick the single latest non-warranty completed job -- see
    // planBadgeMoves), and it never removed "1 Year Follow-up" either. Live
    // data may already have been touched by this before it was caught;
    // re-enable only once replaced with logic that mirrors planBadgeMoves.
    try {
      // await migrateLegacyFollowUpBadges(env, servicem8_account_uuid);
    } catch (err) {
      console.error(`legacy badge migration failed for tenant ${servicem8_account_uuid}`, err);
    }
  }
}

// ---- ServiceM8 Add-on: job-card button -> standalone dashboard -----------
//
// Same job-card-action mechanism as tcb-customer-portal's "Approve Forms for
// Portal" (confirmed working against the real account -- see the "Addons"
// flyout menu on a job card), registered in manifest.json under
// "actions". Unlike that add-on, the callback doesn't render a form inline --
// it immediately opens the full due/renewal queue as a standalone page in a
// new tab (src/dashboard.js), authenticated by a short-lived token instead
// of a login system.

function addonResponse(html) {
  return new Response(JSON.stringify({ eventResponse: html }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function addonErrorHtml(message) {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:1.5rem;color:#c41613;">${escapeHtml(message)}</body></html>`;
}

// Resolves our internal tenant_id from the addon callback JWT's real
// ServiceM8 accountUUID. Opportunistically backfills tenants.resolved_account_uuid
// the first time this fires for a tenant.
//
// There's no confirmed "whoami" API call to learn the real accountUUID right
// at install time (see plan's open risks), so a fresh tenant row sits
// unresolved until its first addon-callback JWT arrives -- every hit on
// /oauth/callback creates one (see handleOAuthCallback), including reinstalls
// of an already-known tenant, since there's no way to tell those apart from
// a brand new business installing until this JWT arrives.
//
// Two cases once the real accountUuid is known:
//  - Already resolved to an existing tenant: normally just return it. But if
//    a *newer* unresolved row exists with fresher oauth_tokens than that
//    tenant's, this is a reinstall/rescope -- migrate the fresh tokens onto
//    the existing (resolved) row so its id, and everything keyed on it
//    (due_customers, reminder_drafts, etc), stays intact, instead of leaving
//    the fresh tokens stranded on a row nothing will ever look up again.
//  - Not yet resolved: a genuinely new tenant (or the very first resolve for
//    one). Pick whichever unresolved active row has the most recently issued
//    token as "the install ServiceM8 currently has authorized" and retire
//    the rest.
// Known remaining gap: if two *different* brand-new installs are mid-flight
// at the same moment, both look like unresolved candidates and whichever
// isn't picked gets retired as a "stale duplicate" -- true concurrent-install
// disambiguation needs the OAuth `state` param tied to a stored session,
// which doesn't exist yet (see handleOAuthCallback's CSRF note).
async function resolveTenantFromAccountUuid(env, accountUuid) {
  const byResolved = await env.DB.prepare("SELECT * FROM tenants WHERE resolved_account_uuid = ?").bind(accountUuid).first();

  const { results: candidates } = await env.DB.prepare(
    `SELECT t.* FROM tenants t
     JOIN oauth_tokens o ON o.tenant_id = t.servicem8_account_uuid
     WHERE t.status = 'active' AND t.resolved_account_uuid IS NULL
     ORDER BY o.updated_at DESC`
  ).all();

  if (byResolved) {
    if (candidates && candidates.length) {
      const freshest = candidates[0];
      const freshTokens = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE tenant_id = ?").bind(freshest.servicem8_account_uuid).first();
      const currentTokens = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE tenant_id = ?").bind(byResolved.servicem8_account_uuid).first();
      if (freshTokens && (!currentTokens || freshTokens.updated_at > currentTokens.updated_at)) {
        await env.DB.prepare(
          `UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, scope = ?, updated_at = ? WHERE tenant_id = ?`
        )
          .bind(freshTokens.access_token, freshTokens.refresh_token, freshTokens.access_token_expires_at, freshTokens.scope, freshTokens.updated_at, byResolved.servicem8_account_uuid)
          .run();
      }
      // A reinstall captures fresh tenant_settings (e.g. business_name from
      // /vendor.json) on the provisional row -- carry those onto the resolved
      // tenant so they aren't stranded when the provisional row is retired.
      const freshSettings = await env.DB.prepare("SELECT business_name FROM tenant_settings WHERE tenant_id = ?").bind(freshest.servicem8_account_uuid).first();
      if (freshSettings?.business_name) {
        await env.DB.prepare("UPDATE tenant_settings SET business_name = ? WHERE tenant_id = ?")
          .bind(freshSettings.business_name, byResolved.servicem8_account_uuid)
          .run();
      }
      for (const stale of candidates) {
        await env.DB.prepare("UPDATE tenants SET status = 'uninstalled', uninstalled_at = ? WHERE servicem8_account_uuid = ?")
          .bind(Date.now(), stale.servicem8_account_uuid)
          .run();
      }
    }
    return byResolved;
  }

  if (!candidates || candidates.length === 0) {
    console.error(`resolveTenantFromAccountUuid: no unresolved active tenant candidates for account ${accountUuid}`);
    return null;
  }

  const winner = candidates[0];
  await env.DB.prepare("UPDATE tenants SET resolved_account_uuid = ? WHERE servicem8_account_uuid = ?")
    .bind(accountUuid, winner.servicem8_account_uuid)
    .run();

  for (const stale of candidates.slice(1)) {
    await env.DB.prepare("UPDATE tenants SET status = 'uninstalled', uninstalled_at = ? WHERE servicem8_account_uuid = ?")
      .bind(Date.now(), stale.servicem8_account_uuid)
      .run();
  }

  return winner;
}

function dashboardRedirectHtml(dashboardUrl) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://platform.servicem8.com/sdk/1.0/sdk.css" />
<script src="https://platform.servicem8.com/sdk/1.0/sdk.js"></script>
</head>
<body style="font-family:sans-serif;padding:1.5rem;text-align:center;">
  <p>Opening Renewal Autopilot in a new tab&hellip;</p>
  <p><a id="fallback" href="${escapeHtml(dashboardUrl)}" target="_blank" rel="noopener" style="color:#2b2b30;">Click here if it didn't open automatically</a></p>
  <script>
    try {
      var smClient = (typeof SMClient !== 'undefined') ? SMClient.init() : null;
      if (smClient && smClient.resizeWindow) smClient.resizeWindow(420, 200);
    } catch (err) {}
    window.open(${JSON.stringify(dashboardUrl)}, '_blank');
  </script>
</body></html>`;
}

async function handleAddonQueue(request, env) {
  const jwt = await request.text();
  // Every response here is deliberately HTTP 200, even on failure -- same
  // reasoning as tcb-customer-portal: ServiceM8's relay discards non-2xx
  // callback responses and renders a blank modal with no error text instead.
  const payload = await verifyAddonJwt(env.SERVICEM8_APP_SECRET, jwt);
  if (!payload) return addonResponse(addonErrorHtml("Could not verify this request."));

  const accountUuid = payload?.auth?.accountUUID;
  if (!accountUuid) return addonResponse(addonErrorHtml("No account information was provided."));

  const tenant = await resolveTenantFromAccountUuid(env, accountUuid);
  if (!tenant) return addonResponse(addonErrorHtml("Could not identify your account. Please reinstall the add-on."));

  const origin = new URL(request.url).origin;
  const token = await createDashboardToken(env.SERVICEM8_APP_SECRET, tenant.servicem8_account_uuid);
  // Client-card button (manifest action entity "company"): open the queue
  // focused on the client whose card was clicked, rather than the whole list.
  // The job-card button and the Add-ons menu item send no company, so they
  // keep opening the full queue. ServiceM8's own docs don't pin down the
  // eventArgs key for a company action, so every plausible spelling is
  // accepted -- an unrecognised one simply means no focus, not a broken page.
  const args = payload?.eventArgs || {};
  const companyUuid = args.companyUUID || args.company_uuid || args.clientUUID || args.client_uuid || null;
  const dashboardUrl =
    `${origin}/dashboard?token=${encodeURIComponent(token)}` + (companyUuid ? `&company=${encodeURIComponent(companyUuid)}` : "");
  return addonResponse(dashboardRedirectHtml(dashboardUrl));
}

function handleAddonPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function handleDashboard(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  const tenantId = await verifyDashboardToken(env.SERVICEM8_APP_SECRET, token);
  if (!tenantId) {
    return new Response(addonErrorHtml("This link has expired. Please reopen Renewal Autopilot from ServiceM8."), {
      status: 401,
      headers: { "Content-Type": "text/html" },
    });
  }
  const focusCompanyUuid = new URL(request.url).searchParams.get("company");
  const html = await renderDashboardHtml(env, tenantId, token, { focusCompanyUuid });
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function handleDashboardApprove(request, env) {
  // resend: an explicit staff choice to send a channel again. Without it an
  // already-sent draft is a no-op, so a double-clicked button still can't
  // send twice.
  const { token, draftId, editedBody, resend } = await readJson(request);
  const tenantId = await verifyDashboardToken(env.SERVICEM8_APP_SECRET, token);
  if (!tenantId) return json({ error: "invalid or expired token" }, { status: 401 });
  if (!draftId) return json({ error: "draftId required" }, { status: 400 });

  try {
    await approveAndSendDraft(env, tenantId, draftId, editedBody, { resend: resend === true });
    return json({ ok: true });
  } catch (err) {
    console.error(`dashboard approve failed for tenant ${tenantId}, draft ${draftId}`, err);
    return json({ error: "could not send this reminder right now" }, { status: 502 });
  }
}

async function handleDashboardDismiss(request, env) {
  const { token, dueCustomerId } = await readJson(request);
  const tenantId = await verifyDashboardToken(env.SERVICEM8_APP_SECRET, token);
  if (!tenantId) return json({ error: "invalid or expired token" }, { status: 401 });
  if (!dueCustomerId) return json({ error: "dueCustomerId required" }, { status: 400 });

  try {
    await dismissDueCustomer(env, tenantId, dueCustomerId);
    return json({ ok: true });
  } catch (err) {
    console.error(`dashboard dismiss failed for tenant ${tenantId}, due_customer ${dueCustomerId}`, err);
    return json({ error: "could not dismiss this customer right now" }, { status: 502 });
  }
}

// ---- admin routes ----------------------------------------------------------
// Standing in for the Phase 2 setup wizard, which doesn't exist yet -- these
// let us configure tracking rules and run the engine manually. Gated by
// requireAdminAuth (shares the App Secret -- no separate admin credential to
// manage) since these expose/mutate any tenant's data by uuid alone.

function requireAdminAuth(request, env) {
  const url = new URL(request.url);
  const key = request.headers.get("X-Admin-Key") || url.searchParams.get("adminKey");
  return key === env.SERVICEM8_APP_SECRET;
}

// Runs the badge hand-off on demand instead of waiting for the nightly cron.
// Defaults to a DRY RUN: ?apply=1 is required before anything is written,
// because this edits badges staff applied by hand in ServiceM8. The dry run
// reports exactly which jobs would gain and lose the badge, so the change can
// be eyeballed before it happens.
async function handleDebugBadgeHandoff(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const apply = url.searchParams.get("apply") === "1";

  try {
    if (apply) return json({ mode: "applied", ...(await reassignBadgesForTenant(env, tenantId)) });

    const { results: rules } = await env.DB.prepare(
      "SELECT * FROM category_config WHERE tenant_id = ? AND signal_type = 'badge' AND is_tracked = 1 AND servicem8_badge_uuid IS NOT NULL"
    )
      .bind(tenantId)
      .all();
    const jobs = (await listAllCompletedJobs(env, tenantId)) || [];
    const warranty = new Set(
      ((await listCategories(env, tenantId)) || []).filter((c) => /warranty/i.test(c.name || "")).map((c) => c.uuid)
    );
    const planned = [];
    for (const rule of rules || []) {
      for (const m of planBadgeMoves(jobs, rule.servicem8_badge_uuid, warranty)) {
        planned.push({
          rule: rule.category_name_cache,
          address: m.addressKey,
          addTo: m.addTo ? `#${m.addTo.generated_job_id} (${m.addTo.uuid})` : null,
          removeFrom: m.removeFrom.map((j) => `#${j.generated_job_id} (${j.uuid})`),
          dateChanged: m.dateChanged,
        });
      }
    }
    return json({ mode: "dry-run", jobsScanned: jobs.length, rules: (rules || []).length, moves: planned.length, planned });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

// One-off migration for the normalizeStreet fix that stopped the slash being
// stripped from unit numbers. address_key is part of due_customers' UNIQUE
// constraint, so leaving stale keys behind would make the next recompute
// INSERT a second row per affected customer rather than update the existing
// one -- 41 duplicated customers in the dashboard, each with its own drafts.
//
// Recomputes the key from address_display (the raw ServiceM8 address) using
// the current normalizeStreet, so it stays correct if that function changes
// again. Dry run by default; ?apply=1 to write. A row whose new key would
// collide with an existing row is reported and skipped rather than merged --
// that case needs a human, not a guess.
async function handleDebugRekeyAddresses(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const apply = url.searchParams.get("apply") === "1";

  const { results: rows } = await env.DB.prepare(
    "SELECT id, address_key, address_display, servicem8_company_uuid, category_config_id FROM due_customers WHERE tenant_id = ?"
  )
    .bind(tenantId)
    .all();

  const changed = [];
  const conflicts = [];
  for (const r of rows || []) {
    const newKey = normalizeStreet(r.address_display);
    if (!newKey || newKey === r.address_key) continue;
    const clash = await env.DB.prepare(
      "SELECT id FROM due_customers WHERE tenant_id = ? AND servicem8_company_uuid = ? AND address_key = ? AND category_config_id = ? AND id != ?"
    )
      .bind(tenantId, r.servicem8_company_uuid, newKey, r.category_config_id, r.id)
      .first();
    if (clash) {
      conflicts.push({ id: r.id, from: r.address_key, to: newKey, collidesWith: clash.id });
      continue;
    }
    changed.push({ id: r.id, from: r.address_key, to: newKey, display: r.address_display });
    if (apply) await env.DB.prepare("UPDATE due_customers SET address_key = ? WHERE id = ?").bind(newKey, r.id).run();
  }

  return json({ mode: apply ? "applied" : "dry-run", scanned: (rows || []).length, changed: changed.length, conflicts, changes: changed });
}

async function handleDebugCategories(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  try {
    const categories = await listCategories(env, tenantId);
    return json({ categories });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

// Pushes the current RENEWAL_BADGES sprite files onto whichever badges
// already exist with those exact names -- ensureRenewalBadges only creates
// missing badges, so a tenant whose "3 month auto"/"6 month auto"/"1 year
// auto" badges pre-date a sprite change (e.g. the v9 gray/yellow/green
// recolor) never picks it up on its own. Dry run by default; ?apply=1 to
// actually call ServiceM8. Matches by exact badge name, same lookup
// ensureRenewalBadges uses.
async function handleDebugUpdateBadgeImages(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const apply = url.searchParams.get("apply") === "1";

  try {
    const existing = (await listBadges(env, tenantId)) || [];
    const existingByName = new Map(existing.map((b) => [b.name, b.uuid]));

    const planned = [];
    for (const { name, file } of RENEWAL_BADGES) {
      const uuid = existingByName.get(name);
      if (!uuid) {
        planned.push({ name, status: "no matching live badge -- ensureRenewalBadges will create it on next install/run" });
        continue;
      }
      const fileUrl = `${url.origin}/assets/images/${file}`;
      if (apply) await updateBadge(env, tenantId, uuid, { fileUrl });
      planned.push({ name, uuid, fileUrl, status: apply ? "updated" : "would update" });
    }
    return json({ mode: apply ? "applied" : "dry-run", badges: planned });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

// Configures a tracking rule -- either signalType "category" (categoryUuid)
// or "badge" (badgeUuid). No DB-level unique constraint on the target uuid
// since a tenant may have several rules of either kind; upsert is done by
// hand (look up an existing rule for this exact signal, update it, else
// insert) rather than relying on ON CONFLICT.
async function handleDebugConfigureCategory(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const { tenant, categoryUuid, badgeUuid, categoryName, intervalMonths } = await readJson(request);
  const signalType = badgeUuid ? "badge" : "category";
  const targetUuid = badgeUuid || categoryUuid;
  if (!tenant || !targetUuid || !intervalMonths) {
    return json({ error: "tenant, (categoryUuid or badgeUuid), intervalMonths required" }, { status: 400 });
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM category_config WHERE tenant_id = ? AND signal_type = ? AND (servicem8_category_uuid = ? OR servicem8_badge_uuid = ?)`
  )
    .bind(tenant, signalType, targetUuid, targetUuid)
    .first();

  if (existing) {
    await env.DB.prepare(`UPDATE category_config SET interval_months = ?, category_name_cache = ? WHERE id = ?`)
      .bind(intervalMonths, categoryName || "", existing.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO category_config (id, tenant_id, signal_type, servicem8_category_uuid, servicem8_badge_uuid, category_name_cache, interval_months)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(randomId(), tenant, signalType, signalType === "category" ? targetUuid : null, signalType === "badge" ? targetUuid : null, categoryName || "", intervalMonths)
      .run();
  }
  return json({ ok: true });
}

async function handleDebugRecompute(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  try {
    const result = await recomputeAllCategoriesForTenant(env, tenantId);
    await generateFollowUpDraftsForTenant(env, tenantId);
    return json(result);
  } catch (err) {
    return json({ error: String(err && err.message), stack: err && err.stack }, { status: 502 });
  }
}

async function handleDebugDueCustomers(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const { results } = await env.DB.prepare(
    "SELECT * FROM due_customers WHERE tenant_id = ? ORDER BY bucket, last_completed_at"
  )
    .bind(tenantId)
    .all();
  return json({ dueCustomers: results || [] });
}

// Admin-gated SMS probe -- sends a real test SMS and returns the raw
// ServiceM8 Messaging API response (HTTP status, errorCode, messageID).
async function handleDebugSmsProbe(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  const to = url.searchParams.get("to");
  const jobUuid = url.searchParams.get("job");
  if (!tenantId || !to) return json({ error: "?tenant= and ?to= required" }, { status: 400 });
  try {
    const result = await sendPlatformSmsRaw(env, tenantId, {
      to,
      message: "Renewal Autopilot SMS probe -- diagnostic test, please ignore.",
      regardingJobUuid: jobUuid || undefined,
    });
    return json(result);
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

// Phone-number normalization check that SENDS NOTHING. Exists because the
// only previous way to find out whether a number would be accepted was to
// actually send to it -- which, on 2026-08-07, put a real (undeliverable)
// message against a customer's job while testing the validator.
// ?phone= checks one number; ?tenant= audits every tracked customer's.
async function handleDebugCheckPhone(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const phone = url.searchParams.get("phone");
  const tenantId = url.searchParams.get("tenant");

  if (phone !== null) {
    return json({ input: phone, normalized: toE164Au(phone), sendable: isSendableMobile(phone) });
  }
  if (!tenantId) return json({ error: "?phone= or ?tenant= required" }, { status: 400 });

  const { results } = await env.DB.prepare(
    `SELECT contact_name_cache, contact_phone_cache, last_job_number FROM due_customers
     WHERE tenant_id = ? AND suppressed_reason IS NULL AND dismissed_at IS NULL`
  )
    .bind(tenantId)
    .all();
  const unsendable = (results || [])
    .filter((r) => !isSendableMobile(r.contact_phone_cache))
    .map((r) => ({
      name: r.contact_name_cache,
      job: r.last_job_number,
      stored: r.contact_phone_cache,
      normalized: toE164Au(r.contact_phone_cache) || null,
      reason: r.contact_phone_cache ? "not an Australian mobile" : "no phone number on file",
    }));
  return json({ tracked: (results || []).length, sendable: (results || []).length - unsendable.length, unsendable });
}

// Admin-gated raw ServiceM8 GET passthrough, for diagnosing data issues.
async function handleDebugRaw(request, env) {
  if (!requireAdminAuth(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  const path = url.searchParams.get("path");
  if (!tenantId || !path) return json({ error: "?tenant= and ?path= required" }, { status: 400 });
  try {
    return json({ data: await rawGet(env, tenantId, path) });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

// ---- router --------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const method = request.method;

    if (pathname === "/install" && method === "GET") return handleInstallStart(request, env);
    if (pathname === "/oauth/callback" && method === "GET") return handleOAuthCallback(request, env, ctx);
    // The Developer Portal only exposes one "Callback URL" field for the
    // whole app -- confirmed via wrangler tail against a real job-card click,
    // which arrived as a POST to this same path ServiceM8 uses for the OAuth
    // redirect (a GET with ?code=). The manifest action's "url" key is not
    // actually honoured. Dispatch by method rather than path.
    if (pathname === "/oauth/callback" && method === "POST") return handleAddonQueue(request, env);
    if (pathname === "/webhooks/servicem8" && method === "POST") return handleWebhook(request, env, ctx);

    if (pathname === "/addon/queue" && method === "POST") return handleAddonQueue(request, env);
    if (pathname === "/addon/queue" && method === "OPTIONS") return handleAddonPreflight();
    if (pathname === "/dashboard" && method === "GET") return handleDashboard(request, env);
    if (pathname === "/dashboard/approve" && method === "POST") return handleDashboardApprove(request, env);
    if (pathname === "/dashboard/dismiss" && method === "POST") return handleDashboardDismiss(request, env);

    if (pathname === "/debug/badge-handoff" && method === "GET") return handleDebugBadgeHandoff(request, env);
    if (pathname === "/debug/rekey-addresses" && method === "GET") return handleDebugRekeyAddresses(request, env);
    if (pathname === "/debug/categories" && method === "GET") return handleDebugCategories(request, env);
    if (pathname === "/debug/update-badge-images" && method === "GET") return handleDebugUpdateBadgeImages(request, env);
    if (pathname === "/debug/configure-category" && method === "POST") return handleDebugConfigureCategory(request, env);
    if (pathname === "/debug/recompute" && method === "POST") return handleDebugRecompute(request, env);
    if (pathname === "/debug/due-customers" && method === "GET") return handleDebugDueCustomers(request, env);
    if (pathname === "/debug/raw" && method === "GET") return handleDebugRaw(request, env);
    if (pathname === "/debug/check-phone" && method === "GET") return handleDebugCheckPhone(request, env);
    if (pathname === "/debug/sms-probe" && method === "POST") return handleDebugSmsProbe(request, env);

    if (pathname === "/") {
      return new Response(installedPageHtml(), { headers: { "Content-Type": "text/html" } });
    }

    return json({ error: "not found" }, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const work = event.cron === NIGHTLY_CRON ? runNightlyReconciliation(env) : runBackfillAndRefreshSweep(env);
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    else await work;
  },
};
