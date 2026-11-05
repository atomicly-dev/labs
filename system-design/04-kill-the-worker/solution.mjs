// The shop's email worker. When a customer signs up, the API adds a welcome-email job to the
// jobs table. Several worker processes call processNextJob in a loop: each call takes one queued
// job, sends its email, and marks it done. It resolves with false when the queue is empty.
//
// db is a pg pool. sendEmail({ to, subject, text, idempotencyKey }) calls the email provider's
// API, and resolves once the provider has delivered the email. idempotencyKey is optional: see
// lib/email.mjs.
//
// FOR UPDATE SKIP LOCKED locks the job's row until the transaction ends, so two workers never take
// the same job at once. When a worker dies, PostgreSQL ends its transaction, the lock goes away,
// and another worker takes the job.

export async function processNextJob({ db, sendEmail }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, payload FROM jobs
       WHERE status = 'queued'
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return false;
    }
    const job = rows[0];

    // A worker can die after the provider sends the email and before COMMIT. Then another worker
    // takes the same job and sends it again. The key is the same on every try of this job, so the
    // provider sends the email once, and answers the other tries with the first send's id.
    await sendEmail({
      to: job.payload.to,
      subject: `Welcome to the shop, ${job.payload.name}`,
      text: "Thanks for signing up. Here's 10% off your first order: WELCOME10",
      idempotencyKey: `welcome-email:job-${job.id}`,
    });

    await client.query("UPDATE jobs SET status = 'done', done_at = now() WHERE id = $1", [job.id]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
