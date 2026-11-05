-- The shop's tables for the System Design labs. Each PostgreSQL server runs this file when its
-- container starts, and keeps the data in memory, so `docker compose down` throws it away.

-- Lab 01's API connects as shop_app, a role without SUPERUSER, the way an app should. PostgreSQL
-- keeps the last 3 of its max_connections for superusers, so shop_app gets the rest.
CREATE ROLE shop_app LOGIN PASSWORD 'shop_app';

CREATE TABLE products (
  id    integer PRIMARY KEY,
  name  text NOT NULL,
  price numeric(10, 2) NOT NULL,
  stock integer NOT NULL
);

INSERT INTO products (id, name, price, stock) VALUES
  (1, 'Trail running shoes', 129.00, 40),
  (2, 'Rain jacket', 89.50, 25),
  (3, 'Water bottle', 14.99, 300),
  (4, 'Head torch', 34.00, 60),
  (5, 'Wool socks', 12.50, 500);

-- Lab 02: customer profiles, which the settings page edits.
CREATE TABLE profiles (
  id           integer PRIMARY KEY,
  display_name text NOT NULL,
  email        text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO profiles (id, display_name, email) VALUES
  (1, 'Ann', 'ann@example.com'),
  (2, 'Bilal', 'bilal@example.com'),
  (3, 'Chen', 'chen@example.com');

-- Lab 04: a job queue, and the fake email provider's outbox. Each row of sent_emails is an email
-- the provider delivered to a customer's inbox.
CREATE TABLE jobs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz
);

CREATE TABLE sent_emails (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_address      text NOT NULL,
  subject         text NOT NULL,
  idempotency_key text UNIQUE,
  sent_at         timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON ALL TABLES IN SCHEMA public TO shop_app;
