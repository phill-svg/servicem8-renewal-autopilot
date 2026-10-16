-- Manual stage moves (2026-10-16): staff can move a customer to Due /
-- Contacted 1-3 / Call customer / Called from the dashboard after phoning
-- them, and book a job for them. manual_stage_at = when the stage was last
-- set by hand, manual_stage_note = what was recorded ("Contacted by phone",
-- "Booked job #1234"). Both cleared when a new service cycle starts (see
-- startNewReminderCycle in src/due-engine.js).
ALTER TABLE due_customers ADD COLUMN manual_stage_at INTEGER;
ALTER TABLE due_customers ADD COLUMN manual_stage_note TEXT;
