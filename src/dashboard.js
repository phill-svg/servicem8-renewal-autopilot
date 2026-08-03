// The staff-facing standalone dashboard: the color-coded due/overdue queue,
// same visual pattern as the one-off yearly_spray_due.html built earlier for
// TCB directly, now served live from this Worker and reachable via the
// job-card Add-on button (src/addon.js) instead of being a static file.

import { escapeHtml, randomId } from "./util.js";
import { sendPlatformSms, sendPlatformEmail, listCategories } from "./servicem8-api.js";

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
                  <div style="font-size:12px;color:#666;margin-bottom:4px;">${escapeHtml(d.channel.toUpperCase())} draft -- edit before sending if needed</div>
                  <textarea data-draft-text="${escapeHtml(d.id)}" style="width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px;border:1px solid #ccc;border-radius:4px;resize:vertical;min-height:4.5em;margin-bottom:6px;">${escapeHtml(d.draft_body)}</textarea>
                  <button data-draft="${escapeHtml(d.id)}" class="approve-btn" style="background:#2b2b30;color:#fff;border:none;border-radius:4px;padding:6px 12px;font-size:12px;cursor:pointer;">Approve &amp; Send</button>
                </div>`;
              }
              return "";
            })
            .join("")
        : `<div style="margin-top:6px;font-size:12px;color:#999;">No draft yet</div>`;

      return `<tr data-service="${escapeHtml(r.service_name)}" style="background:${s.bg};border-left:4px solid ${s.border}">
        <td style="padding:10px;font-weight:600;color:${s.text};vertical-align:top;">${escapeHtml(s.label)}</td>
        <td style="padding:10px;vertical-align:top;">
          <div style="font-weight:600;">${escapeHtml(r.contact_name_cache || "Unknown")}</div>
          <div style="font-size:12px;color:#666;">${escapeHtml(r.address_display || "")}</div>
          ${r.contact_phone_cache ? `<a href="${telHref(r.contact_phone_cache)}" style="font-size:12px;color:${s.text};">${escapeHtml(r.contact_phone_cache)}</a>` : ""}
          ${draftHtml}
        </td>
        <td style="padding:10px;vertical-align:top;font-size:13px;">${escapeHtml(r.service_name || "Unknown")}</td>
        <td style="padding:10px;vertical-align:top;font-size:13px;">${escapeHtml(r.last_completed_at || "")}</td>
      </tr>`;
    })
    .join("\n");

  const serviceNames = [...new Set((dueCustomers || []).map((r) => r.service_name))].sort();
  const filterOptions = serviceNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");

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
  .toolbar { margin-bottom: 14px; display:flex; align-items:center; gap:8px; }
  .toolbar select { padding:6px 10px; border-radius:4px; border:1px solid #ccc; font-size:13px; }
  #empty-filtered { display:none; padding:20px; text-align:center; color:#999; background:#fff; }
</style>
</head>
<body>
<h1>Renewal Autopilot</h1>
<div class="sub" id="sub-count">${(dueCustomers || []).length} customer(s) due for renewal</div>
<div class="legend">
  <span><span class="swatch" style="background:${STYLE.overdue.bg};border-left:4px solid ${STYLE.overdue.border}"></span>Overdue (${counts.overdue})</span>
  <span><span class="swatch" style="background:${STYLE.due.bg};border-left:4px solid ${STYLE.due.border}"></span>Due now (${counts.due})</span>
  <span><span class="swatch" style="background:${STYLE.due_soon.bg};border-left:4px solid ${STYLE.due_soon.border}"></span>Due soon (${counts.due_soon})</span>
</div>
<div class="toolbar">
  <label for="service-filter" style="font-size:13px;color:#666;">Filter by service:</label>
  <select id="service-filter">
    <option value="">All services (${(dueCustomers || []).length})</option>
    ${filterOptions}
  </select>
</div>
<table>
<thead><tr><th>Status</th><th>Customer</th><th>Service</th><th>Last service</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#999;">Nothing due yet -- configure category tracking to get started.</td></tr>'}</tbody>
</table>
<div id="empty-filtered">No customers due for this service.</div>
<script>
  var filterSelect = document.getElementById('service-filter');
  var allRows = Array.prototype.slice.call(document.querySelectorAll('table tbody tr[data-service]'));
  filterSelect.addEventListener('change', function () {
    var value = filterSelect.value;
    var visibleCount = 0;
    allRows.forEach(function (row) {
      var match = !value || row.dataset.service === value;
      row.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    });
    document.getElementById('sub-count').textContent = visibleCount + ' customer(s) due for renewal' + (value ? ' -- ' + value : '');
    document.getElementById('empty-filtered').style.display = (allRows.length && visibleCount === 0) ? 'block' : 'none';
  });

  document.querySelectorAll('.approve-btn').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var draftId = btn.dataset.draft;
      var textarea = document.querySelector('textarea[data-draft-text="' + draftId + '"]');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const res = await fetch('/dashboard/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(token)}, draftId: draftId, editedBody: textarea ? textarea.value : undefined }),
        });
        if (res.ok) { location.reload(); } else { btn.textContent = 'Failed -- retry'; btn.disabled = false; }
      } catch (e) { btn.textContent = 'Failed -- retry'; btn.disabled = false; }
    });
  });
</script>
</body></html>`;
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
        subject: draft.draft_subject || "You're due for your next service",
        textBody: body,
        regardingJobUuid: dueCustomer.last_job_uuid,
      });
    }
    await env.DB.prepare("UPDATE reminder_drafts SET status = 'sent', draft_body = ?, sent_at = ?, reviewed_at = ? WHERE id = ?")
      .bind(body, Date.now(), Date.now(), draftId)
      .run();
  } catch (err) {
    await env.DB.prepare("UPDATE reminder_drafts SET status = 'failed', draft_body = ?, error = ?, reviewed_at = ? WHERE id = ?")
      .bind(body, String(err && err.message), Date.now(), draftId)
      .run();
    throw err;
  }
}
