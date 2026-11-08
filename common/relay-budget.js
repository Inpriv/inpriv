import { sha256hex } from "./crypto.js";
import { rateLimit } from "./rate-limit.js";
export async function relayBudget(db, sender, recipient) {
  const destination = await sha256hex(recipient);
  for (const [key, limit, window] of [
    ["relay:global:hour", 100, 3_600_000], ["relay:global:day", 500, 86_400_000],
    [`relay:${sender}:hour`, 40, 3_600_000], [`relay:${sender}:day`, 100, 86_400_000],
    [`relay:recipient:${destination}`, 10, 3_600_000],
  ]) if (!(await rateLimit(db, key, limit, window))) return false;
  return true;
}
