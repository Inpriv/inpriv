// Before/after probes: run against the old code (main) and this branch, each
// started with tests/local.sh. Every line prints what an attacker or a
// sender can do; "safe" lines are the fixed behavior.
import * as L from "./lib.mjs";

const { URLS, Client } = L;
const PW = "account-password-1";
const out = [];
const row = (name, vulnerable, detail) => out.push(`${vulnerable ? "VULNERABLE" : "safe      "}  ${name}${detail ? "  (" + detail + ")" : ""}`);

// 1. Mail: does sign-in send the secret that locks the mailbox key?
{
  const u = "pa" + L.rand();
  await L.registerId(u, PW);
  const m = new Client(URLS.mail);
  const r = await m.post("/api/v1/login", { username: u, password: PW });
  // old flow: needs_init, then the key is sealed under this same password
  const row1 = r.body && (r.body.status === "needs_init");
  const oldFlow = !r.body.init_ticket;
  row("mailbox key is locked with the password the server receives at sign-in", row1 && oldFlow,
    oldFlow ? "no separate passphrase in the protocol" : "init needs a ticket + client-side passphrase ring");
}

// 2. account directory without signing in
{
  const r = await new Client(URLS.mail).get("/api/v1/users?q=a");
  row("anyone can list usernames", r.status === 200 && Array.isArray(r.body.users), `HTTP ${r.status}`);
}

// 3. Temp address handed out again after it expires
{
  const name = "reuse" + L.rand(6);
  const a = await new Client(URLS.temp).post("/api/mailbox", { local: name });
  L.db("temp").prepare("UPDATE mailboxes SET expires_at = ? WHERE address = ?").run(Date.now() - 1000, `${name}@inpriv.xyz`);
  await L.scheduled(URLS.temp);
  await L.sleep(500);
  const b = await new Client(URLS.temp).post("/api/mailbox", { local: name });
  row("an expired Temp address goes to the next person", a.status === 201 && b.status === 201, `second claim HTTP ${b.status}`);
}

// 4. ID 2FA: unlimited guesses per sign-in
{
  const u = "tf" + L.rand();
  const id = await L.registerId(u, PW);
  const { secret } = await L.enable2fa(id);
  const c = new Client(URLS.id);
  const lg = await c.post("/api/login", { login: u, password: PW });
  for (let i = 0; i < 8; i++) await c.post("/api/login/2fa", { mfa_token: lg.body.mfa_token, code: L.wrongCode(L.totp(secret)) });
  const r = await c.post("/api/login/2fa", { mfa_token: lg.body.mfa_token, code: L.totp(secret) });
  row("2FA codes can be guessed without limit", r.status === 200, `after 8 wrong codes: HTTP ${r.status}`);
}

// 5. cross-site request to a state-changing endpoint
{
  const r = await new Client(URLS.temp).req("/api/mailbox", { method: "POST", body: {}, origin: "https://evil.example" });
  row("another site can make state-changing requests", r.status === 201, `HTTP ${r.status}`);
}

// 6. access log: full IP linked to the account
{
  const u = "lg" + L.rand();
  await L.registerId(u, PW);
  const c = new Client(URLS.id, { ip: "203.0.113.77" });
  await c.post("/api/login", { login: u, password: PW });
  await L.sleep(300);
  const r = L.db("id").prepare("SELECT ip FROM access_log WHERE account = ? ORDER BY id DESC LIMIT 1").get(u);
  row("access log keeps the full IP address", r && r.ip === "203.0.113.77", r && r.ip);
}

// 7. security headers on the Mail page
{
  const r = await fetch(URLS.mail + "/");
  const csp = r.headers.get("content-security-policy");
  row("no security headers (CSP, HSTS, nosniff, frame-ancestors)", !csp && !r.headers.get("x-content-type-options"));
}

console.log(out.join("\n"));
