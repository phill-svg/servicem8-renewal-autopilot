// Minimal stand-ins for the D1 rows renderDashboardHtml reads. Only the
// columns the dashboard actually touches are present -- adding the rest
// would just be noise that drifts from schema.sql.
export function baseCustomer(overrides = {}) {
  return {
    id: "cust1",
    tenant_id: "t",
    category_config_id: "cfg1",
    servicem8_company_uuid: "co1",
    address_key: "1 test st",
    address_display: "1 Test St",
    servicem8_category_uuid: "cat1",
    last_job_uuid: "job1",
    last_job_number: "357",
    last_completed_at: "2025-08-06 09:00:00",
    bucket: "due",
    suppressed_reason: null,
    dismissed_at: null,
    contact_name_cache: "Test Customer",
    contact_email_cache: "test@example.com",
    contact_phone_cache: "0412345678",
    last_job_notes_cache: null,
    reminder_round: 1,
    last_reminder_sent_at: null,
    ...overrides,
  };
}

export function baseDraft(overrides = {}) {
  return {
    id: "draft1",
    tenant_id: "t",
    due_customer_id: "cust1",
    channel: "sms",
    round: 1,
    draft_subject: null,
    draft_body: "hello",
    alt_draft_subject: null,
    alt_draft_body: null,
    status: "pending",
    created_at: 1786000000000,
    sent_at: null,
    delivery_status: null,
    opened_at: null,
    error: null,
    ...overrides,
  };
}

// Stubs the D1 binding by matching on table name in the SQL text, which is
// how renderDashboardHtml's three queries differ from each other.
export function makeEnv({ customers = [], drafts = [], rules = [{ id: "cfg1", interval_months: 12 }] } = {}) {
  function rowsFor(sql) {
    if (sql.includes("due_customers")) return customers;
    if (sql.includes("reminder_drafts")) return drafts;
    if (sql.includes("category_config")) return rules;
    return [];
  }
  return {
    DB: {
      prepare(sql) {
        const q = {
          bind: () => q,
          all: async () => ({ results: rowsFor(sql) }),
          first: async () => rowsFor(sql)[0] || null,
        };
        return q;
      },
    },
  };
}

// Splits rendered HTML into one string per customer row.
export function rowsOf(html) {
  return html.split('<tr class="job-row"').slice(1);
}

// The row for a given customer name, or undefined.
export function rowFor(html, name) {
  return rowsOf(html).find((r) => r.includes(`>${name}<`));
}

// True when `needle` appears before the collapsed composer in this row --
// i.e. staff can see it without expanding anything.
export function isVisible(row, needle) {
  const at = row.indexOf(needle);
  if (at === -1) return false;
  const details = row.indexOf('<details class="draft-wrap"');
  return details === -1 || at < details;
}
