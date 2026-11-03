-- One worker (:worker) takes the oldest queued job, does it, and marks it done.

BEGIN;

-- FOR UPDATE locks the job until COMMIT, so no other worker takes it. SKIP LOCKED passes over
-- the jobs that other workers have locked, so this worker takes the next free one and doesn't
-- wait.
SELECT id AS job_id
FROM jobs
WHERE status = 'queued'
ORDER BY id
LIMIT 1
FOR UPDATE SKIP LOCKED \gset

INSERT INTO job_runs (job_id, worker) VALUES (:job_id, :'worker');

UPDATE jobs SET status = 'done' WHERE id = :job_id;

COMMIT;
