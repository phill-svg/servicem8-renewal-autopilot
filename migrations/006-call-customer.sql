-- Step 4 of the chase (2026-09-27): once the final (3rd) reminder has gone
-- out, the customer lands in a "Call customer" tab so someone phones them.
-- called_at records when staff clicked "Mark called" -- NULL = still to call.
-- Cleared whenever a new service cycle starts (see due-engine.js).
ALTER TABLE due_customers ADD COLUMN called_at INTEGER;
