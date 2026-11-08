// D1 serializes this conditional increment, including concurrent requests.
export async function rateLimit(db, key, limit, windowMs, { failOpen = false } = {}) {
  const bucket = Math.floor(Date.now() / windowMs);
  try {
    const row = await db.prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?,?,1,?) ON CONFLICT(k,bucket) DO UPDATE SET c = c + 1 WHERE c < ? RETURNING c")
      .bind(key, bucket, (bucket + 1) * windowMs, limit).first();
    return !!row;
  } catch (error) {
    if (failOpen) return true;
    throw error;
  }
}
export async function overLimit(db, key, limit, windowMs, { failOpen = false } = {}) {
  try {
    const row = await db.prepare("SELECT c FROM rl_counters WHERE k = ? AND bucket = ?").bind(key, Math.floor(Date.now() / windowMs)).first();
    return !!row && row.c >= limit;
  } catch (error) { if (failOpen) return false; throw error; }
}
export async function bump(db, key, windowMs, { failOpen = false } = {}) {
  try { await rateLimit(db, key, Number.MAX_SAFE_INTEGER, windowMs); }
  catch (error) { if (!failOpen) throw error; }
}
