-- SMS delivery verification (2026-08-07). "sent" only ever meant "ServiceM8
-- returned 2xx"; three real customer sends failed silently. delivery_status
-- tracks the async verification sweep's verdict: NULL = not yet checked,
-- 'confirmed' = found in the job's sms.json history, 'failed' = still absent
-- after the grace window (the draft is also flipped back to a re-sendable
-- failed state).
ALTER TABLE reminder_drafts ADD COLUMN delivery_status TEXT;
ALTER TABLE reminder_drafts ADD COLUMN delivery_checked_at INTEGER;
