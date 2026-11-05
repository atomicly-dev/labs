#!/bin/sh
# Starts the replica: it copies the primary with pg_basebackup, then follows the primary's
# write-ahead log over a streaming replication connection. -R writes the connection settings, so
# the server starts as a standby.
set -e

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
  until gosu postgres env PGPASSWORD=replicator \
    pg_basebackup -h primary -U replicator -D "$PGDATA" -R -X stream -c fast; do
    echo "Waiting for the primary..."
    rm -rf "${PGDATA:?}"/*
    sleep 1
  done
fi

exec docker-entrypoint.sh "$@"
