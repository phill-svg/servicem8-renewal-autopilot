-- Staff asked for a second draft option per reminder to pick between
-- (2026-08-25) -- e.g. termite inspection vs. bait station wording, since
-- ServiceM8's "Termite Management Treatment" category covers both and the
-- job description doesn't always make it obvious which one a given
-- customer is actually due for. draft_subject/draft_body stay the
-- best-guess default (option 1); alt_* hold the second option (option 2),
-- NULL when a category has no meaningful alternate wording.
ALTER TABLE reminder_drafts ADD COLUMN alt_draft_subject TEXT;
ALTER TABLE reminder_drafts ADD COLUMN alt_draft_body TEXT;

-- The job's original booking description (job.job_description), NOT
-- work_done_description (see servicem8-api.js's comment on listNotesForJob --
-- work_done_description is usually blank or just restates the category).
-- Cached so template selection can tell a termite inspection job apart from
-- a bait-station job without an extra API call per draft.
ALTER TABLE due_customers ADD COLUMN last_job_description_cache TEXT;
