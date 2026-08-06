-- Job number for the dashboard's "open the original job" link (2026-08-07).
-- ServiceM8's job.generated_job_id is the number staff actually see on the
-- job card ("Job #87"); the uuid alone is enough to build the deep link, but
-- not to label it. Comes free with the job records the engine already fetches.
ALTER TABLE due_customers ADD COLUMN last_job_number TEXT;
