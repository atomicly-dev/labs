// The partner API's rate limit: each API key may make `limit` requests in each window of
// `windowSeconds`. Each instance of the API calls createLimiter once, when it starts, and calls
// allow(apiKey) before it serves a request. See server.mjs.
//
// redis is a connected client from the redis package (node-redis). Every instance connects to the
// same Redis server.

// The count lives in Redis, so every instance adds to the same one. Redis runs a script as one
// step, so two requests at the same moment can't both read the same count. The first request of a
// window sets the key to expire when the window ends, and the next request starts a new count.
const COUNT_REQUEST = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

export function createLimiter({ redis, limit, windowSeconds }) {
  return {
    // Resolves with true when the request may go ahead, and false when the key is over its limit.
    async allow(apiKey) {
      const count = await redis.eval(COUNT_REQUEST, {
        keys: [`rate-limit:${apiKey}`],
        arguments: [String(windowSeconds)],
      });
      return count <= limit;
    },
  };
}
