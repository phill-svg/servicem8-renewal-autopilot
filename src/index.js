// Renewal Autopilot -- router + cron entry points.
// See C:\Users\Phill\.claude\plans\scalable-painting-beacon.md for the full
// design/rationale. Phase 1 scope: OAuth install, webhook receipt, the
// due-detection engine. No staff-facing UI or real message sending yet
// (Phase 2 -- src/addon.js, src/messaging.js).

import { randomId, json, escapeHtml, readJson } from "./util.js";
import { buildAuthorizeUrl, exchangeCodeForTokens, storeTokens, getValidAccessToken } from "./servicem8-oauth.js";
import { getJob, listCategories, getPrimaryContact, listAllCompletedJobs, listOpenJobsForCompany, listCompletedJobsForCategory, updateJobCategory, rawGet, createBadge, listBadges, updateBadge } from "./servicem8-api.js";
import { registerAllWebhooks, captureRawDelivery, maybeHandleHandshake, parseWebhookPayload } from "./webhooks.js";
import { backfillChunk, recomputeCategory, recomputeAllCategoriesForTenant, ensureRenewalBadgesAndDefaultRule } from "./due-engine.js";
import { verifyAddonJwt, createDashboardToken, verifyDashboardToken } from "./addon.js";
import { renderDashboardHtml, approveAndSendDraft } from "./dashboard.js";

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
    <h2>Renewal Autopilot is installed</h2>
    <p>Open ServiceM8 and look for Renewal Autopilot in your Add-ons menu to configure which job categories to track and how often each one recurs.</p>
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
  // A retried/rescoped install (e.g. changing OAuth scopes in the Developer
  // Portal) hits this same callback again with no way to know it's "the same"
  // ServiceM8 account until its first addon-callback JWT resolves it -- see
  // resolveTenantFromAccountUuid. If exactly one already-resolved tenant
  // exists, treat this as a reinstall of that tenant (refresh its token in
  // place) rather than minting a new row that would need re-resolving. This
  // is still a single-real-tenant simplification, same as
  // resolveTenantFromAccountUuid -- true multi-tenant reinstall handling
  // needs a real account-identifying call, which doesn't exist yet.
  const { results: resolvedTenants } = await env.DB.prepare(
    "SELECT * FROM tenants WHERE status = 'active' AND resolved_account_uuid IS NOT NULL"
  ).all();

  let tenantId;
  const now = Date.now();
  if ((resolvedTenants || []).length === 1) {
    tenantId = resolvedTenants[0].servicem8_account_uuid;
    try {
      await storeTokens(env.DB, tenantId, tokens);
    } catch (err) {
      console.error("oauth callback: failed to refresh existing tenant's tokens", err);
      return new Response(installErrorHtml("Installation failed -- please try again."), { status: 502, headers: { "Content-Type": "text/html" } });
    }
  } else {
    tenantId = randomId();
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
  }

  const callbackUrl = `${url.origin}/webhooks/servicem8?tenant=${tenantId}`;
  const registerWebhooks = registerAllWebhooks(env, tenantId, callbackUrl);
  if (ctx && ctx.waitUntil) ctx.waitUntil(registerWebhooks);
  else await registerWebhooks;

  // Awaited (not backgrounded) so the tenant has a working default rule the
  // moment install finishes, not some indeterminate time later.
  try {
    await ensureRenewalBadgesAndDefaultRule(env, tenantId, url.origin);
  } catch (err) {
    console.error(`oauth callback: failed to set up renewal badges for tenant ${tenantId}`, err);
  }

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
  const matchingRules = (rules || []).filter((rule) =>
    rule.signal_type === "badge"
      ? Array.isArray(job.badges) && job.badges.includes(rule.servicem8_badge_uuid)
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

async function runNightlyReconciliation(env) {
  const { results: tenants } = await env.DB.prepare("SELECT * FROM tenants WHERE status = 'active'").all();
  for (const tenant of tenants || []) {
    const runId = randomId();
    const startedAt = Date.now();
    try {
      const { jobsScanned } = await recomputeAllCategoriesForTenant(env, tenant.servicem8_account_uuid);
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
}

// ---- ServiceM8 Add-on: job-card button -> standalone dashboard -----------
//
// Same job-card-action mechanism as tcb-customer-portal's "Approve Forms for
// Portal" (confirmed working against the real account -- see the "Addons"
// flyout menu on a job card), registered in addon-manifest.json under
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
// unresolved until its first addon-callback JWT arrives. Every retried
// install (e.g. "installation failed, please try again") creates another
// unresolved row via handleOAuthCallback -- rather than requiring exactly one
// to exist (which broke the very first time Phill retried install a few
// times), pick whichever unresolved active tenant has the most recently
// issued OAuth token as "the install ServiceM8 currently has authorized",
// and retire the older duplicates so they can never shadow it again. This is
// still a single-real-tenant simplification, not true multi-tenant
// disambiguation -- must be revisited before a second real tenant installs.
async function resolveTenantFromAccountUuid(env, accountUuid) {
  const byResolved = await env.DB.prepare("SELECT * FROM tenants WHERE resolved_account_uuid = ?").bind(accountUuid).first();
  if (byResolved) return byResolved;

  const { results: candidates } = await env.DB.prepare(
    `SELECT t.* FROM tenants t
     JOIN oauth_tokens o ON o.tenant_id = t.servicem8_account_uuid
     WHERE t.status = 'active' AND t.resolved_account_uuid IS NULL
     ORDER BY o.updated_at DESC`
  ).all();
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
  const dashboardUrl = `${origin}/dashboard?token=${encodeURIComponent(token)}`;
  return addonResponse(dashboardRedirectHtml(dashboardUrl));
}

function handleAddonPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function handleDashboard(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  const tenantId = await verifyDashboardToken(env.SERVICEM8_APP_SECRET, token);
  if (!tenantId) {
    return new Response(addonErrorHtml("This link has expired. Please reopen Renewal Autopilot from a job card in ServiceM8."), {
      status: 401,
      headers: { "Content-Type": "text/html" },
    });
  }
  const html = await renderDashboardHtml(env, tenantId, token);
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function handleDashboardApprove(request, env) {
  const { token, draftId } = await readJson(request);
  const tenantId = await verifyDashboardToken(env.SERVICEM8_APP_SECRET, token);
  if (!tenantId) return json({ error: "invalid or expired token" }, { status: 401 });
  if (!draftId) return json({ error: "draftId required" }, { status: 400 });

  try {
    await approveAndSendDraft(env, tenantId, draftId);
    return json({ ok: true });
  } catch (err) {
    console.error(`dashboard approve failed for tenant ${tenantId}, draft ${draftId}`, err);
    return json({ error: "could not send this reminder right now" }, { status: 502 });
  }
}

// ---- Phase 1 acceptance-test debug routes ---------------------------------
// Standing in for the Phase 2 setup wizard, which doesn't exist yet -- these
// let us configure category tracking and run the engine manually against
// TCB's real account to validate correctness before building any UI.
// Not gated by auth: acceptable only because the only tenant that exists
// right now is TCB's own test install; must be removed or auth-gated before
// a second real tenant or Partner Preview submission.

async function handleDebugCategories(request, env) {
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  try {
    const categories = await listCategories(env, tenantId);
    return json({ categories });
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
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  try {
    const result = await recomputeAllCategoriesForTenant(env, tenantId);
    return json(result);
  } catch (err) {
    return json({ error: String(err && err.message), stack: err && err.stack }, { status: 502 });
  }
}

// One-time cleanup: TCB's historical "Standard" category was a mixed bag of
// general pest visits (the true recurring yearly service) and one-off
// specialist jobs (fleas, bed bugs, rats, possums, termites) that were never
// properly recategorized. Reclassifying each by hand (per Phill's review of
// every job's description) so the due-detection engine tracking "Premium
// Pest Treatment" reflects only genuine recurring general-pest visits.
// Jobs with no good existing category (flea, subfloor timber, TPI, ants) are
// deliberately left untouched -- they stay in "Standard", which is no longer
// a tracked category, so they're correctly excluded either way.
const PREMIUM_PEST_UUID = "97af1d3c-07ac-4aae-8862-23184055ce5b";
const RODENT_UUID = "65374f33-5111-4411-976d-232fc24a43ab";
const BED_BUG_UUID = "a1abb6a4-1c94-4f65-9150-2354da1a8c8b";
const WILDLIFE_UUID = "82142727-ec9f-49e2-bd3b-231849b852eb";
const TERMITE_MGMT_UUID = "4b0df417-bd76-44a5-b9b9-231843331c3b";

const STANDARD_RECLASSIFY_MAP = {
  "fbcc98bb-215e-4327-b30f-23052003292d": PREMIUM_PEST_UUID, // 117 Clift Crescent -- general pest service
  "b55bfc35-2eaf-45ee-982a-23076a976c9d": PREMIUM_PEST_UUID, // 1/18 Breen Pl -- General Pest
  "da525b59-56fe-49cb-be26-232a2727444d": PREMIUM_PEST_UUID, // 1041 Harolds Cross Rd -- General pest treatment
  "b038f108-945d-4517-8508-235537fc0b0d": PREMIUM_PEST_UUID, // 4 Dalziel Street -- Gp-ants
  "278a2bcf-5b5f-44c0-832b-23529bed4c5b": PREMIUM_PEST_UUID, // 1617 Burra Rd -- General Pest
  "e1313900-2450-4052-8b7c-2344f5b9dded": PREMIUM_PEST_UUID, // 15 Boronia Crescent -- GP
  "8110911b-8a9c-43fd-b5d2-23aa3279874b": PREMIUM_PEST_UUID, // 55 Alberga St -- Full general pest
  "b04c1bbb-33c8-4c03-a83c-230769f4af1b": PREMIUM_PEST_UUID, // food court hyperdome -- Rodents, General Pest
  "f4f0ec36-1f5d-48eb-b4f9-230efd22bf9d": PREMIUM_PEST_UUID, // 8 Hayward Street -- lots of spiders
  "831f13c3-2f85-419f-9ac5-2303d49fa2cb": RODENT_UUID, // 27A Massey St -- Investigate rat infestation
  "79fcb3c9-26dd-449d-95bd-2354d445838b": RODENT_UUID, // 80 Dumas St -- rodent in the roof
  "2408460b-043d-4153-830a-2306fc9b942b": BED_BUG_UUID, // 120 Auburn Street Goulburn -- Bed bug inspection/treatment
  "17b32e9c-6e88-4528-b014-23176ed79dfb": WILDLIFE_UUID, // 9 O'Rourke Pl -- Possum fell down chimney
  "89a1a774-ce09-4a2e-92aa-23076f7ed4dd": TERMITE_MGMT_UUID, // 29 Redbox Place -- Termite inspection and Termidore recharge
};

async function handleDebugReclassifyStandard(request, env) {
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const results = [];
  for (const [jobUuid, categoryUuid] of Object.entries(STANDARD_RECLASSIFY_MAP)) {
    try {
      await updateJobCategory(env, tenantId, jobUuid, categoryUuid);
      results.push({ jobUuid, categoryUuid, ok: true });
    } catch (err) {
      results.push({ jobUuid, categoryUuid, ok: false, error: String(err && err.message) });
    }
  }
  return json({ results });
}

// One-time setup: fresh green-branded badges for Renewal Autopilot, distinct
// from TCB's existing "3/6 Month Follow-up"/"1 Year Follow-up" badges so as
// not to disturb whatever those are already used for. Only the 1-year one is
// wired into a tracking rule for now -- see /debug/configure-category.
async function handleDebugCreateBadges(request, env) {
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const origin = new URL(request.url).origin;
  const fileUrl = `${origin}/assets/images/badge-green-sprite.png`;
  const names = ["Renewal Autopilot - 3 Month", "Renewal Autopilot - 6 Month", "Renewal Autopilot - 1 Year"];
  const results = [];
  for (const name of names) {
    try {
      const uuid = await createBadge(env, tenantId, { name, fileUrl });
      results.push({ name, uuid, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: String(err && err.message) });
    }
  }
  return json({ results });
}

// One-time fix: the first sprite was square/dark-green; ServiceM8 appears to
// copy the image at creation time rather than proxying it live, so pointing
// existing badges at the same URL again wouldn't necessarily refresh what's
// shown -- update to the new versioned filename instead.
async function handleDebugUpdateBadgeIcons(request, env) {
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const origin = new URL(request.url).origin;
  const fileUrl = `${origin}/assets/images/badge-green-sprite-v2.png`;
  const names = ["Renewal Autopilot - 3 Month", "Renewal Autopilot - 6 Month", "Renewal Autopilot - 1 Year"];
  try {
    const badges = (await listBadges(env, tenantId)) || [];
    const results = [];
    for (const name of names) {
      const badge = badges.find((b) => b.name === name);
      if (!badge) {
        results.push({ name, ok: false, error: "badge not found" });
        continue;
      }
      try {
        await updateBadge(env, tenantId, badge.uuid, { fileUrl });
        results.push({ name, uuid: badge.uuid, ok: true });
      } catch (err) {
        results.push({ name, uuid: badge.uuid, ok: false, error: String(err && err.message) });
      }
    }
    return json({ results });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

async function handleDebugRaw(request, env) {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  const path = url.searchParams.get("path");
  if (!tenantId || !path) return json({ error: "?tenant= and ?path= required" }, { status: 400 });
  try {
    const data = await rawGet(env, tenantId, path);
    return json({ data });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

async function handleDebugSampleJobs(request, env) {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  const categoryUuid = url.searchParams.get("category");
  if (!tenantId || !categoryUuid) return json({ error: "?tenant= and ?category= required" }, { status: 400 });
  try {
    const jobs = await listCompletedJobsForCategory(env, tenantId, categoryUuid);
    const limit = Number(url.searchParams.get("limit")) || 8;
    const sample = (jobs || []).slice(0, limit).map((j) => ({
      uuid: j.uuid,
      job_address: j.job_address,
      job_description: j.job_description,
      completion_date: j.completion_date,
      company_uuid: j.company_uuid,
    }));
    return json({ total: (jobs || []).length, sample });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

async function handleDebugCategoryBreakdown(request, env) {
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  try {
    const [jobs, categories] = await Promise.all([listAllCompletedJobs(env, tenantId), listCategories(env, tenantId)]);
    const nameByUuid = {};
    for (const c of categories || []) nameByUuid[c.uuid] = c.name;
    const counts = {};
    for (const j of jobs || []) {
      const key = j.category_uuid ? nameByUuid[j.category_uuid] || j.category_uuid : "(no category)";
      counts[key] = (counts[key] || 0) + 1;
    }
    return json({ totalCompletedJobs: (jobs || []).length, counts });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

async function handleDebugOpenJobs(request, env) {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  const companyUuid = url.searchParams.get("company");
  if (!tenantId || !companyUuid) return json({ error: "?tenant= and ?company= required" }, { status: 400 });
  try {
    const jobs = await listOpenJobsForCompany(env, tenantId, companyUuid);
    return json({ jobs: (jobs || []).map((j) => ({ uuid: j.uuid, status: j.status, category_uuid: j.category_uuid, job_address: j.job_address, date: j.date })) });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

async function handleDebugContact(request, env) {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  const companyUuid = url.searchParams.get("company");
  if (!tenantId || !companyUuid) return json({ error: "?tenant= and ?company= required" }, { status: 400 });
  try {
    const contact = await getPrimaryContact(env, tenantId, companyUuid);
    return json({ contact });
  } catch (err) {
    return json({ error: String(err && err.message) }, { status: 502 });
  }
}

async function handleDebugDueCustomers(request, env) {
  const tenantId = new URL(request.url).searchParams.get("tenant");
  if (!tenantId) return json({ error: "?tenant= required" }, { status: 400 });
  const { results } = await env.DB.prepare(
    "SELECT * FROM due_customers WHERE tenant_id = ? ORDER BY bucket, last_completed_at"
  )
    .bind(tenantId)
    .all();
  return json({ dueCustomers: results || [] });
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

    if (pathname === "/debug/categories" && method === "GET") return handleDebugCategories(request, env);
    if (pathname === "/debug/configure-category" && method === "POST") return handleDebugConfigureCategory(request, env);
    if (pathname === "/debug/recompute" && method === "POST") return handleDebugRecompute(request, env);
    if (pathname === "/debug/due-customers" && method === "GET") return handleDebugDueCustomers(request, env);
    if (pathname === "/debug/contact" && method === "GET") return handleDebugContact(request, env);
    if (pathname === "/debug/category-breakdown" && method === "GET") return handleDebugCategoryBreakdown(request, env);
    if (pathname === "/debug/sample-jobs" && method === "GET") return handleDebugSampleJobs(request, env);
    if (pathname === "/debug/reclassify-standard" && method === "POST") return handleDebugReclassifyStandard(request, env);
    if (pathname === "/debug/raw" && method === "GET") return handleDebugRaw(request, env);
    if (pathname === "/debug/create-badges" && method === "POST") return handleDebugCreateBadges(request, env);
    if (pathname === "/debug/update-badge-icons" && method === "POST") return handleDebugUpdateBadgeIcons(request, env);
    if (pathname === "/debug/open-jobs" && method === "GET") return handleDebugOpenJobs(request, env);

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
