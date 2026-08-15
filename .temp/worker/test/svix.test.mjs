// Round-trip test of the svix webhook verification against the official
// Standard Webhooks test vector from https://docs.svix.com/receiving/verifying-payloads/how-manual
import assert from "node:assert";
import { verifySvix } from "../src/index.js";

const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
const payload = '{"event_type":"ping","data":{"success":true}}';
const msgId = "msg_loFOjxBNrRLzqYUf";
const ts = "1731705121";
const goodSig = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";

const ok = await verifySvix(secret, msgId, ts, goodSig, payload);
assert.ok(ok, "official test vector must verify");
console.log("✓ official svix vector verifies");

const bad = await verifySvix(secret, msgId, ts, "v1,WRONGBASE64SIG=", payload);
assert.ok(!bad, "wrong signature must fail");
console.log("✓ wrong signature rejected");

const tampered = await verifySvix(secret, msgId, ts, goodSig, payload.replace("true", "false"));
assert.ok(!tampered, "tampered payload must fail");
console.log("✓ tampered payload rejected");

const multi = await verifySvix(secret, msgId, ts, "v1,deadbeef= " + goodSig, payload);
assert.ok(multi, "multi-signature header with one valid entry must verify");
console.log("✓ multi-signature header verifies");

const noPrefix = await verifySvix("plJ3nmyCDGBKInavdOK15jsl", msgId, ts, goodSig, payload);
assert.ok(noPrefix, "secret without whsec_ prefix must work");
console.log("✓ secret without whsec_ prefix works");

console.log("all svix tests passed");
