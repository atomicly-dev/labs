#!/bin/sh
# The runbook's restore script, fixed. It restores last night's base backup, then replays
# production's archived WAL up to just before the bad DELETE.
#
# Restoring the base backup alone brought the deleted orders back, but lost this morning's orders,
# placed after the backup. Those are only in the WAL that production archived since.
set -e

# The time the support script started, before it ran its DELETE. Recovery applies every commit up
# to this time, and stops before the next one: the DELETE's.
#
# The other line's time is when the script logged `DELETE 1230`, after the DELETE committed. With
# that target, recovery replays the DELETE too.
target=$(grep 'started' cleanup-test-orders.log | cut -d' ' -f1)

# 1. Copy last night's base backup into the empty data directory.
cp -R /backups/base/. "$PGDATA"

# 2. restore_command copies each WAL segment back from the archive: %f is the segment's file name,
#    and %p the path to copy it to. recovery_target_time is where replay stops. The time has its
#    offset from UTC, so the server's time zone doesn't change it.
#
#    recovery_target_action stays at its default, pause: the server stops at the target and takes
#    read-only queries, so you can check the orders before you end recovery.
cat >> "$PGDATA/postgresql.conf" <<EOF
restore_command = 'cp /mnt/archive/%f "%p"'
recovery_target_time = '$target'
EOF

# 3. An empty recovery.signal file starts the server in recovery, when the test starts it.
touch "$PGDATA/recovery.signal"
