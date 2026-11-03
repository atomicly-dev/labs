-- One worker (:worker) takes the oldest queued job, does it, and marks it done.
--
-- Try it in psql (npm run db):
--   \set worker 'worker-1'
-- then paste the SQL below.

BEGIN;

-- Take the oldest queued job.
SELECT id AS job_id
FROM jobs
WHERE status = 'queued'
ORDER BY id
LIMIT 1 \gset

-- Do the job: here, log that this worker sent the receipt.
INSERT INTO job_runs (job_id, worker) VALUES (:job_id, :'worker');

UPDATE jobs SET status = 'done' WHERE id = :job_id;

COMMIT;
