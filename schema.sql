-- Renewal Autopilot -- multi-tenant ServiceM8 Add-on schema.
-- Convention matches tcb-customer-portal/schema.sql: IF NOT EXISTS, explicit
-- indexes on foreign-key-ish lookup columns, INTEGER epoch-ms timestamps,
-- app-generated TEXT UUID primary keys (crypto.randomUUID()).

-- One row per installing ServiceM8 account. Keyed by the real ServiceM8
-- accountUUID once resolved -- see src/servicem8-oauth.js's provisional-row
-- handling for how this is first created before the real UUID is known.
CREATE TABLE IF NOT EXISTS tenants (
  servicem8_account_uuid TEXT PRIMARY KEY, -- our own generated tenant id (see src/index.js's OAuth callback) -- NOT ServiceM8's real account UUID, despite the name
  resolved_account_uuid  TEXT,             -- ServiceM8's real accountUUID, learned from the first addon-callback JWT (src/addon.js) -- null until the job-card action is opened at least once
  account_name           TEXT,
  status                 TEXT NOT NULL DEFAULT 'active', -- active | suspended | uninstalled
  backfill_complete      INTEGER NOT NULL DEFAULT 0,
  backfill_cursor        TEXT,
  installed_at           INTEGER NOT NULL,
  uninstalled_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tenants_resolved_account ON tenants(resolved_account_uuid);

-- OAuth2 access/refresh tokens, one row per tenant. refresh_token rotates on
-- every use -- always overwrite, never append. See getValidAccessToken() in
-- src/servicem8-oauth.js for the optimistic-lock refresh pattern that avoids
-- a lost-update race when a webhook and the cron sweep refresh concurrently.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  tenant_id               TEXT PRIMARY KEY REFERENCES tenants(servicem8_account_uuid),
  access_token            TEXT NOT NULL,
  refresh_token           TEXT NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  scope                   TEXT,
  updated_at              INTEGER NOT NULL
);

-- Per-tenant renewal-tracking rule, set during the post-install setup wizard
-- (src/addon.js). Originally category-only; generalized to also support
-- Job Badges after discovering (2026-08-03, TCB's real account) that a
-- staff-applied badge like "1 Year Follow-up" is a far more deliberate
-- "this job counts toward renewal" signal than category -- category tells
-- you what kind of job it was, not whether it's on the recurring program.
-- A tenant can have multiple rules active at once (e.g. a badge-based
-- general rule plus a separate category-based termite-inspection rule).
CREATE TABLE IF NOT EXISTS category_config (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(servicem8_account_uuid),
  signal_type              TEXT NOT NULL DEFAULT 'category', -- 'category' | 'badge'
  servicem8_category_uuid  TEXT, -- set when signal_type = 'category'
  servicem8_badge_uuid     TEXT, -- set when signal_type = 'badge'
  category_name_cache      TEXT, -- display label regardless of signal_type
  interval_months          INTEGER NOT NULL,
  due_soon_lead_days       INTEGER NOT NULL DEFAULT 30,
  overdue_grace_days       INTEGER NOT NULL DEFAULT 14,
  overdue_max_days         INTEGER,       -- stop surfacing once overdue by more than this (NULL = no cap)
  is_tracked               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_category_config_tenant ON category_config(tenant_id);

-- Computed output of the due-detection engine (src/due-engine.js). Upserted
-- on every engine run (webhook-triggered or nightly cron); UNIQUE constraint
-- means re-running is idempotent, not a source of duplicate rows. Keyed by
-- category_config_id rather than the job's raw category/badge uuid -- for a
-- badge-based rule, the *actual* category of "the most recent qualifying
-- job" can change from one recompute to the next (this month's could be
-- Premium Pest, next month's Termite Management), so the rule's own id is
-- the only stable dedupe key; servicem8_category_uuid becomes a display-only
-- cache of that job's real category.
CREATE TABLE IF NOT EXISTS due_customers (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(servicem8_account_uuid),
  category_config_id       TEXT NOT NULL REFERENCES category_config(id),
  servicem8_company_uuid   TEXT NOT NULL,
  address_key              TEXT NOT NULL, -- normalized street-address-only dedupe key
  address_display          TEXT,
  servicem8_category_uuid  TEXT, -- cached: the triggering job's real category, for display only
  last_job_uuid            TEXT,
  last_completed_at        TEXT,
  bucket                   TEXT NOT NULL, -- due_soon | due | overdue
  suppressed_reason        TEXT,          -- NULL | open_pipeline_job | category_untracked
  dismissed_at             INTEGER,       -- staff clicked the X in the dashboard for this cycle;
                                          -- cleared automatically once last_completed_at moves
                                          -- forward (a new service happened -- fresh cycle)
  contact_name_cache       TEXT,
  contact_email_cache      TEXT,
  contact_phone_cache      TEXT,
  computed_at              INTEGER NOT NULL,
  -- Follow-up sequence state (2026-08-04): reminder_round is "the next round
  -- not yet sent" -- starts at 1 (nothing sent), becomes 2 once round 1 is
  -- sent, 3 once round 2 is sent, 4 once round 3 (the last one) is sent.
  -- Bumped in src/dashboard.js's approveAndSendDraft. Auto-generation of
  -- round 2/3 drafts (src/due-engine.js's generateFollowUpDraftsForTenant)
  -- stops on its own once suppressed_reason or dismissed_at is set, so the
  -- sequence auto-stops if the customer becomes suppressed or gets dismissed
  -- -- no separate "cancelled" state needed.
  reminder_round           INTEGER NOT NULL DEFAULT 1,
  last_reminder_sent_at    INTEGER,
  UNIQUE(tenant_id, servicem8_company_uuid, address_key, category_config_id)
);
CREATE INDEX IF NOT EXISTS idx_due_customers_tenant_bucket ON due_customers(tenant_id, bucket);

-- Draft reminders awaiting staff approval in the embedded queue UI
-- (src/addon.js). Never sent automatically -- status only moves to
-- approved_sending/sent via an explicit staff action, see src/messaging.js.
-- round: 1 = the initial manually-sent reminder, 2/3 = auto-generated
-- follow-ups (see due_customers.reminder_round above). UNIQUE includes round
-- so a customer can have one draft per channel *per round* instead of just
-- one ever.
CREATE TABLE IF NOT EXISTS reminder_drafts (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(servicem8_account_uuid),
  due_customer_id          TEXT NOT NULL REFERENCES due_customers(id),
  channel                  TEXT NOT NULL, -- sms | email
  round                    INTEGER NOT NULL DEFAULT 1,
  draft_subject            TEXT,
  draft_body               TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending|approved_sending|sent|dismissed|failed
  reviewed_by_staff_uuid   TEXT,
  reviewed_at              INTEGER,
  sent_at                  INTEGER,
  servicem8_message_uuid   TEXT,
  error                    TEXT,
  created_at               INTEGER NOT NULL,
  UNIQUE(due_customer_id, channel, round)
);
CREATE INDEX IF NOT EXISTS idx_reminder_drafts_tenant_status ON reminder_drafts(tenant_id, status);

-- Per-tenant notification/messaging preferences, set in the setup wizard.
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id              TEXT PRIMARY KEY REFERENCES tenants(servicem8_account_uuid),
  notify_email           TEXT,
  default_channel        TEXT NOT NULL DEFAULT 'sms',
  sms_template           TEXT,
  email_subject_template TEXT,
  email_body_template    TEXT
);

-- Our own registry of what webhook subscriptions we believe are active per
-- tenant, so the nightly cron can detect & repair silent deactivation
-- (ServiceM8's own subscriptions can disappear -- see src/webhooks.js).
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(servicem8_account_uuid),
  servicem8_event      TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  registered_at        INTEGER,
  last_delivery_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_tenant ON webhook_subscriptions(tenant_id);

-- Raw capture of every inbound webhook delivery, regardless of whether it
-- parsed successfully. Same diagnostic pattern as tcb-customer-portal's
-- webhook_debug table -- production payload shape is confirmed unreliable
-- from ServiceM8's docs alone, so this is how the real shape gets verified.
CREATE TABLE IF NOT EXISTS webhook_debug (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  content_type TEXT,
  body         TEXT,
  created_at   INTEGER
);

-- One row per nightly-reconciliation cron run, per tenant, for diagnosing a
-- tenant whose due_customers look stale or wrong.
CREATE TABLE IF NOT EXISTS cron_runs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  jobs_scanned INTEGER,
  due_found    INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant ON cron_runs(tenant_id);
