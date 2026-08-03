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

  const counts = { overdue: 0, due: 0, due_soon: 0 };
  (dueCustomers || []).forEach((r) => (counts[r.bucket] = (counts[r.bucket] || 0) + 1));

  const allRowsData = (dueCustomers || [])
    .map((r) => {
      const s = STYLE[r.bucket] || STYLE.due_soon;
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
        draftHtml = `<div style="margin-top:6px;font-size:12px;color:#999;">No draft yet</div>`;
      } else if (!pendingChannels.length) {
        // Both channels already actioned -- just show what was sent.
        draftHtml = sentChannels.length
          ? sentChannels.map((d) => `<div style="margin-top:6px;font-size:12px;color:#2e7d32;">&#10003; ${escapeHtml(d.channel.toUpperCase())} sent</div>`).join("")
          : `<div style="margin-top:6px;font-size:12px;color:#999;">No pending draft</div>`;
      } else {
        // One dropdown to pick the channel, one textarea/button that follows
        // whichever channel is currently selected -- not two separate boxes.
        const byChannel = { sms: smsDraft, email: emailDraft };
        const options = pendingChannels
          .map((ch) => `<option value="${ch}">${ch.toUpperCase()}</option>`)
          .join("");
        const sentNote = sentChannels.length
          ? sentChannels.map((d) => `<div style="font-size:11px;color:#2e7d32;margin-top:4px;">&#10003; ${escapeHtml(d.channel.toUpperCase())} already sent</div>`).join("")
          : "";
        const bodyAttrs = pendingChannels
          .map((ch) => `data-body-${ch}="${escapeHtml(byChannel[ch].draft_body)}" data-draft-${ch}="${escapeHtml(byChannel[ch].id)}"`)
          .join(" ");

        draftHtml = `<div class="draft-card" data-row="${escapeHtml(r.id)}" ${bodyAttrs} style="margin-top:8px;padding:8px;background:#fff;border:1px solid #e6e6ea;border-radius:4px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <select class="channel-select" style="font-size:12px;padding:2px 4px;border-radius:4px;border:1px solid #ccc;">${options}</select>
            <span style="font-size:12px;color:#666;">draft -- edit before sending if needed</span>
          </div>
          <textarea class="draft-textarea" style="width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px;border:1px solid #ccc;border-radius:4px;resize:vertical;min-height:4.5em;margin-bottom:6px;">${escapeHtml(byChannel[pendingChannels[0]].draft_body)}</textarea>
          <button class="approve-btn" style="background:#2b2b30;color:#fff;border:none;border-radius:4px;padding:6px 12px;font-size:12px;cursor:pointer;">Approve &amp; Send</button>
          ${sentNote}
        </div>`;
      }

      // Fully handled (had drafts, none left pending) moves to one of the
      // "Contacted N" sections below instead of cluttering the main
      // actionable list -- staff shouldn't have to re-check something with
      // nothing left to do. Which section is driven by reminder_round (how
      // many rounds have actually been sent so far), not just draft count,
      // so a customer waiting on their auto-generated round-2 follow-up
      // shows as "Contacted 1", not lumped in with someone on their last
      // round -- see src/due-engine.js's generateFollowUpDraftsForTenant.
      const alreadyContacted = drafts.length > 0 && !pendingChannels.length;
      const contactedRound = Math.min(Math.max((r.reminder_round || 1) - 1, 1), 3);

      const html = `<tr data-service="${escapeHtml(r.service_name)}" data-row-id="${escapeHtml(r.id)}" data-bucket="${escapeHtml(r.bucket)}" style="background:${s.bg};border-left:4px solid ${s.border}">
        <td style="padding:10px;font-weight:600;color:${s.text};vertical-align:top;">${escapeHtml(s.label)}</td>
        <td style="padding:10px;vertical-align:top;">
          <div style="font-weight:600;">${escapeHtml(r.contact_name_cache || "Unknown")}</div>
          <div style="font-size:12px;color:#666;">${escapeHtml(r.address_display || "")}</div>
          ${r.contact_phone_cache ? `<a href="${telHref(r.contact_phone_cache)}" style="font-size:12px;color:${s.text};">${escapeHtml(r.contact_phone_cache)}</a>` : ""}
          ${draftHtml}
        </td>
        <td style="padding:10px;vertical-align:top;font-size:13px;">${escapeHtml(r.service_name || "Unknown")}</td>
        <td style="padding:10px;vertical-align:top;font-size:13px;">
          ${escapeHtml(formatDateOnly(r.last_completed_at))}
          ${
            r.last_job_notes_cache
              ? `<details style="margin-top:4px;">
            <summary style="cursor:pointer;font-size:11px;color:#888;">Show job</summary>
            <div style="font-size:12px;color:#555;margin-top:4px;max-width:220px;">${escapeHtml(r.last_job_notes_cache)}</div>
          </details>`
              : ""
          }
        </td>
        <td style="padding:10px;vertical-align:top;text-align:center;">
          <button data-dismiss="${escapeHtml(r.id)}" class="dismiss-btn" title="Remove from this list" style="background:none;border:1px solid #ccc;border-radius:50%;width:24px;height:24px;line-height:1;font-size:14px;color:#666;cursor:pointer;">&times;</button>
        </td>
      </tr>`;
      return { html, alreadyContacted, contactedRound };
    });

  const rows = allRowsData.filter((r) => !r.alreadyContacted).map((r) => r.html).join("\n");
  const contactedByRound = { 1: [], 2: [], 3: [] };
  allRowsData.filter((r) => r.alreadyContacted).forEach((r) => contactedByRound[r.contactedRound].push(r.html));
  const CONTACTED_LABELS = {
    1: "waiting on follow-up reminder",
    2: "waiting on final reminder",
    3: "final reminder sent",
  };
  const contactedSectionsHtml = [1, 2, 3]
    .map((n) => {
      const list = contactedByRound[n];
      if (!list.length) return "";
      return `<details style="margin-top:16px;">
  <summary style="cursor:pointer;font-size:13px;color:#666;padding:8px 0;">Contacted ${n} (${list.length}) -- ${CONTACTED_LABELS[n]}</summary>
  <table style="margin-top:8px;">
  <thead><tr><th>Status</th><th>Customer</th><th>Service</th><th>Last service</th><th></th></tr></thead>
  <tbody>${list.join("\n")}</tbody>
  </table>
</details>`;
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
  .tabs { display:flex; gap:0; margin-bottom:0; border-bottom:2px solid #e6e6ea; }
  .tab-btn { background:none; border:none; padding:10px 18px; font-size:13px; font-weight:600; color:#666; cursor:pointer; border-bottom:3px solid transparent; margin-bottom:-2px; }
  .tab-btn.active { color:#222; border-bottom-color:#2b2b30; }
  .toolbar { margin: 14px 0; display:flex; align-items:center; gap:8px; }
  .toolbar select { padding:6px 10px; border-radius:4px; border:1px solid #ccc; font-size:13px; }
  #empty-filtered { display:none; padding:20px; text-align:center; color:#999; background:#fff; }
</style>
</head>
<body>
<h1>Renewal Autopilot</h1>
<div class="sub" id="sub-count">${allRowsData.filter((r) => !r.alreadyContacted).length} customer(s) due for renewal</div>
<div class="tabs">
  <button class="tab-btn${counts.overdue ? " active" : ""}" data-tab-bucket="overdue">Overdue (${counts.overdue})</button>
  <button class="tab-btn${!counts.overdue && counts.due ? " active" : ""}" data-tab-bucket="due">Due now (${counts.due})</button>
  <button class="tab-btn${!counts.overdue && !counts.due ? " active" : ""}" data-tab-bucket="due_soon">Due soon (${counts.due_soon})</button>
</div>
<div class="toolbar">
  <label for="service-filter" style="font-size:13px;color:#666;">Filter by service:</label>
  <select id="service-filter">
    <option value="">All services (${(dueCustomers || []).length})</option>
    ${filterOptions}
  </select>
</div>
<table id="due-table">
<thead><tr><th>Status</th><th>Customer</th><th>Service</th><th>Last service</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#999;">Nothing due yet -- configure category tracking to get started.</td></tr>'}</tbody>
</table>
<div id="empty-filtered">No customers due for this service.</div>

${contactedSectionsHtml}
<script>
  var filterSelect = document.getElementById('service-filter');
  var allRows = Array.prototype.slice.call(document.querySelectorAll('#due-table tbody tr[data-service]'));
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  var activeBucket = (tabBtns.find(function (b) { return b.classList.contains('active'); }) || {}).dataset;
  activeBucket = activeBucket ? activeBucket.tabBucket : 'overdue';

  function applyFilters() {
    var serviceValue = filterSelect.value;
    var visibleCount = 0;
    allRows.forEach(function (row) {
      var match = row.dataset.bucket === activeBucket && (!serviceValue || row.dataset.service === serviceValue);
      row.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    });
    document.getElementById('sub-count').textContent = visibleCount + ' customer(s) due for renewal' + (serviceValue ? ' -- ' + serviceValue : '');
    document.getElementById('empty-filtered').style.display = (allRows.length && visibleCount === 0) ? 'block' : 'none';
  }

  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeBucket = btn.dataset.tabBucket;
      applyFilters();
    });
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
