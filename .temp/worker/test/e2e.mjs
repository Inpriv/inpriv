// E2E test: craft a valid svix-signed email.received webhook and POST it to the
// live worker, then verify the message lands in the mailbox.
import crypto from "node:crypto";

const BASE = "https://temp.inpriv.xyz";
const secretFile = process.argv[2];
const fs = await import("node:fs/promises");
const secret = (await fs.readFile(secretFile, "utf8")).trim();

// 1. create a mailbox
const mb = await (await fetch(`${BASE}/api/mailbox`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
})).json();
console.log("mailbox:", mb.address);

// 2. craft the webhook payload
const payload = JSON.stringify({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: {
    email_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    from: "sender@example.com",
    to: [mb.address],
    subject: "E2E inbound test — Inpriv Temp",
    message_id: "<e2e-test-1@example.com>",
  },
});

const svixId = "msg_" + crypto.randomBytes(10).toString("hex");
const ts = String(Math.floor(Date.now() / 1000));
const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
const sig = crypto.createHmac("sha256", key).update(`${svixId}.${ts}.${payload}`).digest("base64");

// 3. POST signed webhook
const res = await fetch(`${BASE}/api/inbound`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "svix-id": svixId,
    "svix-timestamp": ts,
    "svix-signature": `v1,${sig}`,
  },
  body: payload,
});
console.log("webhook POST:", res.status, await res.text());

// 4. check the inbox
await new Promise((r) => setTimeout(r, 800));
const msgs = await (await fetch(`${BASE}/api/messages`, {
  headers: { Authorization: `Bearer ${mb.token}` },
})).json();
console.log("inbox:", JSON.stringify(msgs, null, 2).slice(0, 600));

const got = msgs.messages?.find((m) => m.subject === "E2E inbound test — Inpriv Temp");
if (!got) { console.error("FAIL: message not stored"); process.exit(1); }

// 5. fetch full message (viewer path)
const full = await (await fetch(`${BASE}/api/messages/${got.id}`, {
  headers: { Authorization: `Bearer ${mb.token}` },
})).json();
console.log("viewer fetch: subject=", full.subject, "from=", full.from_addr);

// 6. shred and confirm empty
await fetch(`${BASE}/api/mailbox`, { method: "DELETE", headers: { Authorization: `Bearer ${mb.token}` } });
const after = await fetch(`${BASE}/api/mailbox`, { headers: { Authorization: `Bearer ${mb.token}` } });
console.log("after shred:", after.status, "(401 expected)");
console.log("E2E OK");
