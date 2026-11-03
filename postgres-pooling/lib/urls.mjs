// Where the labs connect. PostgreSQL itself is on port 5441, and PgBouncer, in front of it, on 6441.
// Set DATABASE_URL or PGBOUNCER_URL to point the labs somewhere else.

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5441/shop";

export const PGBOUNCER_URL =
  process.env.PGBOUNCER_URL ?? "postgres://postgres:postgres@localhost:6441/shop";
