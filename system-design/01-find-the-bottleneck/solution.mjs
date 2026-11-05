// The API's database pool. Each instance of the API makes one pool from these settings, when it
// starts. See server.mjs.

export const poolConfig = {
  // PostgreSQL has 17 connections for the app, and the shop runs up to 4 instances. 4 pools of 4
  // make 16, so every instance gets its connections. A request that finds the pool busy waits a
  // moment for a free connection, and doesn't fail.
  max: 4,
};
