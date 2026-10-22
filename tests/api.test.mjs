// Security regression tests against the local Workers (tests/local.sh up).
// Run: node --test tests/api.test.mjs
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import * as L from "./lib.mjs";

const { URLS, Client } = L;
const PW = "account-password-1";
const PP = "correct horse battery staple";
const now = () => Date.now();

let alice, bob;
before(async () => {
  alice = await L.newMailbox("alice" + L.rand(), PW, PP);
  bob = await L.newMailbox("bob" + L.rand(), PW, PP);
});

describe("mailbox passphrase never reaches the server", () => {
  test("sign-in and mailbox setup carry no passphrase-derived secret", async () => {
    const mail = new Client(URLS.mail);
    const u = "carl" + L.rand();
    await L.registerId(u, PW);
    const r = await mail.post("/api/v1/login", { username: u, password: PW });
    assert.equal(r.body.status, "needs_init");
    assert.ok(!("token" in r.body));
    // init-keys takes the ticket, a public key and the sealed ring: no password field is read
    const key = await L.newKey();
    const envelope = await L.sealRing([key], key.id, "carl passphrase 123");
    const r2 = await mail.post("/api/v1/init-keys", { init_ticket: r.body.init_ticket, public_key: key.spki, key_id: key.id, envelope });
    assert.equal(r2.status, 200);
    const row = L.db("mail").prepare("SELECT auth_hash, key_format, priv_iter FROM users WHERE username = ?").get(u);
    assert.equal(row.auth_hash, "", "no password-derived hash is stored for new mailboxes");
    assert.equal(row.key_format, 2);
    assert.equal(row.priv_iter, 600000);
  });

  test("init-keys refuses weak or old-format envelopes and needs a fresh ticket", async () => {
    const mail = new Client(URLS.mail);
    const u = "dina" + L.rand();
    await L.registerId(u, PW);
    const t = (await mail.post("/api/v1/login", { username: u, password: PW })).body.init_ticket;
    const key = await L.newKey();
    const weak = await L.sealRing([key], key.id, "dina passphrase 123", 100000);
    assert.equal((await mail.post("/api/v1/init-keys", { init_ticket: t, public_key: key.spki, key_id: key.id, envelope: weak })).status, 400);
    const v1 = { ...(await L.sealRing([key], key.id, "dina passphrase 123")), key_format: 1 };
    assert.equal((await mail.post("/api/v1/init-keys", { init_ticket: t, public_key: key.spki, key_id: key.id, envelope: v1 })).status, 400);
    const other = await L.newKey();
    const ok = await L.sealRing([key], key.id, "dina passphrase 123");
    assert.equal((await mail.post("/api/v1/init-keys", { init_ticket: t, public_key: key.spki, key_id: other.id, envelope: ok })).status, 400, "key id must match the key");
    assert.equal((await mail.post("/api/v1/init-keys", { password: PW, public_key: key.spki, key_id: key.id, envelope: ok })).status, 401, "a password is not a ticket");
    assert.equal((await mail.post("/api/v1/init-keys", { init_ticket: t, public_key: key.spki, key_id: key.id, envelope: ok })).status, 200);
    const again = await mail.post("/api/v1/init-keys", { init_ticket: t, public_key: key.spki, key_id: key.id, envelope: ok });
    assert.ok([401, 409].includes(again.status), "ticket is single-use and keys are never replaced");
  });

  test("the old password-based key endpoints are gone", async () => {
    for (const p of ["/api/v1/rekey", "/api/v1/password-check", "/api/v1/id-init", "/api/v1/register"]) {
      assert.equal((await alice.mail.post(p, { password: PW })).status, 410, p);
    }
  });

  test("ID password change leaves the key ring alone and ends Mail sessions", async () => {
    const u = "pwch" + L.rand();
    const m = await L.newMailbox(u, PW, PP);
    const id = new Client(URLS.id);
    await id.post("/api/login", { login: u, password: PW });
    const before = L.db("mail").prepare("SELECT encrypted_private_key, priv_salt FROM users WHERE username = ?").get(u);
    const r = await id.post("/api/password/change", { current: PW, next: "a-new-password-2" });
    assert.equal(r.status, 200);
    assert.equal((await m.mail.get("/api/v1/me")).status, 401, "Mail session revoked");
    const after = L.db("mail").prepare("SELECT encrypted_private_key, priv_salt FROM users WHERE username = ?").get(u);
    assert.deepEqual(after, before, "mailbox key ring unchanged");
    const relog = new Client(URLS.mail);
    const r2 = await relog.post("/api/v1/login", { username: u, password: "a-new-password-2" });
    assert.equal(r2.body.status, "ok");
    const ring = await L.openRing(r2.body.user, PP);
    assert.equal(ring.current, m.key.id, "same passphrase still opens the same keys");
  });
});

describe("format-1 mailboxes upgrade once, safely", () => {
  let dave, oldKey, msgId;
  before(async () => {
    // a mailbox as the old flow left it: key sealed under the sign-in password
    const u = "dave" + L.rand();
    oldKey = await L.newKey();
    const env = await L.legacyEnvelope(PW, oldKey.pkcs8);
    const salt = L.b64(crypto.getRandomValues(new Uint8Array(16)));
    const hash = L.b64(await L.legacyHash(PW, salt));
    L.db("id").prepare("INSERT INTO users (id, username, email, pass_hash, pass_salt, pass_iters, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), u, `${u}@inpriv.xyz`, hash, salt, 300000, now());
    L.db("mail").prepare(`INSERT INTO users (username, address, auth_hash, auth_salt, public_key, encrypted_private_key, priv_iv, priv_salt, priv_iter, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(u, `${u}@inpriv.xyz`, hash, salt, oldKey.spki, env.encrypted_private_key, env.priv_iv, env.priv_salt, 300000, now());
    const owner = L.db("mail").prepare("SELECT id FROM users WHERE username = ?").get(u).id;
    const e = await L.seal(await L.importPub(oldKey.spki), JSON.stringify({ v: 1, text: "old mail before the upgrade" }));
    msgId = Number(L.db("mail").prepare(`INSERT INTO messages (owner_id, direction, peer_address, peer_label, subject, encrypted_aes_key, iv, ciphertext, auth_tag, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(owner, "inbound", "x@example.com", "x", "old", e.encrypted_aes_key, e.iv, e.ciphertext, e.auth_tag, now()).lastInsertRowid);
    L.db("mail").prepare("INSERT INTO device_keys (user_id, wrapped_dek, created_at) VALUES (?, 'legacy-wrap', ?)").run(owner, now());
    dave = { u, mail: new Client(URLS.mail) };
    const r = await dave.mail.post("/api/v1/login", { username: u, password: PW });
    assert.equal(r.body.status, "ok");
    assert.equal(r.body.user.key_format, 1);
    dave.user = r.body.user;
  });

  const upgradeBody = async (proofKey, purpose = "migrate", passphrase = "dave new passphrase") => {
    const c = await dave.mail.post("/api/v1/keys/challenge", { purpose });
    const fresh = await L.newKey();
    return {
      fresh,
      body: {
        public_key: fresh.spki, key_id: fresh.id,
        envelope: await L.sealRing([fresh, oldKey], fresh.id, passphrase),
        challenge_id: c.body.challenge_id,
        // a key that can't open the challenge sends something made up
        challenge_answer: proofKey ? await L.answer(c.body.challenge, proofKey).catch(() => L.b64(crypto.getRandomValues(new Uint8Array(32)))) : "AAAA",
      },
    };
  };

  test("a session alone can't upgrade: the old private key must answer the challenge", async () => {
    const stranger = await L.newKey();
    assert.equal((await dave.mail.post("/api/v1/keys/migrate", (await upgradeBody(null)).body)).status, 403);
    assert.equal((await dave.mail.post("/api/v1/keys/migrate", (await upgradeBody(stranger.priv)).body)).status, 403);
    const wrongPurpose = await upgradeBody(oldKey.priv, "device");
    assert.equal((await dave.mail.post("/api/v1/keys/migrate", wrongPurpose.body)).status, 403);
    assert.equal(L.db("mail").prepare("SELECT key_format FROM users WHERE username = ?").get(dave.u).key_format, 1);
  });

  test("sending is refused until the mailbox is upgraded", async () => {
    const r = await dave.mail.post("/api/v1/messages/send", { to_username: alice.username, sender_key_id: "x" });
    assert.equal(r.status, 409);
  });

  test("concurrent upgrades: exactly one wins, the rest get 409", async () => {
    const a = await upgradeBody(oldKey.priv);
    const b = await upgradeBody(oldKey.priv);
    const [ra, rb] = await Promise.all([dave.mail.post("/api/v1/keys/migrate", a.body), dave.mail.post("/api/v1/keys/migrate", b.body)]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
    const won = ra.status === 200 ? a : b;
    const row = L.db("mail").prepare("SELECT key_format, key_id, public_key FROM users WHERE username = ?").get(dave.u);
    assert.equal(row.key_format, 2);
    assert.equal(row.key_id, won.fresh.id);
    dave.fresh = won.fresh;
    const owner = L.db("mail").prepare("SELECT id FROM users WHERE username = ?").get(dave.u).id;
    assert.equal(L.db("mail").prepare("SELECT COUNT(*) n FROM device_keys WHERE user_id = ?").get(owner).n, 0, "old device keys removed");
  });

  test("a repeated upgrade can't go back or run twice", async () => {
    const again = await upgradeBody(oldKey.priv);
    assert.equal((await dave.mail.post("/api/v1/keys/migrate", again.body)).status, 409);
  });

  test("earlier mail opens with the old key from the new ring", async () => {
    const me = (await dave.mail.get("/api/v1/me")).body;
    const ring = await L.openRing(me, "dave new passphrase");
    assert.equal(ring.keys.length, 2);
    const old = ring.keys.find((k) => k.id !== ring.current);
    const msg = (await dave.mail.get(`/api/v1/messages/${msgId}`)).body;
    assert.equal(msg.key_id, old.id, "old messages tagged with the old key id");
    assert.match(await L.unseal(await L.importPriv(old.pkcs8), msg), /old mail before the upgrade/);
  });

  test("new mail must go to the new key; the old key id is refused", async () => {
    const recip = await L.importPub(dave.fresh.spki);
    const mine = await L.importPub(alice.key.spki);
    const r1 = await L.seal(recip, "hi");
    const body = (rk) => ({ to_username: dave.u, subject: "s", recipient_envelope: r1, sender_envelope: r1, recipient_key_id: rk, sender_key_id: alice.key.id });
    assert.equal((await alice.mail.post("/api/v1/messages/send", body(oldKey.id))).status, 409);
    assert.equal((await alice.mail.post("/api/v1/messages/send", body(dave.fresh.id))).status, 200);
    void mine;
  });

  test("a wrong passphrase or a damaged ring doesn't open", async () => {
    const me = (await dave.mail.get("/api/v1/me")).body;
    await assert.rejects(L.openRing(me, "not the passphrase"));
    const bad = { ...me, encrypted_private_key: me.encrypted_private_key.slice(0, -8) + "AAAAAAA=" };
    await assert.rejects(L.openRing(bad, "dave new passphrase"));
  });
});

describe("passphrase change, reset and Quick Unlock devices", () => {
  test("rewrap needs a key proof and the previous salt, and ends other sessions and devices", async () => {
    const m = await L.newMailbox("rw" + L.rand(), PW, PP);
    const other = new Client(URLS.mail);
    await other.post("/api/v1/login", { username: m.username, password: PW });
    const env2 = await L.sealRing([m.key], m.key.id, "a different passphrase");
    const c = await m.mail.post("/api/v1/keys/challenge", { purpose: "rewrap" });
    const proof = { challenge_id: c.body.challenge_id, challenge_answer: await L.answer(c.body.challenge, m.key.priv) };
    assert.equal((await m.mail.post("/api/v1/keys/rewrap", { envelope: env2, previous_salt: "stale", ...proof })).status, 409);
    const c2 = await m.mail.post("/api/v1/keys/challenge", { purpose: "rewrap" });
    const proof2 = { challenge_id: c2.body.challenge_id, challenge_answer: await L.answer(c2.body.challenge, m.key.priv) };
    const r = await m.mail.post("/api/v1/keys/rewrap", { envelope: env2, previous_salt: m.user.priv_salt, ...proof2 });
    assert.equal(r.status, 200);
    assert.equal((await other.get("/api/v1/me")).status, 401);
    await L.openRing(r.body.user, "a different passphrase");
  });

  test("reset needs the ID password, and 2FA when it's on", async () => {
    const u = "rs" + L.rand();
    const m = await L.newMailbox(u, PW, PP);
    const id = new Client(URLS.id);
    await id.post("/api/login", { login: u, password: PW });
    const { secret } = await L.enable2fa(id);
    const relog = new Client(URLS.mail);
    await relog.post("/api/v1/login", { username: u, password: PW, code: L.totp(secret) });
    const k = await L.newKey();
    const body = { public_key: k.spki, key_id: k.id, envelope: await L.sealRing([k], k.id, "brand new passphrase") };
    assert.equal((await relog.post("/api/v1/keys/reset", body)).status, 401, "session alone");
    assert.equal((await relog.post("/api/v1/keys/reset", { ...body, password: PW })).body.status, "totp_required");
    const r = await relog.post("/api/v1/keys/reset", { ...body, password: PW, code: L.totp(secret) });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.key_id, k.id);
    void m;
  });

  test("device enrolment needs a key proof; disabling removes every device key", async () => {
    const m = await L.newMailbox("qu" + L.rand(), PW, PP);
    const dev = "dev_" + L.rand(8) + L.rand(8) + L.rand(8);
    assert.equal((await m.mail.post("/api/v1/device-key/set", { wrapped_dek: "x.y", device_id: dev })).status, 403);
    const c = await m.mail.post("/api/v1/keys/challenge", { purpose: "device" });
    const ok = await m.mail.post("/api/v1/device-key/set", { wrapped_dek: "x.y", device_id: dev, challenge_id: c.body.challenge_id, challenge_answer: await L.answer(c.body.challenge, m.key.priv) });
    assert.equal(ok.status, 200);
    const list = await m.mail.get("/api/v1/device-key/list");
    assert.equal(list.body.devices.length, 1);
    assert.equal(list.body.devices[0].label, "Firefox · Linux");
    assert.equal((await m.mail.get(`/api/v1/device-key/get?device=${dev}`)).body.wrapped_dek, "x.y");
    assert.equal((await m.mail.post("/api/v1/quick-unlock", { enabled: false })).status, 200);
    assert.equal((await m.mail.get(`/api/v1/device-key/get?device=${dev}`)).status, 403);
    assert.equal((await m.mail.get("/api/v1/device-key/list")).body.devices.length, 0);
  });
});

describe("isolation between accounts", () => {
  test("messages: listing, reading and deleting are owner-only", async () => {
    const recip = await L.importPub(bob.key.spki);
    const e = await L.seal(recip, "for bob only");
    const s = await alice.mail.post("/api/v1/messages/send", {
      to_username: bob.username, subject: "private", recipient_envelope: e,
      sender_envelope: await L.seal(await L.importPub(alice.key.spki), "for bob only"),
      recipient_key_id: bob.key.id, sender_key_id: alice.key.id,
    });
    assert.equal(s.status, 200);
    const bobList = (await bob.mail.get("/api/v1/messages")).body.items;
    const bobMsg = bobList.find((x) => x.subject === "private");
    assert.ok(bobMsg);
    assert.ok(!(await alice.mail.get("/api/v1/messages")).body.items.some((x) => x.id === bobMsg.id), "not in alice's list");
    assert.equal((await alice.mail.get(`/api/v1/messages/${bobMsg.id}`)).status, 404);
    assert.equal((await alice.mail.post("/api/v1/messages/delete", { id: bobMsg.id })).status, 404);
    assert.equal((await bob.mail.get(`/api/v1/messages/${bobMsg.id}`)).status, 200, "still there for bob");
    assert.equal((await new Client(URLS.mail).get(`/api/v1/messages/${bobMsg.id}`)).status, 401);
  });

  test("device keys of another account can't be read with a known device id", async () => {
    const c = await bob.mail.post("/api/v1/keys/challenge", { purpose: "device" });
    const dev = "bobdev_" + L.rand(8) + L.rand(8);
    await bob.mail.post("/api/v1/device-key/set", { wrapped_dek: "bob.wrap", device_id: dev, challenge_id: c.body.challenge_id, challenge_answer: await L.answer(c.body.challenge, bob.key.priv) });
    assert.equal((await alice.mail.get(`/api/v1/device-key/get?device=${dev}`)).body.wrapped_dek, null);
  });

  test("no public account lookups: directory, availability and key lookups need a session", async () => {
    const anon = new Client(URLS.mail);
    assert.equal((await anon.get(`/api/v1/users/${alice.username}/pubkey`)).status, 401);
    assert.equal((await anon.get(`/api/v1/available?username=${alice.username}`)).status, 410);
    assert.equal((await anon.get(`/api/v1/id-status?username=${alice.username}`)).status, 410);
    assert.equal((await alice.mail.get(`/api/v1/users?q=a`)).status, 410);
    const pk = await alice.mail.get(`/api/v1/users/${bob.username}/pubkey`);
    assert.equal(pk.body.key_id, bob.key.id);
  });

  test("Temp: one inbox's token can't reach another inbox's messages or attachments", async () => {
    const t = new Client(URLS.temp);
    const a = (await t.post("/api/mailbox", {})).body;
    const b = (await t.post("/api/mailbox", {})).body;
    const id = crypto.randomUUID();
    L.db("temp").prepare(`INSERT INTO messages (id, mailbox, from_addr, to_addr, subject, text, att_count, attachments, received_at)
      VALUES (?,?,?,?,?,?,1,?,?)`).run(id, a.address, "x@example.com", a.address, "for a", "secret a", JSON.stringify([{ filename: "a.txt", contentType: "text/html", size: 3, data: "YWJj" }]), now());
    const asB = { headers: { Authorization: "Bearer " + b.token } };
    const asA = { headers: { Authorization: "Bearer " + a.token } };
    assert.equal((await t.get(`/api/messages/${id}`, asB)).status, 404);
    assert.equal((await t.get(`/api/messages/${id}/attachments/0`, asB)).status, 404);
    await t.req(`/api/messages/${id}`, { method: "DELETE", ...asB });
    assert.equal((await t.get(`/api/messages/${id}`, asA)).status, 200);
    const att = await t.req(`/api/messages/${id}/attachments/0`, { ...asA, raw: true });
    assert.equal(att.headers.get("content-type"), "application/octet-stream", "sender's type isn't served");
    assert.equal(att.headers.get("x-content-type-options"), "nosniff");
    assert.match(att.headers.get("content-security-policy"), /sandbox/);
  });
});

describe("sessions, cookies, CSRF and caching", () => {
  test("Mail session cookie is HttpOnly + SameSite=Strict and never in a body", async () => {
    const c = new Client(URLS.mail);
    const r = await c.post("/api/v1/login", { username: alice.username, password: PW });
    assert.equal(r.status, 200);
    assert.ok(!("token" in r.body));
    const ck = c.lastSetCookie.join(";");
    assert.match(ck, /HttpOnly/);
    assert.match(ck, /SameSite=Strict/);
  });

  test("logout ends the session server-side", async () => {
    const c = new Client(URLS.mail);
    await c.post("/api/v1/login", { username: alice.username, password: PW });
    const jar = new Map(c.cookies);
    assert.equal((await c.post("/api/v1/logout", {})).status, 200);
    const replay = new Client(URLS.mail);
    replay.cookies = jar;
    assert.equal((await replay.get("/api/v1/me")).status, 401);
  });

  test("a legacy Bearer token is moved into the cookie by /me only", async () => {
    const c = new Client(URLS.mail);
    await c.post("/api/v1/login", { username: alice.username, password: PW });
    const token = [...c.cookies.values()][0];
    const b = new Client(URLS.mail);
    assert.equal((await b.get("/api/v1/messages", { headers: { Authorization: "Bearer " + token } })).status, 401);
    const me = await b.get("/api/v1/me", { headers: { Authorization: "Bearer " + token } });
    assert.equal(me.status, 200);
    assert.match(b.lastSetCookie.join(";"), /HttpOnly/);
  });

  test("state-changing requests from another origin are refused", async () => {
    for (const origin of ["https://evil.example", "https://temp.inpriv.xyz", null]) {
      const r = await alice.mail.req("/api/v1/sessions/revoke-others", { method: "POST", body: {}, origin });
      assert.equal(r.status, 403, String(origin));
    }
    const id = new Client(URLS.id);
    await id.post("/api/login", { login: alice.username, password: PW });
    assert.equal((await id.req("/api/settings", { method: "POST", body: { quick_unlock: false }, origin: "https://evil.example" })).status, 403);
    const t = new Client(URLS.temp);
    assert.equal((await t.req("/api/mailbox", { method: "POST", body: {}, origin: "https://evil.example" })).status, 403);
    const adm = new Client(URLS.admin);
    assert.equal((await adm.req("/api/global", { method: "POST", body: { locked: true }, origin: "https://temp.inpriv.xyz" })).status, 403);
  });

  test("no cross-origin read access with credentials", async () => {
    const r = await fetch(URLS.mail + "/api/v1/me", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    const r2 = await fetch(URLS.id + "/api/me", { headers: { Origin: "https://anything.inpriv.xyz" } });
    assert.equal(r2.headers.get("access-control-allow-origin"), null, "no wildcard subdomains");
    const r3 = await fetch(URLS.admin + "/api/me", { headers: { Origin: "https://evil.example" } });
    assert.equal(r3.headers.get("access-control-allow-origin"), null);
  });

  test("authenticated responses are never cached", async () => {
    for (const p of ["/api/v1/me", "/api/v1/messages", "/api/v1/device-key/list"]) {
      assert.equal((await alice.mail.get(p)).headers.get("cache-control"), "no-store", p);
    }
    const t = new Client(URLS.temp);
    const mb = (await t.post("/api/mailbox", {})).body;
    assert.equal((await t.get("/api/messages", { headers: { Authorization: "Bearer " + mb.token } })).headers.get("cache-control"), "no-store");
  });

  test("ID: tokens stay out of response bodies; cookie is SameSite=Strict", async () => {
    const id = new Client(URLS.id);
    const r = await id.post("/api/login", { login: alice.username, password: PW });
    assert.equal(r.status, 200);
    assert.ok(!("token" in r.body));
    assert.match(id.lastSetCookie.join(";"), /SameSite=Strict/);
    assert.ok(!("token" in (await id.get("/api/me")).body));
  });

  test("ID: sign out everywhere also ends Mail sessions", async () => {
    const u = "ra" + L.rand();
    const m = await L.newMailbox(u, PW, PP);
    const id = new Client(URLS.id);
    await id.post("/api/login", { login: u, password: PW });
    assert.equal((await id.post("/api/sessions/revoke-all", {})).status, 200);
    assert.equal((await m.mail.get("/api/v1/me")).status, 401);
  });
});

describe("two-factor authentication on every path", () => {
  let u, secret, recovery, idc;
  before(async () => {
    u = "tfa" + L.rand();
    await L.newMailbox(u, PW, PP);
    idc = new Client(URLS.id);
    await idc.post("/api/login", { login: u, password: PW });
    ({ secret, recovery } = await L.enable2fa(idc));
  });

  test("Mail sign-in: password alone is not enough", async () => {
    const c = new Client(URLS.mail);
    const r = await c.post("/api/v1/login", { username: u, password: PW });
    assert.equal(r.body.status, "totp_required");
    assert.equal(c.cookies.size, 0);
    assert.equal((await c.post("/api/v1/login", { username: u, password: PW, code: L.wrongCode(L.totp(secret)) })).status, 401);
    assert.equal((await c.post("/api/v1/login", { username: u, password: PW, code: L.totp(secret) })).body.status, "ok");
  });

  test("recovery codes work once", async () => {
    const c = new Client(URLS.mail);
    assert.equal((await c.post("/api/v1/login", { username: u, password: PW, recovery: recovery[0] })).body.status, "ok");
    assert.equal((await new Client(URLS.mail).post("/api/v1/login", { username: u, password: PW, recovery: recovery[0] })).status, 401);
  });

  test("an ID without a mailbox gets no init ticket before the code", async () => {
    const v = "tfb" + L.rand();
    const id = await L.registerId(v, PW);
    const { secret: s2 } = await L.enable2fa(id);
    const c = new Client(URLS.mail);
    const r = await c.post("/api/v1/login", { username: v, password: PW });
    assert.equal(r.body.status, "totp_required");
    assert.ok(!r.body.init_ticket);
    const r2 = await c.post("/api/v1/login", { username: v, password: PW, code: L.totp(s2) });
    assert.equal(r2.body.status, "needs_init");
    assert.ok(r2.body.init_ticket);
  });

  test("wrong codes are limited per account, across networks", async () => {
    const v = "tfc" + L.rand();
    await L.newMailbox(v, PW, PP);
    const id = new Client(URLS.id);
    await id.post("/api/login", { login: v, password: PW });
    const { secret: s3 } = await L.enable2fa(id);
    for (let i = 0; i < 10; i++) {
      await new Client(URLS.mail).post("/api/v1/login", { username: v, password: PW, code: L.wrongCode(L.totp(s3)) });
    }
    const r = await new Client(URLS.mail).post("/api/v1/login", { username: v, password: PW, code: L.totp(s3) });
    assert.equal(r.status, 429);
  });

  test("ID 2FA sign-in: five wrong codes end that sign-in attempt", async () => {
    const c = new Client(URLS.id);
    const r = await c.post("/api/login", { login: u, password: PW });
    assert.ok(r.body.mfa_required);
    for (let i = 0; i < 5; i++) await c.post("/api/login/2fa", { mfa_token: r.body.mfa_token, code: L.wrongCode(L.totp(secret)) });
    assert.equal((await c.post("/api/login/2fa", { mfa_token: r.body.mfa_token, code: L.totp(secret) })).status, 401);
  });

  test("ID: a session can't replace a working 2FA secret", async () => {
    assert.equal((await idc.post("/api/2fa/setup", {})).status, 409);
    assert.equal((await idc.post("/api/2fa/confirm", { code: L.totp(secret) })).status, 409);
  });

  test("Quick Sign-In: grants are single-use, and an SSO ticket can't create a mailbox", async () => {
    const id = new Client(URLS.id, { origin: URLS.mail });
    await id.post("/api/login", { login: alice.username, password: PW });
    const g = await id.post("/api/grant", { service: "mail", state: "s1" });
    assert.equal(g.status, 200);
    const m = new Client(URLS.mail);
    assert.equal((await m.post("/api/v1/sso", { grant: g.body.grant, state: "other" })).status, 401, "state must match");
    const g2 = (await id.post("/api/grant", { service: "mail", state: "s2" })).body;
    assert.equal((await m.post("/api/v1/sso", { grant: g2.grant, state: "s2" })).body.status, "ok");
    assert.equal((await new Client(URLS.mail).post("/api/v1/sso", { grant: g2.grant, state: "s2" })).status, 401, "replay");

    // 2FA account: the grant yields only an sso ticket, which isn't an init ticket
    const v = "tfd" + L.rand();
    const idv = await L.registerId(v, PW);
    const { secret: s4 } = await L.enable2fa(idv);
    const idv2 = new Client(URLS.id, { origin: URLS.mail });
    const lg = await idv2.post("/api/login", { login: v, password: PW });
    await idv2.post("/api/login/2fa", { mfa_token: lg.body.mfa_token, code: L.totp(s4) });
    const g3 = (await idv2.post("/api/grant", { service: "mail", state: "s3" })).body;
    const r = await new Client(URLS.mail).post("/api/v1/sso", { grant: g3.grant, state: "s3" });
    assert.equal(r.body.status, "totp_required");
    const k = await L.newKey();
    const misuse = await new Client(URLS.mail).post("/api/v1/init-keys", { init_ticket: r.body.sso_ticket, public_key: k.spki, key_id: k.id, envelope: await L.sealRing([k], k.id, "some passphrase 12") });
    assert.equal(misuse.status, 401);
  });
});

describe("one owner per @inpriv.xyz address, never reissued", () => {
  test("concurrent Temp claims of one custom name: exactly one wins", async () => {
    const name = "race" + L.rand(6);
    const rs = await Promise.all(Array.from({ length: 8 }, () => new Client(URLS.temp).post("/api/mailbox", { local: name })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assert.ok(rs.every((r) => [201, 409].includes(r.status)));
  });

  test("Temp and ID racing for the same name: exactly one wins", async () => {
    const name = "duel" + L.rand(6);
    const [t, i] = await Promise.all([
      new Client(URLS.temp).post("/api/mailbox", { local: name }),
      new Client(URLS.id).post("/api/register", { username: name, password: PW }),
    ]);
    assert.equal([t.status === 201, i.status === 200].filter(Boolean).length, 1, `${t.status} ${i.status}`);
    const owner = L.db("id").prepare("SELECT owner FROM address_claims WHERE local = ?").get(name).owner;
    assert.equal(owner, t.status === 201 ? "temp" : "id");
  });

  test("an expired Temp address is never handed out again", async () => {
    const name = "gone" + L.rand(6);
    const t = new Client(URLS.temp);
    const mb = (await t.post("/api/mailbox", { local: name })).body;
    L.db("temp").prepare("UPDATE mailboxes SET expires_at = ? WHERE address = ?").run(now() - 1000, mb.address);
    assert.equal(await L.scheduled(URLS.temp), 200);
    await L.sleep(500);
    assert.equal(L.db("temp").prepare("SELECT COUNT(*) n FROM mailboxes WHERE address = ?").get(mb.address).n, 0, "inbox removed");
    assert.equal((await new Client(URLS.temp).post("/api/mailbox", { local: name })).status, 409);
    assert.equal((await new Client(URLS.id).post("/api/register", { username: name, password: PW })).status, 409);
    const claim = L.db("id").prepare("SELECT * FROM address_claims WHERE local = ?").get(name);
    assert.equal(claim.owner, "temp");
    assert.deepEqual(Object.keys(claim).sort(), ["claimed_on", "local", "owner"], "only the name, the kind and the day");
  });

  test("a deleted Inpriv ID's address can't be taken by Temp or a new ID", async () => {
    const u = "del" + L.rand();
    const id = await L.registerId(u, PW);
    assert.equal((await id.post("/api/account/delete", { password: PW })).status, 200);
    assert.equal((await new Client(URLS.temp).post("/api/mailbox", { local: u })).status, 409);
    assert.equal((await new Client(URLS.id).post("/api/register", { username: u, password: PW })).status, 409);
  });

  test("Temp can't claim an account, team or reserved address; the answer doesn't say which", async () => {
    for (const name of [alice.username, "support", "dmarc", "amber-fox-12"]) {
      const r = await new Client(URLS.temp).post("/api/mailbox", { local: name });
      assert.equal(r.status, 409, name);
      assert.equal(r.body.error, "That address isn't available — try another");
    }
  });

  test("the retired generator pattern and report addresses can't become IDs", async () => {
    for (const name of ["amber-fox-12", "dmarc"]) {
      const r = await new Client(URLS.id).post("/api/register", { username: name, password: PW });
      assert.equal(r.status, 400, name);
    }
  });

  test("new Temp addresses use the new pattern and are claimed", async () => {
    const mb = (await new Client(URLS.temp).post("/api/mailbox", {})).body;
    assert.match(mb.address, /^[a-z]+-[a-z]+-[a-hj-km-np-z2-9]{5}@inpriv\.xyz$/);
    const local = mb.address.split("@")[0];
    assert.equal(L.db("id").prepare("SELECT owner FROM address_claims WHERE local = ?").get(local).owner, "temp");
  });

  test("case is normalized: ALICE is alice", async () => {
    assert.equal((await new Client(URLS.temp).post("/api/mailbox", { local: alice.username.toUpperCase() })).status, 409);
    const r = await new Client(URLS.mail).post("/api/v1/login", { username: alice.username.toUpperCase() + "@INPRIV.XYZ", password: PW });
    assert.equal(r.body.status, "ok");
  });
});

describe("minimal logs and enforced retention", () => {
  test("access-log rows hold a network, a browser family and no recipient", async () => {
    const c = new Client(URLS.mail, { ip: "203.0.113.77" });
    await c.post("/api/v1/login", { username: alice.username, password: PW });
    await L.sleep(300);
    const row = L.db("id").prepare("SELECT * FROM access_log WHERE account = ? AND event = 'login' ORDER BY id DESC LIMIT 1").get(alice.username);
    assert.equal(row.ip, "203.0.113.0/24");
    assert.equal(row.ua, "Firefox · Linux");
    assert.equal(row.detail, null);
    assert.equal(row.v, 2);
    const sends = L.db("id").prepare("SELECT detail FROM access_log WHERE account = ? AND event LIKE 'send%'").all(alice.username);
    assert.ok(sends.length >= 1 && sends.every((r) => r.detail === null), "no recipients");
  });

  test("creating a Temp inbox isn't logged", async () => {
    const mb = (await new Client(URLS.temp).post("/api/mailbox", {})).body;
    const n = L.db("id").prepare("SELECT COUNT(*) n FROM access_log WHERE account = ?").get(mb.address).n;
    assert.equal(n, 0);
  });

  test("retention boundaries: 30 days for v2 rows, 90 for older rows, counters by expiry", async () => {
    const d = 86_400_000, t = now(), tag = "ret" + L.rand();
    const ins = L.db("id").prepare("INSERT INTO access_log (at, service, event, account, ip, v) VALUES (?, 'id', 'test', ?, ?, ?)");
    ins.run(t - 31 * d, tag + "-v2-31", "203.0.113.0/24", 2);
    ins.run(t - 29 * d, tag + "-v2-29", "203.0.113.0/24", 2);
    ins.run(t - 91 * d, tag + "-v1-91", "203.0.113.9", null);
    ins.run(t - 89 * d, tag + "-v1-89", "203.0.113.9", null);
    L.db("id").prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?, 1, 1, ?)").run(tag + "-old", t - 1000);
    L.db("id").prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?, 1, 1, ?)").run(tag + "-live", t + 3_600_000);
    assert.equal(await L.scheduled(URLS.temp), 200);
    await L.sleep(800);
    const left = L.db("id").prepare("SELECT account, ip FROM access_log WHERE account LIKE ?").all(tag + "%").map((r) => r.account).sort();
    assert.deepEqual(left, [tag + "-v1-89", tag + "-v2-29"]);
    const legacy = L.db("id").prepare("SELECT ip FROM access_log WHERE account = ?").get(tag + "-v1-89");
    assert.equal(legacy.ip, "203.0.113.9", "older rows stay as they are until the operator turns on ACCESS_LOG_MINIMIZE");
    const ks = L.db("id").prepare("SELECT k FROM rl_counters WHERE k LIKE ?").all(tag + "%").map((r) => r.k);
    assert.deepEqual(ks, [tag + "-live"]);
  });

  test("Mail's cron also runs the shared cleanup (if Temp's stops)", async () => {
    const tag = "ret2" + L.rand();
    L.db("id").prepare("INSERT INTO access_log (at, service, event, account, v) VALUES (?, 'id', 'test', ?, 2)").run(now() - 40 * 86_400_000, tag);
    L.db("mail").prepare("INSERT INTO rl_counters (k, bucket, c, exp) VALUES (?, 1, 1, ?)").run(tag, now() - 1000);
    const r = await fetch(URLS.mail + "/__scheduled?cron=" + encodeURIComponent("17 3 * * *"));
    assert.equal(r.status, 200);
    await L.sleep(800);
    assert.equal(L.db("id").prepare("SELECT COUNT(*) n FROM access_log WHERE account = ?").get(tag).n, 0);
    assert.equal(L.db("mail").prepare("SELECT COUNT(*) n FROM rl_counters WHERE k = ?").get(tag).n, 0);
  });
});

describe("inbound webhooks", () => {
  const event = (to) => JSON.stringify({ type: "email.received", data: { email_id: "e_" + L.rand(8), from: "Sender <s@example.com>", to: [to], subject: "hello" } });

  test("Temp: signed, fresh, once", async () => {
    const t = new Client(URLS.temp);
    const mb = (await t.post("/api/mailbox", {})).body;
    const body = event(mb.address);
    const h = L.svixHeaders(body);
    assert.equal((await fetch(URLS.temp + "/api/inbound", { method: "POST", headers: h, body })).status, 200);
    assert.equal((await fetch(URLS.temp + "/api/inbound", { method: "POST", headers: h, body })).status, 200);
    const list = await t.get("/api/messages", { headers: { Authorization: "Bearer " + mb.token } });
    assert.equal(list.body.messages.length, 1, "a replayed delivery is stored once");
    assert.equal((await fetch(URLS.temp + "/api/inbound", { method: "POST", headers: { ...h, "svix-signature": "v1,AAAA" }, body })).status, 401);
    const old = L.svixHeaders(body, { ts: Math.floor(Date.now() / 1000) - 3600 });
    assert.equal((await fetch(URLS.temp + "/api/inbound", { method: "POST", headers: old, body })).status, 400);
  });

  test("Mail: signed delivery stored once, encrypted to the current key", async () => {
    const body = event(`${alice.username}@inpriv.xyz`);
    const h = L.svixHeaders(body);
    const before = (await alice.mail.get("/api/v1/messages")).body.items.length;
    assert.equal((await fetch(URLS.mail + "/api/v1/inbound", { method: "POST", headers: h, body })).status, 200);
    const dup = await fetch(URLS.mail + "/api/v1/inbound", { method: "POST", headers: h, body });
    assert.equal((await dup.json()).duplicate, true);
    const items = (await alice.mail.get("/api/v1/messages")).body.items;
    assert.equal(items.length, before + 1);
    const msg = (await alice.mail.get(`/api/v1/messages/${items[0].id}`)).body;
    assert.equal(msg.key_id, alice.key.id);
    assert.match(await L.unseal(alice.key.priv, msg), /no readable text body/);
  });

  test("server-side HTML cleaning removes active content (HTMLRewriter)", async () => {
    const r = await fetch("http://127.0.0.1:8794/", {
      method: "POST",
      body: `<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://t.invalid"></iframe><a href="javascript:alert(1)">j</a><a href="https://ok.example">ok</a><form action="https://t.invalid"><input></form><meta http-equiv="refresh" content="0;url=https://t.invalid"><img src="https://img.example/x.png">`,
    });
    const out = await r.text();
    assert.doesNotMatch(out, /script|iframe|onclick|javascript:|<form|<input|<meta/i);
    assert.match(out, /href="https:\/\/ok\.example"/);
    assert.match(out, /img\.example/, "remote images are left for the reader to block");
  });
});

describe("security headers on every page", () => {
  for (const [name, base] of Object.entries(URLS)) {
    test(name, async () => {
      const r = await fetch(base + "/", { redirect: "manual" });
      assert.equal(r.status, 200);
      const csp = r.headers.get("content-security-policy") || "";
      const script = (csp.match(/script-src ([^;]+)/) || [])[1] || "";
      assert.match(script, /'sha256-/);
      assert.doesNotMatch(script, /unsafe-inline/);
      assert.match(csp, /frame-ancestors 'self'/);
      assert.match(csp, /object-src 'none'/);
      assert.doesNotMatch(csp, /localhost/);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.match(r.headers.get("strict-transport-security") || "", /max-age=31536000/);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    });
  }
});

describe("admin panel", () => {
  const adm = () => new Client(URLS.admin);
  // an earlier run's lockout and last code would block this run
  before(() => {
    L.db("id").prepare("CREATE TABLE IF NOT EXISTS admin_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)").run();
    L.db("id").prepare("DELETE FROM admin_kv WHERE k IN ('rl:global', 'totp:last')").run();
  });
  test("a TOTP code works once", async () => {
    const code = L.totp();
    const a = adm();
    const r = await a.post("/api/login", { user: "test-admin", code });
    assert.equal(r.status, 200);
    assert.match(a.lastSetCookie.join(";"), /__Host-inpriv_admin=.*HttpOnly.*SameSite=Strict/);
    assert.equal((await adm().post("/api/login", { user: "test-admin", code })).status, 401);
    // Records: networks, claims, and no IP behind a Temp inbox
    const rec = await a.get(`/api/records?q=${alice.username}`);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.address_claim.owner, "id");
    const ipq = await a.get("/api/records?q=203.0.113.77");
    assert.equal(ipq.body.network, "203.0.113.0/24");
    assert.ok(ipq.body.accounts_seen.includes(alice.username));
  });

  test("failed codes from many networks pause the login for everyone", async () => {
    for (let i = 0; i < 20; i++) await adm().post("/api/login", { user: "test-admin", code: L.wrongCode(L.totp()) });
    assert.equal((await adm().post("/api/login", { user: "test-admin", code: L.totp(L.TOTP_SECRET, Date.now() + 30_000) })).status, 429);
  });
});
