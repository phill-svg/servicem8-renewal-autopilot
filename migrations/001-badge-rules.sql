-- Migrate category_config/due_customers to support badge-based rules
-- alongside category-based ones. No production data worth preserving yet
-- (single test tenant, nothing sent), so drop and recreate rather than
-- attempt an in-place column/constraint migration.

DROP TABLE IF EXISTS reminder_drafts;
DROP TABLE IF EXISTS due_customers;
DROP TABLE IF EXISTS category_config;

CREATE TABLE category_config (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(servicem8_account_uuid),
  signal_type              TEXT NOT NULL DEFAULT 'category',
  servicem8_category_uuid  TEXT,
  servicem8_badge_uuid     TEXT,
  category_name_cache      TEXT,
  interval_months          INTEGER NOT NULL,
  due_soon_lead_days       INTEGER NOT NULL DEFAULT 30,
  overdue_grace_days       INTEGER NOT NULL DEFAULT 14,
  is_tracked               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_category_config_tenant ON category_config(tenant_id);

CREATE TABLE due_customers (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(servicem8_account_uuid),
  category_config_id       TEXT NOT NULL REFERENCES category_config(id),
  servicem8_company_uuid   TEXT NOT NULL,
  address_key              TEXT NOT NULL,
  address_display          TEXT,
  servicem8_category_uuid  TEXT,
  last_job_uuid            TEXT,
  last_completed_at        TEXT,
  bucket                   TEXT NOT NULL,
  suppressed_reason        TEXT,
  contact_name_cache       TEXT,
  contact_email_cache      TEXT,
  contact_phone_cache      TEXT,
  computed_at              INTEGER NOT NULL,
  UNIQUE(tenant_id, servicem8_company_uuid, address_key, category_config_id)
);
CREATE INDEX idx_due_customers_tenant_bucket ON due_customers(tenant_id, bucket);

CREATE TABLE reminder_drafts (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(servicem8_account_uuid),
  due_customer_id          TEXT NOT NULL REFERENCES due_customers(id),
  channel                  TEXT NOT NULL,
  draft_subject            TEXT,
  draft_body               TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  reviewed_by_staff_uuid   TEXT,
  reviewed_at              INTEGER,
  sent_at                  INTEGER,
  servicem8_message_uuid   TEXT,
  error                    TEXT,
  created_at               INTEGER NOT NULL,
  UNIQUE(due_customer_id, channel)
);
CREATE INDEX idx_reminder_drafts_tenant_status ON reminder_drafts(tenant_id, status);
