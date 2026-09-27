-- Step 4 of the chase (2026-09-27): once the final (3rd) reminder has gone
-- out, the customer lands in a "Call customer" tab so someone phones them.
-- called_at records when staff clicked "Mark called" -- NULL = still to call.
-- Cleared whenever a new service cycle starts (see due-engine.js).
ALTER TABLE due_customers ADD COLUMN called_at INTEGER;

-- When a customer is serviced again, their old cycle's drafts move here
-- (see startNewReminderCycle in src/due-engine.js). Before, last cycle's
-- round-1 draft stayed in reminder_drafts and UNIQUE(due_customer_id,
-- channel, round) silently blocked the new cycle's round-1 draft, so repeat
-- customers never got a fresh reminder. CREATE ... AS SELECT copies the live
-- column order, so INSERT ... SELECT * between the two always lines up.
CREATE TABLE IF NOT EXISTS reminder_drafts_archive AS SELECT * FROM reminder_drafts WHERE 0;
