// Small shared helpers, same conventions as tcb-customer-portal/src/auth.js.

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toHex(arr);
}

// Constant-time-ish comparison, same as tcb-customer-portal/src/auth.js.
export function safeEqual(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ServiceM8's zero-date sentinel ("0000-00-00 00:00:00") -- confirmed in
// both tcbpestcontriol/src/servicem8.js and tcb-customer-portal's
// invoice_date handling. Returns a Date or null.
export function parseServiceM8Date(s) {
  if (!s || s.startsWith("0000-00-00")) return null;
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d) ? null : d;
}

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
