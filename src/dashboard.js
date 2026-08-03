// The staff-facing standalone dashboard: the color-coded due/overdue queue,
// same visual pattern as the one-off yearly_spray_due.html built earlier for
// TCB directly, now served live from this Worker and reachable via the
// job-card Add-on button (src/addon.js) instead of being a static file.

import { escapeHtml, randomId } from "./util.js";
import { sendPlatformSms, sendPlatformEmail, listCategories } from "./servicem8-api.js";

// Per-status palette. `accent` drives the row's left rail + phone link,
// `bg` the row surface, `pillBg`/`pillFg` the status pill. Semantic hues:
// red=overdue, orange=due now, amber=due soon, blue=due later, green=done.
const STYLE = {
  overdue: { accent: "#dc2626", bg: "#fef4f4", pillBg: "#fee2e2", pillFg: "#991b1b", label: "Overdue" },
  due: { accent: "#ea580c", bg: "#fff8f2", pillBg: "#ffedd5", pillFg: "#9a3412", label: "Due now" },
  due_soon: { accent: "#d97706", bg: "#fffcf3", pillBg: "#fef3c7", pillFg: "#92400e", label: "Due soon" },
  due_later: { accent: "#2563eb", bg: "#f4f8ff", pillBg: "#dbeafe", pillFg: "#1e40af", label: "Due later" },
  contacted: { accent: "#16a34a", bg: "#f4fdf6", pillBg: "#dcfce7", pillFg: "#166534", label: "Contacted" },
};

function telHref(p) {
  return "tel:" + String(p || "").replace(/[^0-9+]/g, "");
}

// Inline (self-contained, CSP-safe) Feather-style icons -- currentColor so
// they inherit the surrounding text colour.
const IC_PHONE = `<svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
const IC_CAL = `<svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const IC_SEND = `<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

// ServiceM8 timestamps are "YYYY-MM-DD HH:MM:SS" -- staff just want the date
// here (AU format), not the time-of-day the job happened to be closed out.
function formatDateOnly(s) {
  const datePart = String(s || "").split(" ")[0];
  const [y, m, d] = datePart.split("-");
  return y && m && d ? `${d}/${m}/${y}` : datePart;
}

export async function renderDashboardHtml(env, tenantId, token) {
  const { results: dueCustomers } = await env.DB.prepare(
    `SELECT * FROM due_customers WHERE tenant_id = ? AND suppressed_reason IS NULL AND dismissed_at IS NULL ORDER BY bucket, last_completed_at`
  )
    .bind(tenantId)
    .all();

  // Service name shown per row is the *actual job's* real category (e.g.
  // "Premium Pest Treatment"), not the tracking rule's own label -- a
  // badge-based rule's label is just "1 Year Follow-up", which doesn't tell
  // staff what kind of service it was. Live lookup rather than a stored
  // column since categories can be renamed in ServiceM8 at any time.
  let categoryNameByUuid = {};
  try {
    const categories = await listCategories(env, tenantId);
    for (const c of categories || []) categoryNameByUuid[c.uuid] = c.name;
  } catch (err) {
    console.error(`dashboard: failed to load categories for tenant ${tenantId}`, err);
  }
  for (const r of dueCustomers || []) {
    r.service_name = categoryNameByUuid[r.servicem8_category_uuid] || "Unknown";
  }

  const draftsByCustomer = {};
  if (dueCustomers && dueCustomers.length) {
    const { results: drafts } = await env.DB.prepare(
      `SELECT * FROM reminder_drafts WHERE tenant_id = ? ORDER BY created_at DESC`
    )
      .bind(tenantId)
      .all();
    for (const d of drafts || []) (draftsByCustomer[d.due_customer_id] ||= []).push(d);
  }

  const allRowsData = (dueCustomers || [])
    .map((r) => {
      const drafts = draftsByCustomer[r.id] || [];
      const smsDraft = drafts.find((d) => d.channel === "sms");
      const emailDraft = drafts.find((d) => d.channel === "email");
      const pendingChannels = [
        smsDraft && smsDraft.status === "pending" ? "sms" : null,
        emailDraft && emailDraft.status === "pending" ? "email" : null,
      ].filter(Boolean);
      const sentChannels = [smsDraft, emailDraft].filter((d) => d && d.status === "sent");

      let draftHtml;
      if (!drafts.length) {
        draftHtml = `<div class="draft-none">No draft yet</div>`;
      } else if (!pendingChannels.length) {
        // Both channels already actioned -- just show what was sent.
        draftHtml = sentChannels.length
          ? `<div class="sent-row">${sentChannels.map((d) => `<span class="sent-chip">&#10003; ${escapeHtml(d.channel.toUpperCase())} sent</span>`).join("")}</div>`
          : `<div class="draft-none">No pending draft</div>`;
      } else {
        // One dropdown to pick the channel, one textarea/button that follows
        // whichever channel is currently selected -- not two separate boxes.
        const byChannel = { sms: smsDraft, email: emailDraft };
        const options = pendingChannels
          .map((ch) => `<option value="${ch}">${ch.toUpperCase()}</option>`)
          .join("");
        const sentNote = sentChannels.length
          ? `<div class="sent-row">${sentChannels.map((d) => `<span class="sent-chip">&#10003; ${escapeHtml(d.channel.toUpperCase())} already sent</span>`).join("")}</div>`
          : "";
        const bodyAttrs = pendingChannels
          .map((ch) => `data-body-${ch}="${escapeHtml(byChannel[ch].draft_body)}" data-draft-${ch}="${escapeHtml(byChannel[ch].id)}"`)
          .join(" ");

        draftHtml = `<div class="draft-card" data-row="${escapeHtml(r.id)}" ${bodyAttrs}>
          <div class="draft-head">
            <select class="channel-select">${options}</select>
            <span class="draft-hint">edit before sending if needed</span>
          </div>
          <textarea class="draft-textarea">${escapeHtml(byChannel[pendingChannels[0]].draft_body)}</textarea>
          <button class="approve-btn">${IC_SEND}<span>Approve &amp; Send</span></button>
          ${sentNote}
        </div>`;
      }

      // A customer with drafts but none left pending has been fully actioned
      // for their current round -- they move OUT of their urgency bucket
      // (Overdue/Due now/etc) into a "Contacted N" tab, where N = how many
      // rounds have actually been sent (reminder_round - 1). When the nightly
      // cron later auto-generates their next round's drafts (see
      // src/due-engine.js's generateFollowUpDraftsForTenant), those drafts are
      // pending again, so they automatically move BACK into their urgency
      // bucket to be actioned -- then to Contacted N+1 once sent, and so on.
      const alreadyContacted = drafts.length > 0 && !pendingChannels.length;
      const contactedRound = Math.min(Math.max((r.reminder_round || 1) - 1, 1), 3);
      const tabBucket = alreadyContacted ? `contacted${contactedRound}` : r.bucket;
      const s = alreadyContacted ? STYLE.contacted : STYLE[r.bucket] || STYLE.due_soon;
      const statusLabel = alreadyContacted ? `Contacted ${contactedRound}` : s.label;

      const html = `<tr class="job-row" data-service="${escapeHtml(r.service_name)}" data-row-id="${escapeHtml(r.id)}" data-bucket="${escapeHtml(tabBucket)}" style="--accent:${s.accent};--rowbg:${s.bg};">
        <td class="c-status"><span class="pill" style="background:${s.pillBg};color:${s.pillFg};"><i class="dot" style="background:${s.accent};"></i>${escapeHtml(statusLabel)}</span></td>
        <td class="c-customer">
          <div class="cust-name">${escapeHtml(r.contact_name_cache || "Unknown")}</div>
          ${r.address_display ? `<div class="cust-addr">${escapeHtml(r.address_display)}</div>` : ""}
          ${r.contact_phone_cache ? `<a href="${telHref(r.contact_phone_cache)}" class="cust-phone">${IC_PHONE}${escapeHtml(r.contact_phone_cache)}</a>` : ""}
          ${draftHtml}
        </td>
        <td class="c-service"><span class="svc-tag">${escapeHtml(r.service_name || "Unknown")}</span></td>
        <td class="c-date">
          <span class="date-val">${IC_CAL}${escapeHtml(formatDateOnly(r.last_completed_at))}</span>
          ${
            r.last_job_notes_cache
              ? `<details class="job-notes">
            <summary>Show job</summary>
            <div class="job-notes-body">${escapeHtml(r.last_job_notes_cache)}</div>
          </details>`
              : ""
          }
        </td>
        <td class="c-actions">
          <button data-dismiss="${escapeHtml(r.id)}" class="dismiss-btn" title="Remove from this list" aria-label="Remove">&times;</button>
        </td>
      </tr>`;
      return { html, tabBucket };
    });

  // Counts per tab, derived from each row's assigned tabBucket -- one source
  // of truth so the tab labels and the actual filtered rows can never drift.
  const counts = { overdue: 0, due: 0, due_soon: 0, due_later: 0, contacted1: 0, contacted2: 0, contacted3: 0 };
  allRowsData.forEach((r) => (counts[r.tabBucket] = (counts[r.tabBucket] || 0) + 1));

  const rows = allRowsData.map((r) => r.html).join("\n");

  // Default-active tab is always one of the four urgency buckets (the
  // Contacted stages live in a dropdown, not the tab strip, so they never
  // start selected) -- first non-empty in urgency order, else Overdue.
  const defaultBucket = ["overdue", "due", "due_soon", "due_later"].find((b) => counts[b] > 0) || "overdue";
  const actionableCount = counts.overdue + counts.due + counts.due_soon + counts.due_later;

  const serviceNames = [...new Set((dueCustomers || []).map((r) => r.service_name))].sort();
  const filterOptions = serviceNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Renewal Autopilot</title>
<style>
  :root {
    --bg: #f4f5f7; --surface: #ffffff; --ink: #0f172a; --ink-2: #334155; --muted: #64748b; --faint: #94a3b8;
    --line: #eceef1; --line-2: #e2e5ea; --brand: #16a34a; --brand-600: #15803d; --brand-ink: #166534;
    --sh-sm: 0 1px 2px rgba(15,23,42,.05); --sh-md: 0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.04);
    --sh-lg: 0 4px 12px rgba(15,23,42,.07), 0 2px 4px rgba(15,23,42,.04);
  }
  * { box-sizing: border-box; }
  body { font-family: "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  .ic { vertical-align: -1px; flex: none; }

  /* top app bar */
  .topbar { position: sticky; top: 0; z-index: 20; background: rgba(255,255,255,.85); backdrop-filter: saturate(1.6) blur(8px); border-bottom: 1px solid var(--line-2); }
  .topbar-in { max-width: 1080px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 13px; }
  .logo { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(145deg, #34d399, #15803d); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 19px; box-shadow: 0 2px 6px rgba(21,128,61,.35); flex: none; }
  .brand-txt h1 { font-size: 16px; font-weight: 700; margin: 0; letter-spacing: -.012em; line-height: 1.1; }
  .brand-txt .tag { font-size: 11.5px; color: var(--muted); font-weight: 500; }
  .topbar-count { margin-left: auto; font-size: 12.5px; color: var(--muted); font-weight: 500; background: var(--surface); border: 1px solid var(--line-2); border-radius: 999px; padding: 5px 12px; box-shadow: var(--sh-sm); }
  .topbar-count b { color: var(--ink); font-weight: 700; }

  .wrap { max-width: 1080px; margin: 0 auto; padding: 22px 24px 56px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 16px; font-weight: 500; }

  /* nav row */
  .nav { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .tabs { display: inline-flex; align-items: center; gap: 3px; background: #eceef2; padding: 4px; border-radius: 11px; }
  .tab-btn { background: none; border: none; padding: 7px 13px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; border-radius: 8px; transition: all .14s ease; display: inline-flex; align-items: center; gap: 6px; }
  .tab-btn:hover { color: var(--ink-2); }
  .tab-btn .n { font-size: 11px; font-weight: 700; color: var(--faint); background: rgba(15,23,42,.06); border-radius: 999px; padding: 1px 6px; min-width: 18px; text-align: center; transition: all .14s; }
  .tab-btn.active { background: var(--surface); color: var(--ink); box-shadow: var(--sh-md); }
  .tab-btn.active .n { color: #fff; background: var(--ink); }
  .contacted-dd { align-self: center; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--line-2); font-size: 13px; font-weight: 600; color: var(--muted); background: var(--surface); cursor: pointer; box-shadow: var(--sh-sm); transition: all .14s; }
  .contacted-dd:hover { border-color: #cbd5e1; color: var(--ink-2); }
  .contacted-dd.active { color: var(--brand-ink); border-color: var(--brand); background: #f0fdf4; box-shadow: 0 0 0 3px rgba(22,163,74,.1); }
  .filter { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .filter label { font-size: 12.5px; color: var(--muted); font-weight: 500; }
  #service-filter { padding: 8px 12px; border-radius: 10px; border: 1px solid var(--line-2); font-size: 13px; font-weight: 500; color: var(--ink-2); background: var(--surface); box-shadow: var(--sh-sm); cursor: pointer; }
  #service-filter:hover { border-color: #cbd5e1; }

  /* table */
  .table-wrap { overflow-x: auto; }
  table { border-collapse: separate; border-spacing: 0 9px; width: 100%; min-width: 660px; }
  thead th { text-align: left; padding: 0 16px 2px; color: var(--faint); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  thead th:last-child { width: 48px; }

  .job-row td { background: var(--surface); vertical-align: top; padding: 14px 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); transition: box-shadow .15s ease, transform .15s ease; }
  .job-row td:first-child { position: relative; border-left: 1px solid var(--line); border-radius: 12px 0 0 12px; padding-left: 20px; }
  .job-row td:first-child::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 999px; background: var(--accent); }
  .job-row td:last-child { border-right: 1px solid var(--line); border-radius: 0 12px 12px 0; }
  .job-row:hover td { box-shadow: var(--sh-lg); border-color: var(--line-2); }
  .job-row:hover td:first-child { border-left-color: var(--line-2); }

  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px 4px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .02em; white-space: nowrap; text-transform: uppercase; }
  .pill .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .cust-name { font-weight: 650; font-size: 14px; letter-spacing: -.005em; }
  .cust-addr { font-size: 12px; color: var(--muted); margin-top: 2px; white-space: pre-line; line-height: 1.4; }
  .cust-phone { display: inline-flex; align-items: center; gap: 5px; margin-top: 5px; font-size: 12.5px; font-weight: 600; color: var(--accent); text-decoration: none; }
  .cust-phone:hover { text-decoration: underline; }
  .svc-tag { display: inline-block; font-size: 12px; font-weight: 600; color: var(--ink-2); background: #f1f5f9; border: 1px solid var(--line-2); border-radius: 7px; padding: 3px 9px; }
  .c-date { white-space: nowrap; }
  .date-val { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 550; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .date-val .ic { color: var(--faint); }
  .job-notes { margin-top: 6px; }
  .job-notes summary { cursor: pointer; font-size: 11px; font-weight: 600; color: var(--muted); list-style: none; user-select: none; display: inline-flex; align-items: center; gap: 3px; }
  .job-notes summary:hover { color: var(--ink-2); }
  .job-notes summary::-webkit-details-marker { display: none; }
  .job-notes summary::before { content: "\\25B8"; font-size: 8px; }
  .job-notes[open] summary::before { content: "\\25BE"; }
  .job-notes-body { font-size: 12px; color: var(--ink-2); margin-top: 6px; max-width: 240px; white-space: pre-line; line-height: 1.45; background: #f8fafc; border: 1px solid var(--line-2); border-radius: 8px; padding: 8px 10px; }

  /* draft composer */
  .draft-none { margin-top: 8px; font-size: 12px; color: var(--faint); font-style: italic; }
  .sent-row { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .sent-chip { font-size: 11px; font-weight: 700; color: var(--brand-ink); background: #dcfce7; border: 1px solid #bbf7d0; border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; }
  .draft-card { margin-top: 10px; padding: 11px; background: #fbfcfd; border: 1px solid var(--line-2); border-radius: 11px; max-width: 470px; }
  .draft-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .channel-select { font-size: 11.5px; font-weight: 700; letter-spacing: .03em; padding: 5px 9px; border-radius: 8px; border: 1px solid var(--line-2); background: #fff; color: var(--ink-2); cursor: pointer; }
  .draft-hint { font-size: 11.5px; color: var(--faint); }
  .draft-textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 1.5; padding: 10px 11px; border: 1px solid var(--line-2); border-radius: 9px; resize: vertical; min-height: 5.2em; margin-bottom: 9px; color: var(--ink); background: #fff; transition: border-color .12s, box-shadow .12s; }
  .draft-textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(22,163,74,.13); }
  .approve-btn { display: inline-flex; align-items: center; gap: 7px; background: var(--brand); color: #fff; border: none; border-radius: 9px; padding: 9px 16px; font-size: 12.5px; font-weight: 650; cursor: pointer; box-shadow: 0 1px 2px rgba(21,128,61,.35); transition: background .13s, transform .06s; }
  .approve-btn:hover:not(:disabled) { background: var(--brand-600); }
  .approve-btn:active:not(:disabled) { transform: translateY(1px); }
  .approve-btn:disabled { opacity: .6; cursor: default; box-shadow: none; }

  .dismiss-btn { background: none; border: 1px solid var(--line-2); border-radius: 8px; width: 30px; height: 30px; line-height: 1; font-size: 17px; color: var(--faint); cursor: pointer; transition: all .13s; }
  .dismiss-btn:hover { background: #fef2f2; border-color: #fecaca; color: #dc2626; }

  .empty-state, #empty-filtered { padding: 52px 24px; text-align: center; color: var(--muted); background: var(--surface); border: 1px solid var(--line-2); border-radius: 14px; font-size: 14px; line-height: 1.6; box-shadow: var(--sh-sm); max-width: 520px; margin: 0 auto; }
  #empty-filtered { display: none; margin-top: 9px; }

  @media (max-width: 620px) {
    .topbar-in, .wrap { padding-left: 14px; padding-right: 14px; }
    .filter { margin-left: 0; width: 100%; }
    #service-filter { flex: 1; }
    .topbar-count { display: none; }
  }
</style>
</head>
<body>
<div class="topbar"><div class="topbar-in">
  <div class="logo">&#8635;</div>
  <div class="brand-txt"><h1>Renewal Autopilot</h1><div class="tag">Renewal reminder queue</div></div>
  <div class="topbar-count"><b>${(dueCustomers || []).length}</b> tracked</div>
</div></div>
<div class="wrap">
<div class="sub" id="sub-count">${actionableCount} customer${actionableCount === 1 ? "" : "s"} due for renewal</div>
<div class="nav">
  <div class="tabs">
    <button class="tab-btn${defaultBucket === "overdue" ? " active" : ""}" data-tab-bucket="overdue">Overdue <span class="n">${counts.overdue}</span></button>
    <button class="tab-btn${defaultBucket === "due" ? " active" : ""}" data-tab-bucket="due">Due now <span class="n">${counts.due}</span></button>
    <button class="tab-btn${defaultBucket === "due_soon" ? " active" : ""}" data-tab-bucket="due_soon">Due soon <span class="n">${counts.due_soon}</span></button>
    <button class="tab-btn${defaultBucket === "due_later" ? " active" : ""}" data-tab-bucket="due_later">Due later <span class="n">${counts.due_later}</span></button>
  </div>
  <select id="contacted-select" class="contacted-dd" aria-label="View contacted customers">
    <option value="">Contacted &#9662;</option>
    <option value="contacted1">Contacted 1 (${counts.contacted1})</option>
    <option value="contacted2">Contacted 2 (${counts.contacted2})</option>
    <option value="contacted3">Contacted 3 (${counts.contacted3})</option>
  </select>
  <div class="filter">
    <label for="service-filter">Service</label>
    <select id="service-filter">
      <option value="">All services (${(dueCustomers || []).length})</option>
      ${filterOptions}
    </select>
  </div>
</div>
${
  rows
    ? `<div class="table-wrap"><table id="due-table">
<thead><tr><th>Status</th><th>Customer</th><th>Service</th><th>Last service</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<div id="empty-filtered">No customers in this view for that service.</div>`
    : `<div class="empty-state">Nothing due yet &mdash; once jobs carrying a renewal badge are completed, customers due for their next service will appear here.</div>`
}

<script>
  var filterSelect = document.getElementById('service-filter');
  var allRows = Array.prototype.slice.call(document.querySelectorAll('#due-table tbody tr[data-service]'));
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  var activeBucket = (tabBtns.find(function (b) { return b.classList.contains('active'); }) || {}).dataset;
  activeBucket = activeBucket ? activeBucket.tabBucket : 'overdue';

  var emptyFiltered = document.getElementById('empty-filtered');

  function applyFilters() {
    var serviceValue = filterSelect.value;
    var visibleCount = 0;
    allRows.forEach(function (row) {
      var match = row.dataset.bucket === activeBucket && (!serviceValue || row.dataset.service === serviceValue);
      row.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    });
    var noun = activeBucket.indexOf('contacted') === 0 ? (visibleCount === 1 ? ' customer already contacted' : ' customers already contacted') : (visibleCount === 1 ? ' customer due for renewal' : ' customers due for renewal');
    document.getElementById('sub-count').textContent = visibleCount + noun + (serviceValue ? ' \\u2014 ' + serviceValue : '');
    if (emptyFiltered) emptyFiltered.style.display = (allRows.length && visibleCount === 0) ? 'block' : 'none';
  }

  var contactedSelect = document.getElementById('contacted-select');

  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      contactedSelect.value = '';
      contactedSelect.classList.remove('active');
      activeBucket = btn.dataset.tabBucket;
      applyFilters();
    });
  });

  // The Contacted stages live in this dropdown rather than as their own tabs.
  // Picking one deselects the urgency tabs and filters to that stage; the
  // dropdown itself lights up so it's clear it -- not a tab -- is the active view.
  contactedSelect.addEventListener('change', function () {
    if (!contactedSelect.value) return;
    tabBtns.forEach(function (b) { b.classList.remove('active'); });
    contactedSelect.classList.add('active');
    activeBucket = contactedSelect.value;
    applyFilters();
  });

  filterSelect.addEventListener('change', applyFilters);
  applyFilters();

  document.querySelectorAll('.draft-card').forEach(function (card) {
    var select = card.querySelector('.channel-select');
    var textarea = card.querySelector('.draft-textarea');
    var editedByChannel = {};

    function loadChannel(ch) {
      textarea.value = editedByChannel[ch] !== undefined ? editedByChannel[ch] : (card.dataset['body' + ch.charAt(0).toUpperCase() + ch.slice(1)] || '');
    }
    select.addEventListener('change', function () {
      loadChannel(select.value);
    });
    textarea.addEventListener('input', function () {
      editedByChannel[select.value] = textarea.value;
    });

    var btn = card.querySelector('.approve-btn');
    btn.addEventListener('click', async function () {
      var ch = select.value;
      var draftId = card.dataset['draft' + ch.charAt(0).toUpperCase() + ch.slice(1)];
      btn.disabled = true;
      select.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const res = await fetch('/dashboard/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(token)}, draftId: draftId, editedBody: textarea.value }),
        });
        if (res.ok) { location.reload(); } else { btn.textContent = 'Failed -- retry'; btn.disabled = false; select.disabled = false; }
      } catch (e) { btn.textContent = 'Failed -- retry'; btn.disabled = false; select.disabled = false; }
    });
  });

  document.querySelectorAll('.dismiss-btn').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var rowId = btn.dataset.dismiss;
      btn.disabled = true;
      try {
        const res = await fetch('/dashboard/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(token)}, dueCustomerId: rowId }),
        });
        if (res.ok) {
          var row = document.querySelector('tr[data-row-id="' + rowId + '"]');
          if (row) row.remove();
          allRows = allRows.filter(function (r) { return r.dataset.rowId !== rowId; });
          applyFilters();
        } else {
          btn.disabled = false;
        }
      } catch (e) { btn.disabled = false; }
    });
  });
</script>
</div>
</body></html>`;
}

// Hides a due_customers row from the dashboard for the current cycle -- not
// a permanent delete. The engine's upsert (src/due-engine.js) clears
// dismissed_at automatically once last_completed_at moves forward (a new
// job happened, meaning a fresh cycle), so a dismissed customer reappears
// naturally next time they're actually due again, rather than being lost.
export async function dismissDueCustomer(env, tenantId, dueCustomerId) {
  await env.DB.prepare("UPDATE due_customers SET dismissed_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(Date.now(), dueCustomerId, tenantId)
    .run();
}

// Advances due_customers.reminder_round past whichever round was just sent
// (round 1 sent -> round 2 next, etc) and records when, so the follow-up
// generator (src/due-engine.js) knows this customer is mid-sequence. The
// CASE guard means re-sending an old round (shouldn't normally happen) never
// regresses a round that's already moved further along.
async function advanceReminderRound(env, dueCustomerId, sentRound) {
  const nextRound = sentRound + 1;
  await env.DB.prepare(
    `UPDATE due_customers SET reminder_round = CASE WHEN ? > reminder_round THEN ? ELSE reminder_round END, last_reminder_sent_at = ? WHERE id = ?`
  )
    .bind(nextRound, nextRound, Date.now(), dueCustomerId)
    .run();
}

// editedBody: staff can revise the draft text in the dashboard textarea
// before sending -- when present (and non-empty after trimming) it's what
// actually gets sent, and it's persisted onto the draft row so the record
// reflects what really went out, not the original auto-generated wording.
export async function approveAndSendDraft(env, tenantId, draftId, editedBody) {
  const draft = await env.DB.prepare("SELECT * FROM reminder_drafts WHERE id = ? AND tenant_id = ?").bind(draftId, tenantId).first();
  if (!draft) throw new Error("draft not found for this tenant");
  if (draft.status !== "pending") return; // already actioned -- idempotent

  const dueCustomer = await env.DB.prepare("SELECT * FROM due_customers WHERE id = ?").bind(draft.due_customer_id).first();
  const body = typeof editedBody === "string" && editedBody.trim() ? editedBody : draft.draft_body;

  // regardingJobUuid kept (needed so the customer's reply threads back into
  // that job in ServiceM8, and for the "reply here" link ServiceM8 appends
  // to the SMS footer). ServiceM8 can reject a send as a duplicate
  // ("SMS Message has already been sent (Not sending again)", errorCode 405)
  // when it considers this an exact repeat -- treated as a soft-success
  // below rather than a hard failure, since it means the message already
  // went out functionally; don't leave a draft stuck as "failed" (and
  // re-sendable) for something the customer already received.
  try {
    if (draft.channel === "sms") {
      await sendPlatformSms(env, tenantId, {
        to: dueCustomer.contact_phone_cache,
        message: body,
        regardingJobUuid: dueCustomer.last_job_uuid,
      });
    } else {
      await sendPlatformEmail(env, tenantId, {
        to: dueCustomer.contact_email_cache,
        subject: draft.draft_subject || "Time for your next pest treatment",
        textBody: body,
        regardingJobUuid: dueCustomer.last_job_uuid,
      });
    }
    await env.DB.prepare("UPDATE reminder_drafts SET status = 'sent', draft_body = ?, sent_at = ?, reviewed_at = ? WHERE id = ?")
      .bind(body, Date.now(), Date.now(), draftId)
      .run();
    await advanceReminderRound(env, draft.due_customer_id, draft.round);
  } catch (err) {
    const message = String(err && err.message);
    if (message.includes("has already been sent")) {
      await env.DB.prepare("UPDATE reminder_drafts SET status = 'sent', draft_body = ?, sent_at = ?, reviewed_at = ? WHERE id = ?")
        .bind(body, Date.now(), Date.now(), draftId)
        .run();
      await advanceReminderRound(env, draft.due_customer_id, draft.round);
      return;
    }
    await env.DB.prepare("UPDATE reminder_drafts SET status = 'failed', draft_body = ?, error = ?, reviewed_at = ? WHERE id = ?")
      .bind(body, message, Date.now(), draftId)
      .run();
    throw err;
  }
}
