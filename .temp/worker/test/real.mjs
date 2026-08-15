// Real-delivery E2E: create a mailbox, send a REAL email to it via Resend,
// wait for the real inbound webhook, then verify the full body was fetched
// through the Received API (needs RESEND_READ_API_KEY).
// Usage: node test/real.mjs <send-key-file>  (READ_KEY env = read api key)
import fs from "node:fs/promises";

const BASE = "https://temp.inpriv.xyz";
const sendKey = (await fs.readFile(process.argv[2], "utf8")).trim();
const readKey = (process.env.READ_KEY || "").trim();

// 1. create a mailbox
const mb = await (await fetch(`${BASE}/api/mailbox`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
})).json();
console.log("mailbox:", mb.address);

// 2. send a real email TO it via Resend (from the verified domain)
const subject = "Real delivery test " + Date.now();
const sendRes = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { "Authorization": `Bearer ${sendKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    from: "Inpriv Test <test@inpriv.xyz>",
    to: [mb.address],
    subject,
    text: "Cialo testowej wiadomosci — real delivery marker RX-42.",
  }),
});
const sendJson = await sendRes.json().catch(() => ({}));
console.log("send via Resend:", sendRes.status, sendJson.id || JSON.stringify(sendJson));
if (!sendRes.ok) process.exit(1);

// 3. poll the inbox until the REAL webhook lands (up to ~2 min)
let msg = null;
for (let i = 0; i < 40 && !msg; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const msgs = await (await fetch(`${BASE}/api/messages`, {
    headers: { Authorization: `Bearer ${mb.token}` },
  })).json();
  msg = (msgs.messages || []).find((m) => m.subject === subject);
  if (!msg) process.stdout.write(".");
}
console.log("");
if (!msg) { console.error("FAIL: message never arrived via real webhook"); process.exit(1); }
console.log("REAL WEBHOOK DELIVERED:", msg.id, "| from:", msg.from_addr, "| att:", msg.att_count);

// 4. full message — is the body there (read key path)?
const full = await (await fetch(`${BASE}/api/messages/${msg.id}`, {
  headers: { Authorization: `Bearer ${mb.token}` },
})).json();
const body = full.text || full.html || full.body || "";
console.log("detail keys:", Object.keys(full).join(","));
console.log("body sample:", JSON.stringify(String(body).slice(0, 100)));
console.log(body ? "BODY OK — read key works, full content shown" : "BODY EMPTY — metadata only");
console.log("read key was:", readKey ? "provided" : "NOT provided (metadata-only expected)");

// 5. shred
const del = await fetch(`${BASE}/api/mailbox`, {
  method: "DELETE", headers: { Authorization: `Bearer ${mb.token}` },
});
console.log("shred:", del.status, del.status === 200 || del.status === 204 ? "OK" : "unexpected");
