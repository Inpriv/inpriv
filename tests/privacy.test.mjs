// "Show my address" (off by default), the blocklist, and the unsubscribe URL
// guard. All local.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Client, URLS, rand, newMailbox, registerId, importPub, seal, svixHeaders,
} from "./lib.mjs";
import { unsubscribeUrlProblem } from "../.mail/worker/src/unsubscribe-guard.js";

const PW = "test-password-123";
const MASKED = "Anonymous Inpriv user";

async function send(a, b, subject) {
  const to = await importPub(b.key.spki);
  return a.mail.post("/api/v1/messages/send", {
    to_username: b.username,
    subject,
    recipient_envelope: await seal(to, subject),
    sender_envelope: await seal(await importPub(a.key.spki), subject),
    recipient_key_id: b.key.id,
    sender_key_id: a.key.id,
  });
}

async function inbox(b, subject) {
  const items = (await b.mail.get("/api/v1/messages")).body.items || [];
  return items.find((m) => m.subject === subject);
}

test("a new account is anonymous to the people it writes to, until it says otherwise", async () => {
  const a = await newMailbox("anon" + rand(), PW, "passphrase-a-123");
  const b = await newMailbox("rcpt" + rand(), PW, "passphrase-b-123");

  assert.equal((await send(a, b, "first")).status, 200);
  const first = await inbox(b, "first");
  assert.ok(first, "delivered");
  assert.equal(first.peer_label, MASKED);
  assert.equal(first.peer_masked, 1);
  // routing still works: the address is kept, it is just not shown
  assert.equal(first.peer_address, `${a.username}@inpriv.xyz`);

  // the owner turns "Show my address" on, on Inpriv ID
  const idc = new Client(URLS.id);
  assert.equal((await idc.post("/api/login", { username: a.username, password: PW })).status, 200);
  assert.equal((await idc.post("/api/privacy", { show_address: true })).status, 200);

  assert.equal((await send(a, b, "second")).status, 200);
  const second = await inbox(b, "second");
  assert.equal(second.peer_label, a.username);
  assert.equal(second.peer_masked, 0);
  assert.equal(second.peer_address, `${a.username}@inpriv.xyz`);
});

test("a blocked sender is refused on send, dropped on arrival, and restored on unblock", async () => {
  const a = await newMailbox("blksend" + rand(), PW, "passphrase-a-123");
  const b = await newMailbox("blkrcpt" + rand(), PW, "passphrase-b-123");
  const from = `${a.username}@inpriv.xyz`;

  assert.equal((await b.mail.post("/api/v1/block", { address: from })).status, 200);
  const listed = (await b.mail.get("/api/v1/blocked")).body.blocked;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].address, from);

  // b sending *to* the address it blocked is refused
  const refused = await send(b, a, "blocked-send");
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /blocked/i);

  // a's mail to b is accepted but not delivered (b blocked a, silently)
  assert.equal((await send(a, b, "quiet-drop")).status, 200);
  assert.equal(await inbox(b, "quiet-drop"), undefined, "not delivered");

  // mail from them is dropped on arrival, with 200 (never a retry)
  const body = JSON.stringify({
    type: "email.received",
    data: { to: [`${b.username}@inpriv.xyz`], from, subject: "blocked-inbound", email_id: "e_" + rand(8) },
  });
  const hook = await b.mail.post("/api/v1/inbound", body, { headers: svixHeaders(body), origin: null });
  assert.equal(hook.status, 200);
  assert.equal(hook.body.ignored, "blocked sender");
  assert.equal(await inbox(b, "blocked-inbound"), undefined, "nothing stored");

  // unblock restores delivery
  assert.equal((await b.mail.post("/api/v1/unblock", { address: from })).status, 200);
  assert.equal((await b.mail.get("/api/v1/blocked")).body.blocked.length, 0);
  assert.equal((await send(a, b, "after-unblock")).status, 200);
  assert.ok(await inbox(b, "after-unblock"));
});

test("the unsubscribe guard refuses anything a sender could use to reach inside", () => {
  // acceptable
  assert.equal(unsubscribeUrlProblem("https://lists.example.com/u?t=1"), null);
  // never http
  assert.match(unsubscribeUrlProblem("http://lists.example.com/u"), /https/);
  // never our own sites
  assert.match(unsubscribeUrlProblem("https://mail.inpriv.xyz/api/v1/health"), /own host/);
  assert.match(unsubscribeUrlProblem("https://inpriv.xyz/x"), /own host/);
  // never loopback, private, link-local, CGNAT or a bare IP
  for (const url of [
    "https://127.0.0.1/x", "https://10.1.2.3/x", "https://192.168.1.1/x", "https://172.16.0.9/x",
    "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/x", "https://[::1]/x",
    "https://localhost/x", "https://box.local/x", "https://thing.internal/x",
  ]) {
    assert.ok(unsubscribeUrlProblem(url), "should refuse " + url);
  }
  // credentials, odd ports and non-URLs
  assert.ok(unsubscribeUrlProblem("https://user:pw@lists.example.com/u"));
  assert.ok(unsubscribeUrlProblem("https://lists.example.com:8443/u"));
  assert.ok(unsubscribeUrlProblem("javascript:alert(1)"));
  assert.ok(unsubscribeUrlProblem(""));
  assert.ok(unsubscribeUrlProblem("not a url"));
});

test("the unsubscribe endpoint refuses a link the guard rejects", async () => {
  const b = await newMailbox("unsub" + rand(), PW, "passphrase-b-123");
  const a = await newMailbox("unsubs" + rand(), PW, "passphrase-a-123");
  await send(a, b, "news");
  const msg = await inbox(b, "news");
  const r = await b.mail.post("/api/v1/messages/unsubscribe", {
    message_id: msg.id, mode: "one-click", url: "http://127.0.0.1:8799/api/v1/health",
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /can't be used/);
  // nothing was blocked by a failed attempt
  assert.equal((await b.mail.get("/api/v1/blocked")).body.blocked.length, 0);
});
