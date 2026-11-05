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

export async function updateProfile(db, session, { displayName }) {
  await db.primary.query("UPDATE profiles SET display_name = $2, updated_at = now() WHERE id = $1", [
    session.customerId,
    displayName,
  ]);
}

export async function getProfile(db, session, customerId) {
  const { rows } = await db.replica.query("SELECT id, display_name, email FROM profiles WHERE id = $1", [
    customerId,
  ]);
  return rows[0] ?? null;
}
