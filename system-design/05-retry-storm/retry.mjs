// The retry helper that both services on the checkout path use (see services.mjs). Each service
// calls createRetrier once, when it starts, and sends every call to its dependency through it:
//
//   const retrier = createRetrier();
//   const stock = await retrier.call((signal) => fetchStock(signal), { timeoutMs: 250 });
//
// call gives fn an AbortSignal that aborts after timeoutMs, and resolves with what fn resolves.
// A try fails when fn rejects or the signal aborts. When every try fails, call rejects with the
// last error.

const TRIES = 3;

export function createRetrier() {
  return {
    async call(fn, { timeoutMs }) {
      let lastError;
      for (let attempt = 1; attempt <= TRIES; attempt++) {
        try {
          return await fn(AbortSignal.timeout(timeoutMs));
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}
