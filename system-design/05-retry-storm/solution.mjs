// The retry helper that both services on the checkout path use (see services.mjs). Each service
// calls createRetrier once, when it starts, and sends every call to its dependency through it:
//
//   const retrier = createRetrier();
//   const stock = await retrier.call((signal) => fetchStock(signal), { timeoutMs: 250 });
//
// call gives fn an AbortSignal that aborts after timeoutMs, and resolves with what fn resolves.
// A try fails when fn rejects or the signal aborts. When every try fails, call rejects with the
// last error.
//
// Two changes stop the retries from multiplying an outage:
//
// - Backoff: wait before each retry, longer each time, with a random part (jitter), so a blip
//   doesn't get a wall of retries at the same moment.
// - A circuit breaker: after 5 failed tries in a row, the retrier stops calling the dependency
//   for 1 second, and fails at once. Then it lets one trial call through. When the trial
//   succeeds, calls flow again. When it fails, the breaker stays open for another second.

const TRIES = 3;
const BACKOFF_MS = 100;
const FAILURES_TO_OPEN = 5;
const OPEN_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CircuitOpenError extends Error {
  constructor() {
    super("The circuit is open, so the call wasn't made");
  }
}

export function createRetrier() {
  let failuresInARow = 0;
  let openUntil = 0;
  let trialRunning = false;

  async function tryOnce(fn, timeoutMs) {
    let isTrial = false;
    if (failuresInARow >= FAILURES_TO_OPEN) {
      if (Date.now() < openUntil || trialRunning) throw new CircuitOpenError();
      isTrial = true;
      trialRunning = true;
    }
    try {
      const result = await fn(AbortSignal.timeout(timeoutMs));
      failuresInARow = 0;
      return result;
    } catch (error) {
      failuresInARow++;
      if (failuresInARow >= FAILURES_TO_OPEN) openUntil = Date.now() + OPEN_MS;
      throw error;
    } finally {
      if (isTrial) trialRunning = false;
    }
  }

  return {
    async call(fn, { timeoutMs }) {
      let lastError;
      for (let attempt = 1; attempt <= TRIES; attempt++) {
        try {
          return await tryOnce(fn, timeoutMs);
        } catch (error) {
          if (error instanceof CircuitOpenError) throw lastError ?? error;
          lastError = error;
        }
        if (attempt < TRIES) await sleep(BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random()));
      }
      throw lastError;
    },
  };
}
