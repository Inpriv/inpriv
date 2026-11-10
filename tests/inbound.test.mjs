// The inbound webhook's retry contract, pinned:
//
//   an @inpriv.xyz address that exists but has no mailbox yet → 5xx, so Resend
//     retries and the mail lands once the mailbox is created;
//   an address that was never an account → 200, so a made-up name can't keep a
//     message alive in Resend's queue for hours.
//
// Before this, both cases answered 200 "no such mailbox" and the first one was
// silently dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, URLS, rand, svixHeaders, newKey, sealRing } from "./lib.mjs";

const mail = new Client(URLS.mail);
const id = new Client(URLS.id);

function webhook(to) {
  const body = JSON.stringify({
    type: "email.received",
    data: { to: [to], from: "sender@example.com", subject: "hi", email_id: "e_" + rand(8) },
  });
  return { headers: svixHeaders(body), body };
}

test("an Inpriv ID without a mailbox makes the webhook ask for a retry", async () => {
  const name = "idonly" + rand(6);
  const reg = await id.post("/api/register", { username: name, password: "test-password-123" });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));

  const { headers, body } = webhook(`${name}@inpriv.xyz`);
  const r = await mail.post("/api/v1/inbound", body, { headers, origin: null });
  assert.equal(r.status, 503);
  assert.equal(r.body.retry, true);
});

test("an address that was never an account is acknowledged, not retried", async () => {
  const { headers, body } = webhook(`nosuch${rand(8)}@inpriv.xyz`);
  const r = await mail.post("/api/v1/inbound", body, { headers, origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, "no such mailbox");
});

test("a real mailbox still stores the message", async () => {
  const name = "ready" + rand(6);
  const reg = await id.post("/api/register", { username: name, password: "test-password-123" });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  // sign-up hands the sealed ring to Mail; the test does the same by hand
  const init = await mail.post("/api/v1/init-keys", await sealedRing(reg.body.mail_setup_ticket), { origin: URLS.id });
  assert.equal(init.status, 200, JSON.stringify(init.body));

  const { headers, body } = webhook(`${name}@inpriv.xyz`);
  const r = await mail.post("/api/v1/inbound", body, { headers, origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.stored, true);
});

// The same envelope the page builds: RSA-2048 in the browser, ring sealed with
// PBKDF2-SHA-256 600k and AAD "inpriv-mail-keyring-v2".
async function sealedRing(ticket) {
  const k = await newKey();
  const envelope = await sealRing([k], k.id, "test-password-123");
  return { init_ticket: ticket, public_key: k.spki, key_id: k.id, envelope };
}
