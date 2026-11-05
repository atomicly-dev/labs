// Ann changes her display name from "Ann" to "Ann Lee" and presses Save. The test calls
// updateProfile with her session, then getProfile, as the settings page does. She should see
// "Ann Lee".
//
// Then Bilal, who changed nothing, opens his settings page and Ann's public profile, 10 times
// each. Those reads should all go to the replica: sending every read to the primary would undo
// the reason the shop has a replica.
//
// The replica applies each change 2 seconds after the primary commits it (recovery_min_apply_delay
// in compose.yaml), so a read from it right after a write always shows the old value.

import { connectPool, describeError, loadModule, sleep } from "../lib/helpers.mjs";
import { PRIMARY_URL, REPLICA_URL } from "../lib/urls.mjs";

export default {
  file: "profile.mjs",
  lesson: null,

  async run(ctx) {
    const loaded = await loadModule(ctx.file, ["updateProfile", "getProfile"]);
    if (loaded.problems) return loaded.problems;
    const { app } = loaded;

    const primaryPool = await connectPool(ctx, PRIMARY_URL, "the primary", { max: 4 });
    const replicaPool = await connectPool(ctx, REPLICA_URL, "the replica", { max: 4 });

    // Put the names back, and wait until the replica has them too.
    await primaryPool.query(
      `UPDATE profiles SET display_name = CASE id WHEN 1 THEN 'Ann' WHEN 2 THEN 'Bilal' ELSE 'Chen' END`,
    );
    const deadline = Date.now() + 10_000;
    while ((await replicaPool.query("SELECT display_name FROM profiles WHERE id = 1")).rows[0].display_name !== "Ann") {
      if (Date.now() > deadline) return ["The replica didn't catch up with the primary within 10 seconds. Run `docker compose logs replica`."];
      await sleep(100);
    }

    const counts = { primary: 0, replica: 0 };
    const counting = (pool, name) => ({
      query: (...args) => {
        counts[name]++;
        return pool.query(...args);
      },
    });
    const db = { primary: counting(primaryPool, "primary"), replica: counting(replicaPool, "replica") };
    const problems = [];

    // 1. Ann saves her new name, and the settings page loads it.
    const ann = { customerId: 1 };
    try {
      await app.updateProfile(db, ann, { displayName: "Ann Lee" });
    } catch (error) {
      return [`Ann's Save failed with ${describeError(error)}.`];
    }
    const saved = (await primaryPool.query("SELECT display_name FROM profiles WHERE id = 1")).rows[0].display_name;
    if (saved !== "Ann Lee") return [`After Ann's Save, her name on the primary is "${saved}", and it should be "Ann Lee".`];

    let shown;
    try {
      shown = await app.getProfile(db, ann, 1);
    } catch (error) {
      return [`Ann's settings page failed with ${describeError(error)}.`];
    }
    if (shown?.display_name !== "Ann Lee") {
      problems.push(
        `Ann changed her name to "Ann Lee" and pressed Save. The settings page loaded right after, and showed ` +
          `${shown ? `"${shown.display_name}"` : "no profile"}. She saved, and her change is gone, so she edits it again, or files a bug.`,
      );
    }

    // 2. Bilal, who wrote nothing, reads his own profile and Ann's.
    const bilal = { customerId: 2 };
    const before = { ...counts };
    for (let i = 0; i < 10; i++) {
      const own = await app.getProfile(db, bilal, 2);
      const other = await app.getProfile(db, bilal, 1);
      if (own?.display_name !== "Bilal" || !other) {
        problems.push(`Bilal's settings page showed ${JSON.stringify(own)}, and it should show his profile, with the name "Bilal".`);
        break;
      }
    }
    const fromPrimary = counts.primary - before.primary;
    if (fromPrimary > 0) {
      problems.push(
        `Bilal changed nothing, and ${fromPrimary} of his 20 profile reads went to the primary. ` +
          "Only reads that need a customer's own recent write should go there. The rest belong on the replica, or the primary takes every read again.",
      );
    }
    return problems;
  },
};
