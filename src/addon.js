// ServiceM8 Add-on: job-card button that opens the Renewal Autopilot queue as
// a standalone page (not an embedded iframe UI) -- same job-card-action
// trigger mechanism as tcb-customer-portal's "Approve Forms for Portal"
// (confirmed working, screenshot-verified against the real account), but
// instead of rendering a form inline, the modal callback immediately hands
// off to a full standalone dashboard page in a new tab.
//
// Same two-token-scheme reasoning as tcb-customer-portal/src/addon.js:
//   1. verifyAddonJwt -- verifies the JWT ServiceM8 sends to the job-card
//      callback, signed with the Add-on's App Secret.
//   2. createDashboardToken/verifyDashboardToken -- a short-lived token *we*
//      mint, embedded in the redirect URL, so the standalone page can
//      authenticate the tenant without a full login/password system.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function safeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function safeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Payload shape confirmed by tcb-customer-portal against real deliveries:
// { eventVersion, eventName, auth: { accountUUID, staffUUID, accessToken,
// accessTokenExpiry }, eventArgs: { jobUUID } }.
export async function verifyAddonJwt(secret, jwt) {
  if (!jwt || typeof jwt !== "string") return null;
  const parts = jwt.trim().split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header;
  try {
    header = JSON.parse(dec.decode(base64urlToBytes(headerB64)));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const expectedSig = await hmacSha256(secret, `${headerB64}.${payloadB64}`);
  let actualSig;
  try {
    actualSig = base64urlToBytes(sigB64);
  } catch {
    return null;
  }
  if (!safeEqualBytes(expectedSig, actualSig)) return null;

  try {
    return JSON.parse(dec.decode(base64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
}

const DASHBOARD_TOKEN_TTL_MS = 1000 * 60 * 45; // 45 minutes -- long enough to review/approve a queue

export async function createDashboardToken(secret, tenantId) {
  const expiry = Date.now() + DASHBOARD_TOKEN_TTL_MS;
  const sig = toHex(await hmacSha256(secret, `${tenantId}.${expiry}`));
  return `${tenantId}.${expiry}.${sig}`;
}

// Returns the tenant id the token was issued for, or null if invalid/expired.
export async function verifyDashboardToken(secret, token) {
  if (!token) return null;
  const [tenantId, expiryStr, sig] = String(token).split(".");
  const expiry = Number(expiryStr);
  if (!tenantId || !expiry || !sig || expiry < Date.now()) return null;
  const expected = toHex(await hmacSha256(secret, `${tenantId}.${expiryStr}`));
  return safeEqualHex(sig, expected) ? tenantId : null;
}
