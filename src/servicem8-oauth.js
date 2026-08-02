// ServiceM8 OAuth2: install-time token exchange + per-call token refresh.
//
// Endpoints and grant params confirmed against tcb-customer-portal's real,
// working "Approve Forms for Portal" add-on activation handshake
// (src/index.js's handleAddonActivate/handleAddonOAuthCallback) -- that add-on
// discards the resulting token because it already has a private API key for
// TCB's own account. We can't do that here: this add-on has no standing
// relationship with an installing business, so the per-tenant access/refresh
// token pair IS the only credential we have for every ServiceM8 API call
// made on that tenant's behalf.

const AUTHORIZE_URL = "https://go.servicem8.com/oauth/authorize";
const TOKEN_URL = "https://go.servicem8.com/oauth/access_token";

// Space-separated scopes -- exact literal names need confirming against the
// live Developer Portal scope picker when the App is registered (flagged in
// the plan as an open item; these are the best-documented candidates).
export const OAUTH_SCOPES = "read_jobs read_customers publish_sms publish_email";

export function buildAuthorizeUrl({ appId, redirectUri, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(env, body) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SERVICEM8_APP_ID,
      client_secret: env.SERVICEM8_APP_SECRET,
      ...body,
    }),
  });
  if (!res.ok) {
    throw new Error(`ServiceM8 OAuth token request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// { access_token, refresh_token, expires_in } -- expires_in confirmed ~1hr
// per developer docs; refresh_token rotates on every use (see refreshToken
// below), so the very first token set must be persisted in full too.
export async function exchangeCodeForTokens(env, { code, redirectUri }) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

async function refreshTokens(env, refreshToken) {
  return tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

// Persists a fresh token set for a tenant. `tenantId` here is whatever key
// the caller currently has for the tenants row -- see the provisional-row
// handling in src/index.js's OAuth callback for why this isn't always the
// real accountUUID yet at install time.
export async function storeTokens(db, tenantId, tokens) {
  const now = Date.now();
  const expiresAt = now + tokens.expires_in * 1000;
  await db
    .prepare(
      `INSERT INTO oauth_tokens (tenant_id, access_token, refresh_token, access_token_expires_at, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         access_token_expires_at = excluded.access_token_expires_at,
         scope = excluded.scope,
         updated_at = excluded.updated_at`
    )
    .bind(tenantId, tokens.access_token, tokens.refresh_token, expiresAt, tokens.scope || OAUTH_SCOPES, now)
    .run();
}

const REFRESH_SKEW_MS = 60_000; // refresh if expiring within the next 60s

// Returns a valid access token for `tenantId`, refreshing first if needed.
// Refresh tokens rotate on every use, and a webhook delivery + the cron
// sweep can both want to refresh around the same time -- the conditional
// UPDATE below is an optimistic lock so only one caller actually performs
// the refresh; the other re-reads whatever the winner just wrote.
export async function getValidAccessToken(env, tenantId) {
  const row = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE tenant_id = ?").bind(tenantId).first();
  if (!row) throw new Error(`No OAuth tokens on file for tenant ${tenantId}`);

  if (row.access_token_expires_at > Date.now() + REFRESH_SKEW_MS) {
    return row.access_token;
  }

  let fresh;
  try {
    fresh = await refreshTokens(env, row.refresh_token);
  } catch (err) {
    // A refresh_token that's already been used/rotated by a concurrent
    // caller, or genuinely revoked (uninstall), both surface as a token
    // request failure here. Re-read first -- a concurrent refresh may have
    // already succeeded and left us a still-valid token.
    const now = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE tenant_id = ?").bind(tenantId).first();
    if (now && now.access_token_expires_at > Date.now()) return now.access_token;
    throw err;
  }

  const now = Date.now();
  const expiresAt = now + fresh.expires_in * 1000;
  const result = await env.DB.prepare(
    `UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND access_token_expires_at = ?`
  )
    .bind(fresh.access_token, fresh.refresh_token, expiresAt, now, tenantId, row.access_token_expires_at)
    .run();

  if (result.meta.changes > 0) return fresh.access_token;

  // Someone else's refresh landed first (WHERE clause matched nothing because
  // access_token_expires_at had already moved) -- their new token is correct
  // to use; ours would be a wasted/discarded rotation if we tried to write it.
  const winner = await env.DB.prepare("SELECT access_token FROM oauth_tokens WHERE tenant_id = ?").bind(tenantId).first();
  return winner.access_token;
}
