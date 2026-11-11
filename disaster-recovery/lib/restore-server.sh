#!/bin/sh
# Runs in the restore container, as root, for each run of a lab:
#
#   sh /labs/lib/restore-server.sh <lab folder> <script>
#
# It stops the server from the last run and empties its data directory. Then it runs the lab's
# restore script as the postgres user, from the lab's folder, and starts PostgreSQL on what the
# script put in $PGDATA. The server's log goes to /var/lib/postgresql/restore.log.
#
# Exits with 0 when the server started, 3 when the script failed, 4 when the server didn't start,
# and 5 when the script started the server itself.
set -u

lab_dir="/labs/$1"
script="$2"
log=/var/lib/postgresql/restore.log

if [ -f "$PGDATA/postmaster.pid" ]; then
  gosu postgres pg_ctl stop -D "$PGDATA" -m immediate >/dev/null 2>&1
fi
rm -rf "$PGDATA" "$log"
mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 0700 "$PGDATA"

cd "$lab_dir" || exit 2
gosu postgres sh "$script" || exit 3

if [ -f "$PGDATA/postmaster.pid" ]; then
  exit 5
fi
# -w waits until the server takes connections, read-only ones too, while recovery pauses.
gosu postgres pg_ctl start -D "$PGDATA" -l "$log" -w -t 30 >/dev/null || exit 4
