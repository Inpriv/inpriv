// "Show my address" (off by default), the blocklist, and the unsubscribe URL
// guard. All local.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Client, URLS, rand, newMailbox, registerId, importPub, seal, svixHeaders, db,
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

test("a new account shows its address to recipients, and hides it when asked", async () => {
  const a = await newMailbox("shown" + rand(), PW, "passphrase-a-123");
  const b = await newMailbox("rcpt" + rand(), PW, "passphrase-b-123");

  // default: the recipient sees the sender's username
  assert.equal((await send(a, b, "first")).status, 200);
  const first = await inbox(b, "first");
  assert.ok(first, "delivered");
  assert.equal(first.peer_label, a.username);
  assert.equal(first.peer_masked, 0);
  assert.equal(first.peer_address, `${a.username}@inpriv.xyz`);

  // the owner hides it, on Inpriv ID
  const idc = new Client(URLS.id);
  assert.equal((await idc.post("/api/login", { username: a.username, password: PW })).status, 200);
  assert.equal((await idc.post("/api/privacy", { show_address: false })).status, 200);

  assert.equal((await send(a, b, "second")).status, 200);
  const second = await inbox(b, "second");
  assert.equal(second.peer_label, MASKED);
  assert.equal(second.peer_masked, 1);
  // the address is not even serialised: the column keeps it for routing, the
  // API returns null
  assert.equal(second.peer_address, null);
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

test("a message with no usable unsubscribe target cannot be unsubscribed", async () => {
  const b = await newMailbox("unsub" + rand(), PW, "passphrase-b-123");
  const a = await newMailbox("unsubs" + rand(), PW, "passphrase-a-123");
  await send(a, b, "news");
  const msg = await inbox(b, "news");
  // the worker stored no target (the header was absent or unusable)
  const r = await b.mail.post("/api/v1/messages/unsubscribe", {
    message_id: msg.id, mode: "one-click", url: "http://127.0.0.1:8799/api/v1/health",
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no unsubscribe link/);
  assert.equal((await b.mail.get("/api/v1/blocked")).body.blocked.length, 0);
});

test("a new account is not suggested, and answers exactly like a name that never existed", async () => {
  const asker = await newMailbox("asker" + rand(), PW, "passphrase-a-123");
  const hidden = await newMailbox("hidden" + rand(), PW, "passphrase-b-123");
  const ghost = "ghost" + rand();

  // a new account: both switches off
  const idc = new Client(URLS.id);
  assert.equal((await idc.post("/api/login", { username: hidden.username, password: PW })).status, 200);
  const me = await idc.get("/api/me");
  assert.equal(me.body.user.show_address, true, "address visible by default");
  assert.equal(me.body.user.suggest_address, false, "never suggested by default");

  const one = await asker.mail.post("/api/v1/recipients/resolve", { names: [hidden.username] });
  const two = await asker.mail.post("/api/v1/recipients/resolve", { names: [ghost] });
  assert.equal(one.status, 200);
  // the whole shape matches: same keys, same state, nothing that says "hidden"
  assert.deepEqual(Object.keys(one.body), Object.keys(two.body));
  assert.deepEqual(Object.keys(one.body.states), Object.keys(two.body.states).map(() => hidden.username));
  assert.deepEqual(one.body.states[hidden.username], two.body.states[ghost]);
  assert.equal(one.body.states[hidden.username], "never");

  // delivery still works when the exact username is typed
  assert.equal((await send(asker, hidden, "exact-username")).status, 200);
  assert.ok(await inbox(hidden, "exact-username"));
});

test("an address is suggested only when both switches are on", async () => {
  const asker = await newMailbox("asker2" + rand(), PW, "passphrase-a-123");
  const visible = await newMailbox("shown" + rand(), PW, "passphrase-b-123");

  const idc = new Client(URLS.id);
  assert.equal((await idc.post("/api/login", { username: visible.username, password: PW })).status, 200);
  // show on, suggest off: still not suggested
  assert.equal((await idc.post("/api/privacy", { show_address: true, suggest_address: false })).status, 200);
  let r = await asker.mail.post("/api/v1/recipients/resolve", { names: [visible.username] });
  assert.equal(r.body.states[visible.username], "never");

  // both on: suggested
  const both = await idc.post("/api/privacy", { show_address: true, suggest_address: true });
  assert.equal(both.status, 200);
  assert.equal(both.body.suggest_address, true);
  r = await asker.mail.post("/api/v1/recipients/resolve", { names: [visible.username] });
  assert.equal(r.body.states[visible.username], "deliver");

  // turning show off again hides it, without touching suggest
  assert.equal((await idc.post("/api/privacy", { show_address: false })).status, 200);
  r = await asker.mail.post("/api/v1/recipients/resolve", { names: [visible.username] });
  assert.equal(r.body.states[visible.username], "never");
});

test("a masked message never carries the sender's address in the API", async () => {
  const a = await newMailbox("hide" + rand(), PW, "passphrase-a-123");
  const b = await newMailbox("see" + rand(), PW, "passphrase-b-123");

  // a hides the address, then writes
  const idc = new Client(URLS.id);
  assert.equal((await idc.post("/api/login", { username: a.username, password: PW })).status, 200);
  assert.equal((await idc.post("/api/privacy", { show_address: false })).status, 200);
  assert.equal((await send(a, b, "hidden-one")).status, 200);
  assert.equal((await send(a, b, "visible-none")).status, 200);

  const address = `${a.username}@inpriv.xyz`;
  const list = await b.mail.get("/api/v1/messages");
  const masked = list.body.items.find((m) => m.subject === "hidden-one");
  assert.ok(masked, "delivered");
  assert.equal(masked.peer_masked, 1);
  assert.equal(masked.peer_address, null, "the list must not serialise a masked address");
  assert.equal(JSON.stringify(list.body).includes(address), false, "nor anywhere else in the list body");

  const one = await b.mail.get(`/api/v1/messages/${masked.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.peer_address, null, "nor the single message");
  assert.equal(JSON.stringify(one.body).includes(address), false, "nor anywhere in the single body");
});

test("the unsubscribe endpoint acts only on the target stored with the message", async () => {
  const a = await newMailbox("unsubA" + rand(), PW, "passphrase-a-123");
  const b = await newMailbox("unsubB" + rand(), PW, "passphrase-b-123");
  assert.equal((await send(a, b, "news-two")).status, 200);
  const msg = await inbox(b, "news-two");

  // what the worker stores at delivery, from the raw List-Unsubscribe header
  db("mail").prepare("UPDATE messages SET unsubscribe = ? WHERE id = ?").run(
    JSON.stringify({ kind: "web", href: "https://lists.example.com/u?t=1", oneClick: true }), msg.id);

  // a URL that is not the stored one is refused, and nothing is fetched
  let r = await b.mail.post("/api/v1/messages/unsubscribe", {
    message_id: msg.id, mode: "one-click", url: "https://evil.example.com/u",
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /doesn't belong/);

  // a mailto target cannot be smuggled in either
  r = await b.mail.post("/api/v1/messages/unsubscribe", {
    message_id: msg.id, mode: "mailto", mailto_to: "attacker@evil.example.com",
  });
  assert.equal(r.status, 400);

  // nothing was blocked by a refused attempt
  assert.equal((await b.mail.get("/api/v1/blocked")).body.blocked.length, 0);
});
