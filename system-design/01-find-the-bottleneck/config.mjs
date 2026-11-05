// The API's database pool. Each instance of the API makes one pool from these settings, when it
// starts. See server.mjs.

export const poolConfig = {
  // Room for 8 queries at once on each instance. With 2 instances, that's 16 connections, and
  // PostgreSQL has 17 for the app.
  max: 8,
};
