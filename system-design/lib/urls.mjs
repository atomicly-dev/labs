// Where the labs connect. compose.yaml publishes each service on 127.0.0.1. Set an environment
// variable, such as PRIMARY_URL, to point a lab somewhere else.

const env = process.env;

/** nginx, in front of the API instances (labs 01 and 06). */
export const API_URL = env.API_URL ?? "http://127.0.0.1:8090";
/** Lab 01's database. The API instances connect to it from inside the compose network. */
export const DATABASE_URL = env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5443/shop";
/** Labs 02 to 04: the primary, and its streaming replica. */
export const PRIMARY_URL = env.PRIMARY_URL ?? "postgres://postgres:postgres@127.0.0.1:5444/shop";
export const REPLICA_URL = env.REPLICA_URL ?? "postgres://postgres:postgres@127.0.0.1:5445/shop";
/** Labs 03 and 06. */
export const REDIS_URL = env.REDIS_URL ?? "redis://127.0.0.1:6390";
/** Lab 05: the inventory service through Toxiproxy, the inventory service itself, and Toxiproxy's API. */
export const INVENTORY_URL = env.INVENTORY_URL ?? "http://127.0.0.1:8666";
export const INVENTORY_ADMIN_URL = env.INVENTORY_ADMIN_URL ?? "http://127.0.0.1:8091";
export const TOXIPROXY_URL = env.TOXIPROXY_URL ?? "http://127.0.0.1:8475";

/** Every service, by its name in compose.yaml, for the check that it's running. */
export const SERVICES = {
  nginx: API_URL,
  postgres: DATABASE_URL,
  primary: PRIMARY_URL,
  replica: REPLICA_URL,
  redis: REDIS_URL,
  inventory: INVENTORY_ADMIN_URL,
  toxiproxy: TOXIPROXY_URL,
};
