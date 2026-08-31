// The staff-facing standalone dashboard: the color-coded due/overdue queue,
// same visual pattern as the one-off yearly_spray_due.html built earlier for
// TCB directly, now served live from this Worker and reachable via the
// job-card Add-on button (src/addon.js) instead of being a static file.

import { escapeHtml, randomId, parseServiceM8Date } from "./util.js";
import { nextFollowUpDraftDate } from "./due-engine.js";
import { sendPlatformSms, sendPlatformEmail, listCategories, toE164Au, isSendableMobile } from "./servicem8-api.js";

// Per-status palette. `accent` drives the row's left rail + phone link,
// `bg` the row surface, `pillBg`/`pillFg` the status pill. Semantic hues:
// red=overdue, orange=due now, amber=due soon, blue=due later, green=done.
const STYLE = {
  overdue: { accent: "#8e0101", bg: "#fef4f4", pillBg: "#fee2e2", pillFg: "#991b1b", label: "Overdue" },
  due: { accent: "#ea580c", bg: "#fff8f2", pillBg: "#ffedd5", pillFg: "#9a3412", label: "Due now" },
  due_soon: { accent: "#d97706", bg: "#fffcf3", pillBg: "#fef3c7", pillFg: "#92400e", label: "Due soon" },
  due_later: { accent: "#2563eb", bg: "#f4f8ff", pillBg: "#dbeafe", pillFg: "#1e40af", label: "Due later" },
  contacted: { accent: "#64748b", bg: "#f7f8fa", pillBg: "#e2e8f0", pillFg: "#334155", label: "Contacted" },
};

// Contact fields hold things like "61403232912,0403232912" (two numbers in
// one field) or "0410414736 husband". Stripping non-digits alone dialled the
// two numbers concatenated, so this shares the SMS sender's normalizer.
function telHref(p) {
  return "tel:" + (toE164Au(p) || String(p || "").replace(/[^0-9+]/g, ""));
}

// Display the cleaned number in familiar local form -- the raw field value is
// kept as the link's tooltip so a note like "husband" isn't lost.
function formatPhoneDisplay(raw) {
  const e164 = toE164Au(raw);
  const mobile = /^\+61(4\d{2})(\d{3})(\d{3})$/.exec(e164);
  if (mobile) return `0${mobile[1]} ${mobile[2]} ${mobile[3]}`;
  const landline = /^\+61(\d)(\d{4})(\d{4})$/.exec(e164);
  if (landline) return `(0${landline[1]}) ${landline[2]} ${landline[3]}`;
  return e164 || String(raw || "");
}

// The "Job #87" number staff recognise, as a tap-to-copy chip: copying the
// number and pasting it into ServiceM8's own search is currently the only
// reliable way to get from a row to its job.
//
// This WAS a deep link, and isn't any more. Two candidate URLs were tested
// against the real account (2026-08-11) and both land on the ServiceM8 home
// page rather than the job, while logged in:
//   - https://go.servicem8.com/openjob/<uuid>   (developer FAQ's documented form)
//   - https://resource.servicem8.com/job/<uuid> (the `url` ServiceM8's own
//     resource API returns for a job)
// The stored uuid is not the problem -- it was verified against the live API
// (a7e25758-... really is job #357). Whatever route the web app uses is
// undocumented, so rather than ship a third guess this stays a copy action.
// The uuid still rides along in data-job-uuid: the moment a working URL is
// known, this becomes an <a> again and nothing else has to change.
function jobLink(jobUuid, jobNumber) {
  if (!jobNumber) return "";
  return `<button type="button" class="job-chip" data-job-number="${escapeHtml(jobNumber)}" data-job-uuid="${escapeHtml(jobUuid || "")}" title="Copy job number ${escapeHtml(jobNumber)} -- paste it into ServiceM8's search to open the job">${IC_COPY}#${escapeHtml(jobNumber)}</button>`;
}

// Inline (self-contained, CSP-safe) Feather-style icons -- currentColor so
// they inherit the surrounding text colour.
const IC_PHONE = `<svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
const IC_CAL = `<svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const IC_SEND = `<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
const IC_COPY = `<svg class="ic" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const IC_PERSON = `<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const IC_CLOCK = `<svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;

// ServiceM8 timestamps are "YYYY-MM-DD HH:MM:SS" -- staff just want the date
// here (AU format), not the time-of-day the job happened to be closed out.
function formatDateOnly(s) {
  const datePart = String(s || "").split(" ")[0];
  const [y, m, d] = datePart.split("-");
  return y && m && d ? `${d}/${m}/${y}` : datePart;
}

// Same "YYYY-MM-DD HH:MM:SS" input as formatDateOnly, keeping the time. Read
// receipts (reminder_drafts.opened_at) come straight off ServiceM8's
// email.json and are ALREADY in the account's local time, so this splits the
// string rather than going through Date -- parsing it would treat it as UTC
// and shift an 11:35 open to the previous evening.
function formatSm8DateTime(s) {
  const [datePart, timePart] = String(s || "").split(" ");
  const date = formatDateOnly(datePart);
  const hm = String(timePart || "").slice(0, 5);
  return hm ? `${date} ${hm}` : date;
}

function formatJsDate(d) {
  return d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "";
}

// Send timestamps are epoch ms, but the Worker's clock is UTC -- an 8am
// Canberra send lands on the previous UTC day, so formatting one naively
// shows staff the wrong date. A fixed AU zone matches the rest of the
// add-on's AU-only assumptions (see toE164Au in servicem8-api.js).
const AU_TZ = { timeZone: "Australia/Sydney" };
const AU_DATE_FMT = new Intl.DateTimeFormat("en-AU", { ...AU_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const AU_DATETIME_FMT = new Intl.DateTimeFormat("en-AU", { ...AU_TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });
function formatEpochAu(ms, fmt = AU_DATE_FMT) {
  const n = Number(ms);
  return n ? fmt.format(new Date(n)) : "";
}

// "3 days ago" / "2 weeks ago" -- same small-number scaling as dueChipText,
// spelled out because this one only ever appears in a hover tooltip.
function agoText(ms) {
  const days = Math.floor((Date.now() - Number(ms)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

// A short relative-time label for the next-due date: "12d overdue" / "in 3w"
// / "in 4mo" / "due today". Days under a fortnight stay in days, then weeks,
// then months, so the number stays small and scannable at any range.
function dueChipText(days) {
  if (days == null) return "";
  if (days === 0) return "due today";
  const abs = Math.abs(days);
  let n, unit;
  if (abs < 14) { n = abs; unit = "d"; }
  else if (abs < 60) { n = Math.round(abs / 7); unit = "w"; }
  else { n = Math.round(abs / 30); unit = "mo"; }
  return days < 0 ? `${n}${unit} overdue` : `in ${n}${unit}`;
}

// focusCompanyUuid: set when the queue was opened from a Client card, so the
// page lands showing just that client's renewals (across every bucket) with a
// one-click way back to the full list. Ignored when the client has no tracked
// renewals -- a banner says so rather than presenting an empty table.
// What happens next for a customer who has already been contacted. Rounds 2
// and 3 are auto-DRAFTED by the nightly cron and then wait for a human to
// approve them -- so this says "drafts", never "sends". Claiming otherwise
// would let staff assume a customer is being chased when nobody has pressed
// the button.
//
// After round 3 nothing further is ever generated, and that customer goes
// silent permanently unless someone notices -- hence the warning variant,
// which is as much the point of this chip as the date is.
function nextReminderChip(r, intervalMonths) {
  if ((r.reminder_round || 1) >= 4) {
    return `<div class="sent-row"><span class="next-chip warn" title="All three reminders have been sent. Nothing further is scheduled for this customer -- chase them by hand, or dismiss the row.">&#9888; Final reminder sent &mdash; nothing further scheduled</span></div>`;
  }
  const at = nextFollowUpDraftDate(r, intervalMonths);
  if (!at) return "";
  const days = Math.round((at.getTime() - Date.now()) / 86400000);
  const tip =
    "The next reminder is drafted automatically on this date and waits here for you to approve and send it. This row moves back into its urgency tab when that happens.";
  const label =
    days > 0
      ? `Next reminder drafts ${escapeHtml(formatJsDate(at))} &middot; ${escapeHtml(dueChipText(days))}`
      : "Next reminder drafts tonight";
  return `<div class="sent-row"><span class="next-chip" title="${escapeHtml(tip)}">${IC_CLOCK}${label}</span></div>`;
}

export async function renderDashboardHtml(env, tenantId, token, { focusCompanyUuid = null } = {}) {
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

  // Each row's next-due date = last service + the tracking rule's interval.
  // Loaded here so we can show the actual due date and a "Nd overdue / in Nd"
  // chip per customer, not just the coarse bucket.
  const { results: rules } = await env.DB.prepare("SELECT id, interval_months FROM category_config WHERE tenant_id = ?").bind(tenantId).all();
  const intervalByConfig = new Map((rules || []).map((r) => [r.id, r.interval_months]));
  const today = new Date();
  for (const r of dueCustomers || []) {
    const completed = parseServiceM8Date(r.last_completed_at);
    const months = intervalByConfig.get(r.category_config_id);
    r.plan_months = months || null;
    if (completed && months) {
      const due = new Date(completed);
      due.setMonth(due.getMonth() + months);
      r._dueDate = due;
      r._daysDelta = Math.round((due.getTime() - today.getTime()) / 86400000);
    }
  }

  const allRowsData = (dueCustomers || [])
    .map((r) => {
      const drafts = draftsByCustomer[r.id] || [];
      // Only the CURRENT round's drafts are actionable. reminder_round is the
      // next round to send (1 = nothing sent yet), and it advances the moment
      // ANY channel is sent -- so once you send, say, the email for round 1,
      // reminder_round becomes 2 and the still-pending round-1 SMS is no longer
      // "current", so it stops holding the customer in their urgency bucket.
      // One send = contacted; no nagging you to also hit the other channel.
      const currentRound = r.reminder_round || 1;
      const roundDrafts = drafts.filter((d) => (d.round || 1) === currentRound);
      const smsDraft = roundDrafts.find((d) => d.channel === "sms");
      const emailDraft = roundDrafts.find((d) => d.channel === "email");
      // 'failed' counts as actionable alongside 'pending': it's either a send
      // error or the delivery-verification sweep catching a silent delivery
      // failure -- both mean the customer still hasn't been reached, so the
      // row must stay in (or return to) its urgency bucket for a re-send.
      const actionable = (d) => d && (d.status === "pending" || d.status === "failed");
      const pendingChannels = [actionable(smsDraft) ? "sms" : null, actionable(emailDraft) ? "email" : null].filter(Boolean);
      const failedDrafts = roundDrafts.filter((d) => d.status === "failed");
      const everSent = drafts.some((d) => d.status === "sent");
      // Computed here rather than beside the tab/style code below because the
      // next-reminder chip needs it while draftHtml is still being built.
      const alreadyContacted = everSent && !pendingChannels.length;
      // For the "sent" chip: whichever channel(s) went out in the most recently
      // completed round.
      const sentRounds = drafts.filter((d) => d.status === "sent").map((d) => d.round || 1);
      const lastSentRound = sentRounds.length ? Math.max(...sentRounds) : 0;
      const sentChannels = drafts.filter((d) => d.status === "sent" && (d.round || 1) === lastSentRound);

      // The composer offers EVERY channel this customer can actually be
      // reached on, every time -- an unsent draft where there is one, else the
      // last thing sent, offered again as a re-send. Sending is never one
      // channel OR the other: chase by SMS twice, then email, then SMS again,
      // in whatever order suits. Drafts are newest-first, so the first match
      // per channel is the current one.
      const pendById = {};
      const resendById = {};
      for (const d of drafts) if ((d.status === "pending" || d.status === "failed") && !pendById[d.channel]) pendById[d.channel] = d;
      for (const d of drafts) {
        if (d.status === "sent" && !pendById[d.channel]) {
          pendById[d.channel] = d;
          resendById[d.channel] = true;
        }
      }
      // Don't offer a channel we know can't deliver: SMS needs a real mobile
      // (landlines carry the "no SMS" chip), email needs an address.
      const channelReachable = { sms: isSendableMobile(r.contact_phone_cache), email: !!r.contact_email_cache };
      const composerChannels = ["sms", "email"].filter((ch) => pendById[ch] && channelReachable[ch]);

      // When the chase started, and on which channel. The per-round "sent"
      // chips only ever describe the LATEST round, so once round 2 or 3 goes
      // out there's nothing left showing how long this customer has been
      // chased -- this is that. Earliest actual send across every round, not
      // the draft's creation, since a draft can sit pending for days. Rendered
      // outside the collapsed composer so it reads without expanding anything.
      const sentDrafts = drafts.filter((d) => d.status === "sent" && d.sent_at);
      const firstSent = sentDrafts.length ? sentDrafts.reduce((a, b) => (Number(a.sent_at) <= Number(b.sent_at) ? a : b)) : null;
      const firstContactNote = firstSent
        ? `<div class="sent-row"><span class="first-chip" title="First reminder sent ${escapeHtml(formatEpochAu(firstSent.sent_at, AU_DATETIME_FMT))} (${escapeHtml(agoText(firstSent.sent_at))}) &mdash; ${sentDrafts.length} reminder${sentDrafts.length === 1 ? "" : "s"} sent in total">${IC_CAL}First contact ${escapeHtml(formatEpochAu(firstSent.sent_at))} &middot; ${escapeHtml(firstSent.channel.toUpperCase())}</span></div>`
        : "";

      // Rendered OUTSIDE the collapsed composer so a failure is visible
      // without expanding anything.
      const failedNote = failedDrafts.length
        ? `<div class="sent-row">${failedDrafts.map((d) => `<span class="failed-chip" title="${escapeHtml(d.error || "Send failed")}">&#10007; ${escapeHtml(d.channel.toUpperCase())} delivery failed &mdash; resend</span>`).join("")}</div>`
        : "";
      // Three distinct states, because "we pressed send" and "it actually got
      // there" are different facts and staff chasing a customer need to tell
      // them apart. The verification sweep (verifyDeliveries in
      // src/due-engine.js) has always written delivery_status/opened_at; until
      // now the dashboard rendered neither, so a confirmed delivery and an
      // unverified send looked identical.
      //
      //   opened     -- green. Email only: a real read receipt off email.json.
      //   delivered  -- teal. delivery_status 'confirmed'. For email that's an
      //                 email.json record; for SMS it's INFERRED from the
      //                 message appearing in the job's SMS history (ServiceM8
      //                 exposes no SMS delivery-status field), so the label is
      //                 "delivered", never "read" or "received by them".
      //   sent       -- grey. Still inside the sweep's grace window, so
      //                 delivery is genuinely not known yet -- say so rather
      //                 than implying it landed.
      //
      // Every chip carries its send time on hover; the open chip shows the
      // open time inline, since "when did they read it" is the whole point.
      const sentChip = (d) => {
        const ch = escapeHtml(d.channel.toUpperCase());
        const sentAt = d.sent_at ? `${formatEpochAu(d.sent_at, AU_DATETIME_FMT)} (${agoText(d.sent_at)})` : "unknown time";
        if (d.opened_at) {
          return `<span class="opened-chip" title="Sent ${escapeHtml(sentAt)} &mdash; opened by the customer ${escapeHtml(formatSm8DateTime(d.opened_at))}">&#9993; ${ch} opened ${escapeHtml(formatSm8DateTime(d.opened_at))}</span>`;
        }
        if (d.delivery_status === "confirmed") {
          const how =
            d.channel === "sms"
              ? "confirmed delivered -- it appears in this job's SMS history in ServiceM8. There is no read receipt for SMS."
              : "confirmed delivered -- ServiceM8 has an email record for it. Not opened yet.";
          return `<span class="delivered-chip" title="Sent ${escapeHtml(sentAt)} &mdash; ${escapeHtml(how)}">&#10003; ${ch} delivered</span>`;
        }
        const on = formatEpochAu(d.sent_at);
        return `<span class="sent-chip" title="Sent ${escapeHtml(sentAt)} &mdash; delivery not confirmed yet, the check runs within about 15 minutes of sending">&#10003; ${ch} sent${on ? ` ${escapeHtml(on)}` : ""}</span>`;
      };
      const sentNote = sentChannels.length ? `<div class="sent-row">${sentChannels.map(sentChip).join("")}</div>` : "";

      // Only Contacted rows: a row still in an urgency bucket has a draft
      // waiting right now, so a future date there would just be noise.
      const nextNote = alreadyContacted ? nextReminderChip(r, intervalByConfig.get(r.category_config_id)) : "";

      let draftHtml;
      if (!composerChannels.length) {
        // Nothing left to send -- just show what's gone out (or nothing yet).
        draftHtml = failedNote + firstContactNote + (sentNote || (drafts.length ? "" : `<div class="draft-none">No draft yet</div>`)) + nextNote;
      } else {
        const bodyAttrs = composerChannels
          .map(
            (ch) =>
              `data-body-${ch}="${escapeHtml(pendById[ch].draft_body)}" data-draft-${ch}="${escapeHtml(pendById[ch].id)}" data-resend-${ch}="${resendById[ch] ? "1" : "0"}"`
          )
          .join(" ");
        // Composer is collapsed by default (native <details>) so the list
        // stays dense -- staff click "Review & send" to expand it inline.
        const chanLabel = composerChannels.map((c) => c.toUpperCase()).join(" / ");
        const first = composerChannels[0];
        // sentNote goes OUTSIDE the <details>, next to the failure and
        // first-contact chips, for the same reason they are: it has to read
        // without expanding anything. It used to sit inside .draft-card, and
        // since every reachable customer now gets a composer (any sent channel
        // is offered again as a re-send), that meant the sent/delivered/opened
        // state was hidden behind a click on effectively every row -- staff saw
        // no delivery or read-receipt information at all unless they happened
        // to open the composer.
        draftHtml = `${failedNote}${firstContactNote}${sentNote}${nextNote}<details class="draft-wrap">
          <summary class="draft-toggle">${IC_SEND}<span>Review &amp; send ${escapeHtml(chanLabel)}</span></summary>
          <div class="draft-card" data-row="${escapeHtml(r.id)}" ${bodyAttrs}>
            <div class="draft-head">
              <div class="chan-toggle" role="tablist">${composerChannels
                .map((ch, i) => `<button type="button" class="chan-btn${i === 0 ? " active" : ""}" data-ch="${ch}">${ch.toUpperCase()}</button>`)
                .join("")}</div>
              <span class="draft-hint">pick a channel &amp; edit before sending</span>
            </div>
            <textarea class="draft-textarea">${escapeHtml(pendById[first].draft_body)}</textarea>
            <button class="approve-btn"${resendById[first] ? ' data-resending="1"' : ""}>${IC_SEND}<span><b class="send-verb">${resendById[first] ? "Re-send" : "Send"}</b> <b class="send-ch">${first.toUpperCase()}</b></span></button>
          </div>
        </details>`;
      }

      // A customer with drafts but none left pending has been fully actioned
      // for their current round -- they move OUT of their urgency bucket
      // (Overdue/Due now/etc) into a "Contacted N" tab, where N = how many
      // rounds have actually been sent (reminder_round - 1). When the nightly
      // cron later auto-generates their next round's drafts (see
      // src/due-engine.js's generateFollowUpDraftsForTenant), those drafts are
      // pending again, so they automatically move BACK into their urgency
      // bucket to be actioned -- then to Contacted N+1 once sent, and so on.
      const contactedRound = Math.min(Math.max((r.reminder_round || 1) - 1, 1), 3);
      const tabBucket = alreadyContacted ? `contacted${contactedRound}` : r.bucket;
      const s = alreadyContacted ? STYLE.contacted : STYLE[r.bucket] || STYLE.due_soon;
      const statusLabel = alreadyContacted ? `Contacted ${contactedRound}` : s.label;

      const searchKey = `${r.contact_name_cache || ""} ${r.address_display || ""} ${r.contact_phone_cache || ""}`.toLowerCase();
      const html = `<tr class="job-row" data-service="${escapeHtml(r.service_name)}" data-plan="${escapeHtml(r.plan_months ? String(r.plan_months) : "")}" data-row-id="${escapeHtml(r.id)}" data-bucket="${escapeHtml(tabBucket)}" data-name="${escapeHtml(searchKey)}" data-company="${escapeHtml(r.servicem8_company_uuid || "")}" style="--accent:${s.accent};--rowbg:${s.bg};">
        <td class="c-status"><span class="pill" style="background:${s.pillBg};color:${s.pillFg};"><i class="dot" style="background:${s.accent};"></i>${escapeHtml(statusLabel)}</span></td>
        <td class="c-customer">
          <div class="cust-name">${escapeHtml(r.contact_name_cache || "Unknown")}</div>
          ${r.address_display ? `<div class="cust-addr">${escapeHtml(r.address_display)}</div>` : ""}
          ${
            r.contact_phone_cache
              ? `<a href="${telHref(r.contact_phone_cache)}" class="cust-phone" title="As stored in ServiceM8: ${escapeHtml(r.contact_phone_cache)}">${IC_PHONE}${escapeHtml(formatPhoneDisplay(r.contact_phone_cache))}</a>${
                  isSendableMobile(r.contact_phone_cache)
                    ? ""
                    : `<span class="nosms-chip" title="Not an Australian mobile, so SMS can't be delivered -- email or call instead, or correct the number in ServiceM8">no SMS</span>`
                }`
              : ""
          }
          ${draftHtml}
        </td>
        <td class="c-service"><span class="svc-tag">${escapeHtml(r.service_name || "Unknown")}</span></td>
        <td class="c-date">
          <span class="date-val">${IC_CAL}${escapeHtml(formatDateOnly(r.last_completed_at))}</span>
          ${jobLink(r.last_job_uuid, r.last_job_number)}
          ${
            r.last_job_notes_cache
              ? `<details class="job-notes">
            <summary>Show job</summary>
            <div class="job-notes-body">${escapeHtml(r.last_job_notes_cache)}</div>
          </details>`
              : ""
          }
        </td>
        <td class="c-due">
          ${r._dueDate ? `<span class="due-date">${escapeHtml(formatJsDate(r._dueDate))}</span>` : `<span class="due-date muted">&mdash;</span>`}
          ${r._daysDelta != null ? `<span class="due-chip" style="background:${s.pillBg};color:${s.pillFg};">${escapeHtml(dueChipText(r._daysDelta))}</span>` : ""}
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

  // Focus state for a queue opened from a Client card. A client with no
  // tracked renewals still gets a banner (saying so) rather than a silently
  // full list, so the button never looks like it did nothing.
  const focusRows = focusCompanyUuid ? (dueCustomers || []).filter((r) => r.servicem8_company_uuid === focusCompanyUuid) : [];
  const focusActive = !!focusCompanyUuid && focusRows.length > 0;
  const focusName = focusRows.length ? focusRows[0].contact_name_cache || "this client" : "";
  const focusBanner = !focusCompanyUuid
    ? ""
    : focusActive
      ? `<div class="focus-bar" id="focus-bar">${IC_PERSON}<span>Showing <b>${escapeHtml(focusName)}</b> only &mdash; ${focusRows.length} tracked renewal${focusRows.length === 1 ? "" : "s"}</span><button type="button" id="focus-clear" class="focus-clear">Show all customers</button></div>`
      : `<div class="focus-bar muted">${IC_PERSON}<span>This client has no tracked renewals yet &mdash; showing the full queue.</span></div>`;

  // Default-active tab is always one of the four urgency buckets (the
  // Contacted stages live in a dropdown, not the tab strip, so they never
  // start selected) -- first non-empty in urgency order, else Overdue.
  const defaultBucket = ["overdue", "due", "due_soon", "due_later"].find((b) => counts[b] > 0) || "overdue";
  const actionableCount = counts.overdue + counts.due + counts.due_soon + counts.due_later;

  const serviceNames = [...new Set((dueCustomers || []).map((r) => r.service_name))].sort();
  const filterOptions = serviceNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");

  // Renewal-plan tabs (3 month / 6 month / 1 year), separate from the
  // urgency tabs above -- staff asked to see each renewal cadence's jobs on
  // its own tab rather than all cadences mixed together. A plan tab is a VIEW
  // of that cadence, not a narrowing of the urgency tab: counts are across
  // every tracked customer regardless of bucket (contacted rows included),
  // and picking one shows exactly those customers wherever they sit. Anything
  // else and the count promises rows the click can't produce -- which is
  // precisely what it did while the plan intersected the active urgency tab:
  // every 3-month and 6-month customer sat in Due later, so both tabs showed
  // a count and then an empty table.
  const planCounts = { 3: 0, 6: 0, 12: 0 };
  for (const r of dueCustomers || []) {
    if (planCounts[r.plan_months] != null) planCounts[r.plan_months]++;
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Renewal Autopilot</title>
<style>
  :root {
    --bg: #f4f5f7; --surface: #ffffff; --ink: #0f172a; --ink-2: #334155; --muted: #64748b; --faint: #94a3b8;
    --line: #eceef1; --line-2: #e2e5ea; --brand: #dc2626; --brand-600: #b91c1c; --brand-ink: #991b1b;
    --sh-sm: 0 1px 2px rgba(15,23,42,.05); --sh-md: 0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.04);
    --sh-lg: 0 4px 12px rgba(15,23,42,.07), 0 2px 4px rgba(15,23,42,.04);
  }
  * { box-sizing: border-box; }
  body { font-family: "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  .ic { vertical-align: -1px; flex: none; }

  /* top app bar -- bold branded green */
  .topbar { position: sticky; top: 0; z-index: 20; background: linear-gradient(100deg, #991b1b 0%, #b91c1c 45%, #dc2626 100%); box-shadow: 0 2px 10px rgba(185,28,28,.25); }
  .topbar-in { max-width: 1080px; margin: 0 auto; padding: 13px 24px; display: flex; align-items: center; gap: 13px; }
  .logo { width: 40px; height: 40px; border-radius: 10px; background: #fff; border: 1px solid rgba(255,255,255,.4); display: flex; align-items: center; justify-content: center; flex: none; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
  .logo img { width: 100%; height: 100%; object-fit: contain; }
  .brand-txt h1 { font-size: 16.5px; font-weight: 750; margin: 0; letter-spacing: -.015em; line-height: 1.1; color: #fff; }
  .brand-txt .tag { font-size: 11.5px; color: rgba(255,255,255,.8); font-weight: 500; letter-spacing: .01em; }
  .topbar-count { margin-left: auto; font-size: 12.5px; color: #fff; font-weight: 500; background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.25); border-radius: 999px; padding: 6px 13px; }
  .topbar-count b { font-weight: 750; }

  .wrap { max-width: 1080px; margin: 0 auto; padding: 22px 24px 56px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 16px; font-weight: 500; }

  /* nav row */
  .nav { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .tabs { display: inline-flex; align-items: center; gap: 3px; background: #eceef2; padding: 4px; border-radius: 11px; }
  .tab-btn, .plan-btn { background: none; border: none; padding: 7px 13px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; border-radius: 8px; transition: all .14s ease; display: inline-flex; align-items: center; gap: 6px; }
  .tab-btn:hover, .plan-btn:hover { color: var(--ink-2); }
  .tab-btn .n, .plan-btn .n { font-size: 11px; font-weight: 700; color: var(--faint); background: rgba(15,23,42,.06); border-radius: 999px; padding: 1px 6px; min-width: 18px; text-align: center; transition: all .14s; }
  .tab-btn.active, .plan-btn.active { background: var(--surface); color: var(--ink); box-shadow: var(--sh-md); }
  .tab-btn.active .n, .plan-btn.active .n { color: #fff; background: var(--ink); }
  .plan-tabs { flex-basis: 100%; }
  .contacted-dd { align-self: center; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--line-2); font-size: 13px; font-weight: 600; color: var(--muted); background: var(--surface); cursor: pointer; box-shadow: var(--sh-sm); transition: all .14s; }
  .contacted-dd:hover { border-color: #cbd5e1; color: var(--ink-2); }
  .contacted-dd.active { color: var(--brand-ink); border-color: var(--brand); background: #fef2f2; box-shadow: 0 0 0 3px rgba(220,38,38,.1); }
  .filter { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .filter label { font-size: 12.5px; color: var(--muted); font-weight: 500; }
  .search-wrap { position: relative; display: inline-flex; align-items: center; }
  .search-ic { position: absolute; left: 11px; color: var(--faint); pointer-events: none; }
  #search-box { padding: 8px 12px 8px 32px; border-radius: 10px; border: 1px solid var(--line-2); font-size: 13px; color: var(--ink); background: var(--surface); box-shadow: var(--sh-sm); width: 240px; max-width: 60vw; }
  #search-box:hover { border-color: #cbd5e1; }
  #search-box:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(220,38,38,.12); }
  #service-filter { padding: 8px 12px; border-radius: 10px; border: 1px solid var(--line-2); font-size: 13px; font-weight: 500; color: var(--ink-2); background: var(--surface); box-shadow: var(--sh-sm); cursor: pointer; }
  #service-filter:hover { border-color: #cbd5e1; }

  /* table */
  .table-wrap { overflow-x: auto; }
  table { border-collapse: separate; border-spacing: 0 8px; width: 100%; min-width: 780px; }
  thead th { text-align: left; padding: 0 16px 2px; color: var(--faint); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  thead th:last-child { width: 48px; }

  .job-row td { background: var(--surface); vertical-align: top; padding: 11px 15px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); transition: box-shadow .15s ease; }
  .job-row td:first-child { position: relative; border-left: 1px solid var(--line); border-radius: 11px 0 0 11px; padding-left: 19px; }
  .job-row td:first-child::before { content: ""; position: absolute; left: 0; top: -1px; bottom: -1px; width: 4px; border-radius: 4px 0 0 4px; background: var(--accent); }
  .job-row td:last-child { border-right: 1px solid var(--line); border-radius: 0 11px 11px 0; }
  .job-row:hover td { box-shadow: var(--sh-lg); border-color: var(--line-2); }
  .job-row:hover td:first-child { border-left-color: var(--line-2); }

  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px 4px 9px; border-radius: 7px; font-size: 10.5px; font-weight: 750; letter-spacing: .03em; white-space: nowrap; text-transform: uppercase; }
  .pill .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  .cust-name { font-weight: 700; font-size: 13.5px; letter-spacing: -.005em; }
  .cust-addr { font-size: 11.5px; color: var(--muted); margin-top: 1px; white-space: pre-line; line-height: 1.35; }
  .cust-phone { display: inline-flex; align-items: center; gap: 5px; margin-top: 4px; font-size: 12.5px; font-weight: 650; color: var(--accent); text-decoration: none; }
  .cust-phone:hover { text-decoration: underline; }
  .nosms-chip { display: inline-block; margin-left: 6px; font-size: 10px; font-weight: 750; letter-spacing: .03em; text-transform: uppercase; color: #92400e; background: #fef3c7; border: 1px solid #fde68a; border-radius: 6px; padding: 1px 6px; vertical-align: 1px; cursor: help; }
  .svc-tag { display: inline-block; font-size: 11.5px; font-weight: 650; color: var(--ink-2); background: #f1f5f9; border: 1px solid var(--line-2); border-radius: 7px; padding: 3px 9px; }
  .c-date, .c-due { white-space: nowrap; }
  .date-val { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .date-val .ic { color: var(--faint); }
  .due-date { display: block; font-size: 12.5px; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
  .due-date.muted { color: var(--faint); font-weight: 500; }
  .due-chip { display: inline-block; margin-top: 4px; font-size: 10.5px; font-weight: 750; letter-spacing: .02em; text-transform: uppercase; border-radius: 6px; padding: 2px 7px; }
  .job-chip { display: inline-flex; align-items: center; gap: 4px; margin-top: 5px; font-size: 11px; font-weight: 700; color: var(--ink-2); background: #f1f5f9; border: 1px solid var(--line-2); border-radius: 7px; padding: 2px 8px; text-decoration: none; font-variant-numeric: tabular-nums; transition: all .12s; font-family: inherit; cursor: pointer; }
  .job-chip.copied { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
  .job-chip:hover { color: var(--brand-ink); background: #fef2f2; border-color: #fecaca; }
  .job-chip .ic { color: var(--faint); }
  .job-chip:hover .ic { color: var(--brand); }
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
  .sent-chip { font-size: 11px; font-weight: 700; color: #334155; background: #e2e8f0; border: 1px solid #cbd5e1; border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; }
  .first-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 650; color: var(--muted); background: #f8fafc; border: 1px solid var(--line-2); border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; font-variant-numeric: tabular-nums; cursor: help; }
  .first-chip .ic { color: var(--faint); }
  .failed-chip { font-size: 11px; font-weight: 700; color: #991b1b; background: #fee2e2; border: 1px solid #fecaca; border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; }
  .opened-chip { font-size: 11px; font-weight: 700; color: #166534; background: #dcfce7; border: 1px solid #bbf7d0; border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; }
  /* Between "sent" (grey, unverified) and "opened" (green, read by a human):
     confirmed delivered, but nobody has necessarily looked at it. */
  .delivered-chip { font-size: 11px; font-weight: 700; color: #115e59; background: #ccfbf1; border: 1px solid #99f6e4; border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; }
  /* What the system will do next, unprompted. Deliberately quieter than the
     delivery chips -- it reports a schedule, not an outcome. */
  .next-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 650; color: #475569; background: #f1f5f9; border: 1px solid var(--line-2); border-radius: 999px; padding: 3px 10px; letter-spacing: .01em; }
  .next-chip .ic { color: var(--faint); }
  /* The sequence has run out: this customer will never be contacted again
     unless a human acts, so it earns a warning colour. */
  .next-chip.warn { color: #92400e; background: #fef3c7; border-color: #fde68a; }
  .next-chip.warn .ic { color: #b45309; }
  .draft-wrap { margin-top: 8px; }
  .draft-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font-size: 12px; font-weight: 650; color: var(--brand-ink); background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 6px 11px; user-select: none; transition: background .12s; }
  .draft-toggle::-webkit-details-marker { display: none; }
  .draft-toggle:hover { background: #fee2e2; }
  .draft-toggle .ic { color: var(--brand); }
  .draft-wrap[open] .draft-toggle { border-radius: 8px 8px 0 0; margin-bottom: -1px; background: #fff; }
  .draft-card { padding: 11px; background: #fbfcfd; border: 1px solid var(--line-2); border-radius: 0 11px 11px 11px; max-width: 470px; }
  .draft-head { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; flex-wrap: wrap; }
  .chan-toggle { display: inline-flex; background: #eef1f4; border-radius: 8px; padding: 3px; gap: 2px; }
  .chan-btn { border: none; background: none; font-size: 11px; font-weight: 750; letter-spacing: .04em; color: var(--muted); padding: 5px 12px; border-radius: 6px; cursor: pointer; transition: all .12s; }
  .chan-btn:hover { color: var(--ink-2); }
  .chan-btn.active { background: #fff; color: var(--brand-ink); box-shadow: var(--sh-sm); }
  .chan-btn:disabled { opacity: .5; cursor: default; }
  .draft-hint { font-size: 11.5px; color: var(--faint); }
  .approve-btn .send-ch { font-weight: 800; letter-spacing: .04em; }
  .draft-textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 1.5; padding: 10px 11px; border: 1px solid var(--line-2); border-radius: 9px; resize: vertical; min-height: 5.2em; margin-bottom: 9px; color: var(--ink); background: #fff; transition: border-color .12s, box-shadow .12s; }
  .draft-textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(220,38,38,.13); }
  .approve-btn { display: inline-flex; align-items: center; gap: 7px; background: var(--brand); color: #fff; border: none; border-radius: 9px; padding: 9px 16px; font-size: 12.5px; font-weight: 650; cursor: pointer; box-shadow: 0 1px 2px rgba(185,28,28,.35); transition: background .13s, transform .06s; }
  .approve-btn:hover:not(:disabled) { background: var(--brand-600); }
  .approve-btn:active:not(:disabled) { transform: translateY(1px); }
  .approve-btn:disabled { opacity: .6; cursor: default; box-shadow: none; }

  .dismiss-btn { background: none; border: 1px solid var(--line-2); border-radius: 8px; width: 30px; height: 30px; line-height: 1; font-size: 17px; color: var(--faint); cursor: pointer; transition: all .13s; }
  .dismiss-btn:hover { background: #fef2f2; border-color: #fecaca; color: #dc2626; }

  .empty-state, #empty-filtered { padding: 52px 24px; text-align: center; color: var(--muted); background: var(--surface); border: 1px solid var(--line-2); border-radius: 14px; font-size: 14px; line-height: 1.6; box-shadow: var(--sh-sm); max-width: 520px; margin: 0 auto; }
  #empty-filtered { display: none; margin-top: 9px; }

  .focus-bar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin: 0 0 14px; padding: 9px 14px; font-size: 13px; font-weight: 600; color: var(--brand-ink); background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; }
  .focus-bar.muted { color: var(--muted); background: #f7f8fa; border-color: var(--line-2); }
  .focus-bar .ic { color: currentColor; flex: none; }
  .focus-clear { margin-left: auto; background: var(--surface); border: 1px solid #fecaca; border-radius: 8px; padding: 5px 11px; font-size: 12px; font-weight: 650; color: var(--brand-ink); cursor: pointer; transition: all .12s; }
  .focus-clear:hover { background: var(--brand); border-color: var(--brand); color: #fff; }

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
  <div class="logo"><img src="/assets/images/icon.png" alt="Renewal Autopilot logo"></div>
  <div class="brand-txt"><h1>Renewal Autopilot</h1><div class="tag">Renewal reminder queue</div></div>
  <div class="topbar-count"><b>${(dueCustomers || []).length}</b> tracked</div>
</div></div>
<div class="wrap">
<div class="sub" id="sub-count">${actionableCount} customer${actionableCount === 1 ? "" : "s"} due for renewal</div>
${focusBanner}
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
    <div class="search-wrap">
      <svg class="ic search-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="search-box" type="search" placeholder="Search name, address or phone" autocomplete="off" />
    </div>
    <label for="service-filter">Service</label>
    <select id="service-filter">
      <option value="">All services (${(dueCustomers || []).length})</option>
      ${filterOptions}
    </select>
  </div>
  <div class="tabs plan-tabs">
    <button class="plan-btn active" data-tab-plan="" data-plan-label="">All plans</button>
    <button class="plan-btn" data-tab-plan="3" data-plan-label="3 month">3 month <span class="n">${planCounts[3]}</span></button>
    <button class="plan-btn" data-tab-plan="6" data-plan-label="6 month">6 month <span class="n">${planCounts[6]}</span></button>
    <button class="plan-btn" data-tab-plan="12" data-plan-label="1 year">1 year <span class="n">${planCounts[12]}</span></button>
  </div>
</div>
${
  rows
    ? `<div class="table-wrap"><table id="due-table">
<thead><tr><th>Status</th><th>Customer</th><th>Service</th><th>Last service</th><th>Next due</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<div id="empty-filtered">No customers match the current filters.</div>`
    : `<div class="empty-state">Nothing due yet &mdash; once jobs carrying a renewal badge are completed, customers due for their next service will appear here.</div>`
}

<script>
  var filterSelect = document.getElementById('service-filter');
  var allRows = Array.prototype.slice.call(document.querySelectorAll('#due-table tbody tr[data-service]'));
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  var activeBucket = (tabBtns.find(function (b) { return b.classList.contains('active'); }) || {}).dataset;
  activeBucket = activeBucket ? activeBucket.tabBucket : 'overdue';

  // Renewal-plan tabs (3 month / 6 month / 1 year). Like searching, a plan
  // choice looks across every bucket rather than narrowing the active urgency
  // tab -- the tab counts are whole-queue counts, so anything narrower would
  // show a count and then no rows. bucketBeforePlan is the urgency view to
  // return to when the plan filter is cleared.
  var planBtns = Array.prototype.slice.call(document.querySelectorAll('.plan-btn'));
  var activePlan = '';
  var activePlanLabel = '';
  var bucketBeforePlan = activeBucket;

  var emptyFiltered = document.getElementById('empty-filtered');
  var searchBox = document.getElementById('search-box');

  // Set when opened from a Client card. Like searching, it spans every bucket
  // -- the point is to see everything tracked for that client, whichever tab
  // each row would normally live in.
  var focusCompany = ${JSON.stringify(focusActive ? focusCompanyUuid : "")};

  function applyFilters() {
    var serviceValue = filterSelect.value;
    var q = (searchBox.value || '').trim().toLowerCase();
    var visibleCount = 0;
    allRows.forEach(function (row) {
      // While searching, look across ALL buckets/tabs so a name can be found
      // wherever the customer sits; otherwise filter by the active tab.
      var bucketMatch = (q || focusCompany || activePlan) ? true : row.dataset.bucket === activeBucket;
      var serviceMatch = !serviceValue || row.dataset.service === serviceValue;
      var planMatch = !activePlan || row.dataset.plan === activePlan;
      var searchMatch = !q || (row.dataset.name || '').indexOf(q) !== -1;
      var companyMatch = !focusCompany || row.dataset.company === focusCompany;
      var match = bucketMatch && serviceMatch && planMatch && searchMatch && companyMatch;
      row.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    });
    var noun;
    if (focusCompany && !q) {
      noun = visibleCount === 1 ? ' tracked renewal' : ' tracked renewals';
      document.getElementById('sub-count').textContent = visibleCount + noun;
    } else if (q) {
      noun = visibleCount === 1 ? ' match for \\u201c' + q + '\\u201d' : ' matches for \\u201c' + q + '\\u201d';
      document.getElementById('sub-count').textContent = visibleCount + noun;
    } else if (activePlan) {
      // Not "due for renewal" -- a plan view spans every bucket, so it
      // includes customers already contacted and ones not due for months.
      noun = visibleCount === 1 ? ' customer on the ' : ' customers on the ';
      document.getElementById('sub-count').textContent = visibleCount + noun + activePlanLabel + ' plan' + (serviceValue ? ' \\u2014 ' + serviceValue : '');
    } else {
      noun = activeBucket.indexOf('contacted') === 0 ? (visibleCount === 1 ? ' customer already contacted' : ' customers already contacted') : (visibleCount === 1 ? ' customer due for renewal' : ' customers due for renewal');
      document.getElementById('sub-count').textContent = visibleCount + noun + (serviceValue ? ' \\u2014 ' + serviceValue : '');
    }
    if (emptyFiltered) emptyFiltered.style.display = (allRows.length && visibleCount === 0) ? 'block' : 'none';
  }
  searchBox.addEventListener('input', applyFilters);

  // Tap-to-copy the job number. navigator.clipboard needs a secure context,
  // which this page always is, but it still rejects when the tab isn't
  // focused or permission is denied -- hence the execCommand fallback, which
  // is what actually fires on older in-app browsers.
  document.addEventListener('click', function (ev) {
    var chip = ev.target.closest ? ev.target.closest('.job-chip') : null;
    if (!chip) return;
    var num = chip.dataset.jobNumber || '';
    var done = function () {
      var was = chip.innerHTML;
      chip.classList.add('copied');
      chip.textContent = 'Copied ' + num;
      setTimeout(function () { chip.innerHTML = was; chip.classList.remove('copied'); }, 1400);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(num).then(done, function () { legacyCopy(num); done(); });
      } else { legacyCopy(num); done(); }
    } catch (e) { legacyCopy(num); done(); }
  });
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }

  // Any deliberate move to a tab, a Contacted stage, or "Show all customers"
  // leaves the single-client view -- otherwise those controls would appear to
  // do nothing while the client filter silently kept everything else hidden.
  var focusBar = document.getElementById('focus-bar');
  function clearFocus() {
    if (!focusCompany) return;
    focusCompany = '';
    if (focusBar) focusBar.style.display = 'none';
  }
  var focusClearBtn = document.getElementById('focus-clear');
  if (focusClearBtn) focusClearBtn.addEventListener('click', function () { clearFocus(); applyFilters(); });

  var contactedSelect = document.getElementById('contacted-select');

  // Shows which urgency view is in charge, in the tab strip and the Contacted
  // dropdown together -- one place, so restoring a view after a plan filter
  // can't drift from what clicking the tab itself does. Pass '' for "none of
  // them", which is the state while a plan view spans every bucket.
  function showBucketUi(bucket) {
    tabBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.tabBucket === bucket); });
    var isContacted = bucket.indexOf('contacted') === 0;
    contactedSelect.value = isContacted ? bucket : '';
    contactedSelect.classList.toggle('active', isContacted);
  }

  // Any deliberate move to an urgency view also leaves the plan view, for the
  // same reason it leaves the single-client view: a plan spans buckets, so a
  // tab clicked underneath one would appear to do nothing.
  function clearPlan() {
    activePlan = '';
    activePlanLabel = '';
    planBtns.forEach(function (b) { b.classList.toggle('active', !b.dataset.tabPlan); });
  }

  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      clearFocus();
      clearPlan();
      activeBucket = btn.dataset.tabBucket;
      showBucketUi(activeBucket);
      applyFilters();
    });
  });

  planBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      clearFocus();
      planBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var next = btn.dataset.tabPlan;
      if (!activePlan && next) bucketBeforePlan = activeBucket;
      // No urgency tab is in charge while a plan is selected, so LEAVING a
      // plan hands control back to whichever one had it. Guarded on leaving,
      // not on "no plan set" -- otherwise clicking the already-active "All
      // plans" would yank the view back to the tab you started the session on.
      if (activePlan && !next) activeBucket = bucketBeforePlan;
      activePlan = next;
      activePlanLabel = btn.dataset.planLabel || '';
      showBucketUi(activePlan ? '' : activeBucket);
      applyFilters();
    });
  });

  // The Contacted stages live in this dropdown rather than as their own tabs.
  // Picking one deselects the urgency tabs and filters to that stage; the
  // dropdown itself lights up so it's clear it -- not a tab -- is the active view.
  contactedSelect.addEventListener('change', function () {
    if (!contactedSelect.value) return;
    clearFocus();
    clearPlan();
    activeBucket = contactedSelect.value;
    showBucketUi(activeBucket);
    applyFilters();
  });

  filterSelect.addEventListener('change', applyFilters);
  applyFilters();

  document.querySelectorAll('.draft-card').forEach(function (card) {
    var chanBtns = Array.prototype.slice.call(card.querySelectorAll('.chan-btn'));
    var textarea = card.querySelector('.draft-textarea');
    var sendCh = card.querySelector('.send-ch');
    var editedByChannel = {};
    var current = chanBtns.length ? chanBtns[0].dataset.ch : 'sms';

    var sendVerb = card.querySelector('.send-verb');
    function isResend(ch) {
      return card.dataset['resend' + ch.charAt(0).toUpperCase() + ch.slice(1)] === '1';
    }
    function loadChannel(ch) {
      textarea.value = editedByChannel[ch] !== undefined ? editedByChannel[ch] : (card.dataset['body' + ch.charAt(0).toUpperCase() + ch.slice(1)] || '');
      if (sendCh) sendCh.textContent = ch.toUpperCase();
      if (sendVerb) sendVerb.textContent = isResend(ch) ? 'Re-send' : 'Send';
    }
    chanBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        chanBtns.forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        current = b.dataset.ch;
        loadChannel(current);
      });
    });
    textarea.addEventListener('input', function () { editedByChannel[current] = textarea.value; });

    var btn = card.querySelector('.approve-btn');
    btn.addEventListener('click', async function () {
      var ch = current;
      var draftId = card.dataset['draft' + ch.charAt(0).toUpperCase() + ch.slice(1)];
      var resending = isResend(ch);
      if (resending && !confirm('Send this ' + ch.toUpperCase() + ' again? The customer has already had one.')) return;
      btn.disabled = true;
      chanBtns.forEach(function (x) { x.disabled = true; });
      btn.textContent = 'Sending...';
      try {
        const res = await fetch('/dashboard/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(token)}, draftId: draftId, editedBody: textarea.value, resend: resending }),
        });
        if (res.ok) { location.reload(); } else { btn.textContent = 'Failed -- retry'; btn.disabled = false; chanBtns.forEach(function (x) { x.disabled = false; }); }
      } catch (e) { btn.textContent = 'Failed -- retry'; btn.disabled = false; chanBtns.forEach(function (x) { x.disabled = false; }); }
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
export async function approveAndSendDraft(env, tenantId, draftId, editedBody, { resend = false } = {}) {
  const draft = await env.DB.prepare("SELECT * FROM reminder_drafts WHERE id = ? AND tenant_id = ?").bind(draftId, tenantId).first();
  if (!draft) throw new Error("draft not found for this tenant");
  // 'failed' is re-sendable: covers both an immediate send error and the
  // delivery-verification sweep flipping a false "sent" back to failed.
  // An already-'sent' draft only goes again on an explicit resend, so staff
  // can chase by SMS twice (or email twice, or any mix) without one send
  // closing off the channel -- while a double-clicked button still can't.
  const reSendable = draft.status === "pending" || draft.status === "failed" || (resend && draft.status === "sent");
  if (!reSendable) return; // already actioned -- idempotent

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
    let result;
    if (draft.channel === "sms") {
      result = await sendPlatformSms(env, tenantId, {
        to: dueCustomer.contact_phone_cache,
        message: body,
        regardingJobUuid: dueCustomer.last_job_uuid,
      });
    } else {
      result = await sendPlatformEmail(env, tenantId, {
        to: dueCustomer.contact_email_cache,
        subject: draft.draft_subject || "Time for your next pest treatment",
        textBody: body,
        regardingJobUuid: dueCustomer.last_job_uuid,
      });
    }
    // Store the ServiceM8 messageID returned by the Messaging API, for
    // diagnostics/audit (matching an add-on send to a Job Diary entry).
    const messageId = (result && (result.messageID || result.messageUUID)) || null;
    // delivery_status resets to NULL so the verification sweep re-checks this
    // send even when it's a retry of a previously failed draft.
    await env.DB.prepare(
      "UPDATE reminder_drafts SET status = 'sent', draft_body = ?, sent_at = ?, reviewed_at = ?, servicem8_message_uuid = ?, error = NULL, delivery_status = NULL, delivery_checked_at = NULL, opened_at = NULL WHERE id = ?"
    )
      .bind(body, Date.now(), Date.now(), messageId, draftId)
      .run();
    await advanceReminderRound(env, draft.due_customer_id, draft.round);
  } catch (err) {
    const message = String(err && err.message);
    if (message.includes("has already been sent")) {
      await env.DB.prepare(
        "UPDATE reminder_drafts SET status = 'sent', draft_body = ?, sent_at = ?, reviewed_at = ?, error = NULL, delivery_status = NULL, delivery_checked_at = NULL, opened_at = NULL WHERE id = ?"
      )
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
