// The shop's settings page. A customer edits their display name and presses Save. The app calls
// updateProfile, then sends the browser back to the settings page, which calls getProfile.
//
// db.primary and db.replica are pg pools, and you call db.primary.query(...) the same way as
// pool.query(...). The primary takes every write. The replica is a streaming replica of it, and
// takes the reads, so the primary has room for writes. The replica applies each change a moment
// after the primary commits it.
//
// session is the signed-in customer's session: { customerId }. The app keeps one object per
// customer, between their requests, so you can store more in it.

// For a while after a customer writes, their reads go to the primary, so they see their own
// change. 10 seconds is well above the replica's usual lag. Every other read still goes to the
// replica.
const READ_PRIMARY_MS = 10_000;

export async function updateProfile(db, session, { displayName }) {
  await db.primary.query("UPDATE profiles SET display_name = $2, updated_at = now() WHERE id = $1", [
    session.customerId,
    displayName,
  ]);
  session.readPrimaryUntil = Date.now() + READ_PRIMARY_MS;
}

export async function getProfile(db, session, customerId) {
  const wroteRecently = Date.now() < (session.readPrimaryUntil ?? 0);
  const pool = wroteRecently ? db.primary : db.replica;
  const { rows } = await pool.query("SELECT id, display_name, email FROM profiles WHERE id = $1", [customerId]);
  return rows[0] ?? null;
}
