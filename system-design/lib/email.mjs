// Lab 04's email provider client, like the SDK of a real provider. sendEmail POSTs the email to
// the provider's API, and resolves with { id } once the provider has delivered it.
//
// Like most email and payment APIs, the provider takes an optional idempotency key. When it gets
// a key it has seen before, it doesn't send again: it answers with the first send's id.

/**
 * @param {string} baseUrl The provider's API.
 * @returns {(email: { to: string, subject: string, text: string, idempotencyKey?: string }) =>
 *   Promise<{ id: number }>}
 */
export function createEmailClient(baseUrl) {
  return async function sendEmail({ to, subject, text, idempotencyKey }) {
    const headers = { "content-type": "application/json", "x-worker-pid": String(process.pid) };
    if (idempotencyKey !== undefined) headers["idempotency-key"] = String(idempotencyKey);
    const res = await fetch(`${baseUrl}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify({ to, subject, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`The email provider answered ${res.status}`);
    return res.json();
  };
}
