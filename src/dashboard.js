// The staff-facing standalone dashboard: the color-coded due/overdue queue,
// same visual pattern as the one-off yearly_spray_due.html built earlier for
// TCB directly, now served live from this Worker and reachable via the
// job-card Add-on button (src/addon.js) instead of being a static file.

import { escapeHtml, randomId } from "./util.js";
import { sendPlatformSms, sendPlatformEmail } from "./servicem8-api.js";

const STYLE = {
  overdue: { bg: "#fde2e1", border: "#c41613", label: "Overdue", text: "#7a0e0c" },
  due: { bg: "#ffe9d6", border: "#c2660a", label: "Due now", text: "#7a3d05" },
  due_soon: { bg: "#fff6d6", border: "#a68b00", label: "Due soon", text: "#6b5900" },
};

function telHref(p) {
  return "tel:" + String(p || "").replace(/[^0-9+]/g, "");
}

export async function renderDashboardHtml(env, tenantId, token) {
  const { results: dueCustomers } = await env.DB.prepare(
    `SELECT * FROM due_customers WHERE tenant_id = ? AND suppressed_reason IS NULL ORDER BY bucket, last_completed_at`
  )
    .bind(tenantId)
    .all();

  const draftsByCustomer = {};
  if (dueCustomers && dueCustomers.length) {
    const { results: drafts } = await env.DB.prepare(
      `SELECT * FROM reminder_drafts WHERE tenant_id = ? ORDER BY created_at DESC`
    )
      .bind(tenantId)
      .all();
    for (const d of drafts || []) (draftsByCustomer[d.due_customer_id] ||= []).push(d);
  }

  const counts = { overdue: 0, due: 0, due_soon: 0 };
  (dueCustomers || []).forEach((r) => (counts[r.bucket] = (counts[r.bucket] || 0) + 1));

  const rows = (dueCustomers || [])
    .map((r) => {
      const s = STYLE[r.bucket] || STYLE.due_soon;
      const drafts = draftsByCustomer[r.id] || [];
      const draftHtml = drafts.length
        ? drafts
            .map((d) => {
              if (d.status === "sent") {
                return `<div style="margin-top:6px;font-size:12px;color:#2e7d32;">&#10003; ${escapeHtml(d.channel.toUpperCase())} sent</div>`;
              }
              if (d.status === "pending") {
                return `<div style="margin-top:8px;padding:8px;background:#fff;border:1px solid #e6e6ea;border-radius:4px;">
                  <div style="font-size:12px;color:#666;margin-bottom:4px;">${escapeHtml(d.channel.toUpperCase())} draft</div>
                  <div style="font-size:13px;white-space:pre-wrap;margin-bottom:6px;">${escapeHtml(d.draft_body)}</div>
                  <button data-draft="${escapeHtml(d.id)}" class="approve-btn" style="background:#2b2b30;color:#fff;border:none;border-radius:4px;padding:6px 12px;font-size:12px;cursor:pointer;">Approve &amp; Send</button>
                </div>`;
              }
              return "";
            })
            .join("")
        : `<div style="margin-top:6px;font-size:12px;color:#999;">No draft yet</div>`;

      return `<tr style="background:${s.bg};border-left:4px solid ${s.border}">
        <td style="padding:10px;font-weight:600;color:${s.text};vertical-align:top;">${escapeHtml(s.label)}</td>
        <td style="padding:10px;vertical-align:top;">
          <div style="font-weight:600;">${escapeHtml(r.contact_name_cache || "Unknown")}</div>
          <div style="font-size:12px;color:#666;">${escapeHtml(r.address_display || "")}</div>
          ${r.contact_phone_cache ? `<a href="${telHref(r.contact_phone_cache)}" style="font-size:12px;color:${s.text};">${escapeHtml(r.contact_phone_cache)}</a>` : ""}
          ${draftHtml}
        </td>
        <td style="padding:10px;vertical-align:top;font-size:13px;">${escapeHtml(r.last_completed_at || "")}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Renewal Autopilot</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; margin: 24px; color: #222; background: #fafafa; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 18px; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th { text-align: left; padding: 10px; background: #2b2b30; color: #fff; font-size: 12px; text-transform: uppercase; }
  .legend span { display:inline-flex; align-items:center; gap:6px; margin-right:18px; font-size:13px; }
  .swatch { width:14px; height:14px; display:inline-block; }
</style>
</head>
<body>
<h1>Renewal Autopilot</h1>
<div class="sub">${(dueCustomers || []).length} customer(s) due for renewal</div>
<div class="legend">
  <span><span class="swatch" style="background:${STYLE.overdue.bg};border-left:4px solid ${STYLE.overdue.border}"></span>Overdue (${counts.overdue})</span>
  <span><span class="swatch" style="background:${STYLE.due.bg};border-left:4px solid ${STYLE.due.border}"></span>Due now (${counts.due})</span>
  <span><span class="swatch" style="background:${STYLE.due_soon.bg};border-left:4px solid ${STYLE.due_soon.border}"></span>Due soon (${counts.due_soon})</span>
</div>
<table>
<thead><tr><th>Status</th><th>Customer</th><th>Last service</th></tr></thead>
<tbody>${rows || '<tr><td colspan="3" style="padding:20px;text-align:center;color:#999;">Nothing due yet -- configure category tracking to get started.</td></tr>'}</tbody>
</table>
<script>
  document.querySelectorAll('.approve-btn').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const res = await fetch('/dashboard/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(token)}, draftId: btn.dataset.draft }),
        });
        if (res.ok) { location.reload(); } else { btn.textContent = 'Failed -- retry'; btn.disabled = false; }
      } catch (e) { btn.textContent = 'Failed -- retry'; btn.disabled = false; }
    });
  });
</script>
</body></html>`;
}

export async function approveAndSendDraft(env, tenantId, draftId) {
  const draft = await env.DB.prepare("SELECT * FROM reminder_drafts WHERE id = ? AND tenant_id = ?").bind(draftId, tenantId).first();
  if (!draft) throw new Error("draft not found for this tenant");
  if (draft.status !== "pending") return; // already actioned -- idempotent

  const dueCustomer = await env.DB.prepare("SELECT * FROM due_customers WHERE id = ?").bind(draft.due_customer_id).first();

  try {
    if (draft.channel === "sms") {
      await sendPlatformSms(env, tenantId, {
        to: dueCustomer.contact_phone_cache,
        message: draft.draft_body,
        regardingJobUuid: dueCustomer.last_job_uuid,
      });
    } else {
      await sendPlatformEmail(env, tenantId, {
        to: dueCustomer.contact_email_cache,
        subject: draft.draft_subject || "You're due for your next service",
        textBody: draft.draft_body,
        regardingJobUuid: dueCustomer.last_job_uuid,
      });
    }
    await env.DB.prepare("UPDATE reminder_drafts SET status = 'sent', sent_at = ?, reviewed_at = ? WHERE id = ?")
      .bind(Date.now(), Date.now(), draftId)
      .run();
  } catch (err) {
    await env.DB.prepare("UPDATE reminder_drafts SET status = 'failed', error = ?, reviewed_at = ? WHERE id = ?")
      .bind(String(err && err.message), Date.now(), draftId)
      .run();
    throw err;
  }
}
