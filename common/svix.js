import { b64, b64d, constantTimeEq } from "./crypto.js";
const enc = new TextEncoder();
export async function verifySvix(secret, svixId, svixTs, svixSigHeader, rawBody) {
  if (!secret || !svixId || !svixTs || !svixSigHeader || typeof rawBody !== "string") return false;

  const b64Secret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw", b64d(b64Secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
  } catch {
    return false;
  }
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${svixId}.${svixTs}.${rawBody}`));
  const expected = b64(mac);

  for (const part of svixSigHeader.split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) === "v1" && constantTimeEq(part.slice(comma + 1), expected)) return true;
  }
  return false;
}
