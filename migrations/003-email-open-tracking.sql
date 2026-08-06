-- Email read receipts (2026-08-07). email.json exposes opened/first_opened_at
-- alongside `bounced`, so a sent reminder email can be verified AND its open
-- recorded. Stored as the raw ServiceM8 account-local datetime string (same
-- convention as due_customers.last_completed_at) rather than epoch ms, since
-- these timestamps are account-local and converting invites a timezone bug.
ALTER TABLE reminder_drafts ADD COLUMN opened_at TEXT;
