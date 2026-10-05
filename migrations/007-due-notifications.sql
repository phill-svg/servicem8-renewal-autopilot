-- Daily "customers now due" digest (2026-10-05): when customers move into
-- Due now / Overdue, one ServiceM8 Inbox message + a push/bell notification
-- goes to staff each morning -- same experience as ServiceM8's own Reminders
-- add-on. See sendDueDigestForTenant in src/due-engine.js.

-- When this customer was included in a digest. NULL = not announced yet this
-- cycle; reset by startNewReminderCycle so the next cycle is announced too.
ALTER TABLE due_customers ADD COLUMN due_notified_at INTEGER;

-- Sydney-local YYYY-MM-DD of the last digest -- the once-per-day claim the
-- 2-minute sweep uses so it can't send the same morning's digest twice.
ALTER TABLE tenant_settings ADD COLUMN last_due_digest_date TEXT;

-- Who gets the notification: every staff member who has opened the Job
-- Reminders add-on (staffUUID from the add-on callback JWT, src/index.js).
CREATE TABLE IF NOT EXISTS notify_recipients (
  tenant_id     TEXT NOT NULL,
  staff_uuid    TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, staff_uuid)
);
