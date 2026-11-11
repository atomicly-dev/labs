#!/bin/sh
# The runbook's restore script. It restores the shop's database on the new server, beside
# production.
#
# The test runs this file in the restore container, as the postgres user, from this folder. The
# new server's data directory, $PGDATA, is empty. When this file is done, the test starts
# PostgreSQL on what it put there. Don't start the server here.
#
# What the restore container has:
#
#   /backups/base             last night's base backup, from pg_basebackup on production
#   /mnt/archive              production's WAL archive: each WAL segment since that backup,
#                             one file per segment, named like 000000010000000000000004
#   cleanup-test-orders.log   the support script's log, in this folder
#
# /backups and /mnt/archive are read-only here, so the restore can't change them.
#
# The test writes the support script's log before each run, so its times change on every run.
# It looks like this:
#
#   2026-11-11T09:32:08.912+00:00 cleanup-test-orders: started, deleting test orders
#   2026-11-11T09:32:09.321+00:00 cleanup-test-orders: DELETE 1230
#
# To read a line's time into a variable:
#
#   some_time=$(grep 'text in the line' cleanup-test-orders.log | cut -d' ' -f1)
set -e

# Copy last night's base backup into the empty data directory.
cp -R /backups/base/. "$PGDATA"
