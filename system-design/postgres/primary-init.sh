#!/bin/sh
# Runs once, when the primary's container starts for the first time. It adds a role the replica
# connects as, and lets that role stream the write-ahead log over the network.
set -e

psql -v ON_ERROR_STOP=1 -U postgres -d shop -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator'"
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
