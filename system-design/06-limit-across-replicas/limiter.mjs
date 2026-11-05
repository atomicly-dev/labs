// The partner API's rate limit: each API key may make `limit` requests in each window of
// `windowSeconds`. Each instance of the API calls createLimiter once, when it starts, and calls
// allow(apiKey) before it serves a request. See server.mjs.
//
// redis is a connected client from the redis package (node-redis). Every instance connects to the
// same Redis server.

export function createLimiter({ redis, limit, windowSeconds }) {
  // apiKey -> { startedAt, count }: the requests in the key's current window.
  const windows = new Map();

  return {
    // Resolves with true when the request may go ahead, and false when the key is over its limit.
    async allow(apiKey) {
      const now = Date.now();
      let window = windows.get(apiKey);
      if (!window || now - window.startedAt >= windowSeconds * 1000) {
        window = { startedAt: now, count: 0 };
        windows.set(apiKey, window);
      }
      window.count++;
      return window.count <= limit;
    },
  };
}
