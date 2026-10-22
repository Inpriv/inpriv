// ── @inpriv.xyz address ownership (shared) ───────────────────────────────────
// Inpriv ID, Mail, Temp and the team mailboxes share one namespace. The
// authority for "who has this local part" is one table, address_claims, in
// the inpriv-id database (ID binds it as DB, Mail, Temp and admin as ID_DB).
// Its primary key makes a claim atomic: whichever INSERT lands first owns the
// name, so two services can never hand out the same address, even when the
// requests race.
//
// A claim is never deleted. An expired Temp inbox or a deleted account keeps
// its row, so the address is never given to someone else (mail meant for the
// previous holder, like password resets, must not reach a new one). A row
// holds only the local part, which kind of owner took it and the day: no
// IP address, no account id, no message data.

export const DOMAIN = "inpriv.xyz";

// Team mailboxes, read in admin.inpriv.xyz (stored by Mail's TeamMail).
export const TEAM_MAILBOXES = ["support", "abuse", "dmca", "legal", "privacy", "security", "admin", "hello"];

// Exact local parts that never become an address.
const RESERVED_LOCALS = new Set([
  "abuse", "account", "accounts", "admin", "administrator", "anonymous", "api", "auth",
  "billing", "bot", "bounce", "bounces", "burn", "contact", "dashboard", "dev", "devs",
  "dmarc", "everyone", "feedback", "hello", "help", "hi", "hostmaster", "info", "inpriv",
  "inprivlabs", "invoice", "legal", "login", "mail", "mailer-daemon", "me", "member",
  "members", "mod", "moderator", "mta-sts", "no-reply", "noreply", "null", "office",
  "operator", "owner", "payments", "postmaster", "priv", "priva", "privacy", "register",
  "root", "sales", "security", "self", "service", "services", "signin", "signup", "staff",
  "status", "support", "sysop", "system", "team", "temp", "undefined", "user", "users",
  "webmaster", "welcome", "zero",
]);

// Prefixes that never start an address: blocks "admin123" and "hello-world",
// not just exact matches. Long prefixes (4+ chars) block any continuation;
// short ones (hi, me, mx, pop…) only a separator or digit, so "mode" and
// "metal" stay free.
const RESERVED_PREFIXES = [
  "abuse", "account", "admin", "administrator", "alert", "api",
  "auth", "backup", "billing", "bot", "burn", "cert", "cluster", "contact",
  "demo", "dev", "dns", "do-not-reply", "donotreply", "everyone", "example",
  "feedback", "ftp", "gateway", "guest", "hello", "help", "hi", "hostmaster",
  "info", "inpriv", "invoice", "legal", "login", "mail", "mailer", "master",
  "me", "member", "mod", "moderator", "mx", "news", "newsletter", "noreply",
  "no-reply", "no_reply", "notify", "official", "office", "operator", "owner",
  "payment", "pop", "portal", "postmaster", "priv", "private", "public",
  "register", "root", "sales", "sample", "secure", "security", "self",
  "server", "service", "signin", "signup", "smtp", "ssl", "staff", "status",
  "support", "sysop", "team", "temp", "test", "tls", "user", "vpn", "webmaster",
  "welcome", "www", "zero",
  // team mailboxes, legal contacts, mail-authentication reports
  "dmca", "copyright", "police", "lawenforcement", "law-enforcement", "dmarc", "bounce",
];

// Words of the first Temp address generator ("amber-fox-123"). Addresses in
// that form were handed out before claims existed and most of them can't be
// listed any more, so the whole pattern is retired: no service issues one
// again. New Temp addresses use a five-character suffix (tempLocal below),
// which that generator could never produce.
const LEGACY_TEMP_ADJ = new Set([
  "amber", "ashen", "azure", "basalt", "birch", "bright", "calm", "cipher",
  "cobalt", "copper", "coral", "crimson", "dusk", "ember", "fern", "flint",
  "frost", "glade", "granite", "harbor", "indigo", "ivory", "jade", "juniper",
  "linen", "maple", "marsh", "moss", "neon", "noble", "opal", "pearl",
  "pine", "quartz", "raven", "ridge", "rift", "river", "sable", "sage",
  "slate", "spruce", "summit", "tundra", "velvet", "violet", "willow", "wren",
]);
const LEGACY_TEMP_NOUN = new Set([
  "anchor", "atlas", "badger", "beacon", "bison", "bolt", "bonsai", "breeze",
  "cactus", "canyon", "cedar", "cinder", "cliff", "cloud", "comet", "cove",
  "crane", "dune", "eagle", "echo", "falcon", "fjord", "fox", "gazelle",
  "gecko", "glacier", "hawk", "heron", "ibex", "jay", "koala", "lantern",
  "lemur", "lynx", "marten", "moth", "ocelot", "otter", "panda", "puffin",
  "quail", "raven", "rocket", "salmon", "seal", "shadow", "sparrow", "tiger",
  "urchin", "viper", "vulture", "walrus", "wolf", "zebra",
]);

export function isLegacyTempName(local) {
  const m = /^([a-z]+)-([a-z]+)-(\d{1,3})$/.exec(local);
  return !!(m && LEGACY_TEMP_ADJ.has(m[1]) && LEGACY_TEMP_NOUN.has(m[2]));
}

export function isReservedLocal(local) {
  if (RESERVED_LOCALS.has(local) || TEAM_MAILBOXES.includes(local)) return true;
  for (const p of RESERVED_PREFIXES) {
    if (!local.startsWith(p)) continue;
    if (local === p) return true;
    if (p.length >= 4) return true;
    const next = local[p.length];
    if (next === "-" || next === "." || next === "_" || (next >= "0" && next <= "9")) return true;
  }
  return isLegacyTempName(local);
}

// Lowercase, trimmed local part; "name@inpriv.xyz" becomes "name". Every
// service compares addresses in this form.
export function normalizeLocal(input) {
  let v = String(input || "").trim().toLowerCase();
  if (v.endsWith("@" + DOMAIN)) v = v.slice(0, -(DOMAIN.length + 1)).trim();
  return v;
}

// New Temp addresses: two words and five random characters from an alphabet
// without look-alikes, e.g. "ember-otter-k7m2q" (about 74 billion names).
const SUFFIX = "abcdefghjkmnpqrstuvwxyz23456789";
export function tempLocal() {
  const adj = [...LEGACY_TEMP_ADJ], noun = [...LEGACY_TEMP_NOUN];
  const r = crypto.getRandomValues(new Uint32Array(7));
  let s = "";
  for (let i = 2; i < 7; i++) s += SUFFIX[r[i] % SUFFIX.length];
  return `${adj[r[0] % adj.length]}-${noun[r[1] % noun.length]}-${s}`;
}

const today = () => new Date().toISOString().slice(0, 10);

let _ready = false;
export async function ensureClaims(db) {
  if (_ready) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS address_claims (local TEXT PRIMARY KEY, owner TEXT NOT NULL, claimed_on TEXT NOT NULL)"
  ).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT)").run();
  _ready = true;
}

// A plain INSERT for a D1 batch: if the name is already claimed the batch
// fails as a whole, so the claim and what it guards land together or not at all.
export function claimStatement(db, local, owner) {
  return db.prepare("INSERT INTO address_claims (local, owner, claimed_on) VALUES (?,?,?)").bind(local, owner, today());
}

// true when this call took the name, false when someone already holds it.
export async function tryClaim(db, local, owner) {
  await ensureClaims(db);
  const r = await db.prepare(
    "INSERT INTO address_claims (local, owner, claimed_on) VALUES (?,?,?) ON CONFLICT(local) DO NOTHING"
  ).bind(local, owner, today()).run();
  return ((r.meta && r.meta.changes) || 0) === 1;
}

export async function claimOwner(db, local) {
  await ensureClaims(db);
  const r = await db.prepare("SELECT owner FROM address_claims WHERE local = ?").bind(local).first();
  return r ? r.owner : null;
}

// One-time fill from what the inpriv-id database already knows: every
// account, every retired name and the team mailboxes. Safe to run again
// (existing claims are left alone).
export async function backfillIdClaims(db) {
  await ensureClaims(db);
  if (await db.prepare("SELECT 1 FROM app_meta WHERE k = 'claims_backfill_id_v1'").first()) return;
  const stmts = [
    db.prepare(
      "INSERT OR IGNORE INTO address_claims (local, owner, claimed_on) SELECT username, 'id', date(created_at / 1000, 'unixepoch') FROM users WHERE username IS NOT NULL"
    ),
    ...TEAM_MAILBOXES.map((t) => db.prepare(
      "INSERT INTO address_claims (local, owner, claimed_on) VALUES (?, 'team', ?) ON CONFLICT(local) DO NOTHING"
    ).bind(t, today())),
  ];
  try {
    await db.prepare("SELECT 1 FROM retired_usernames LIMIT 1").first();
    stmts.push(db.prepare(
      "INSERT OR IGNORE INTO address_claims (local, owner, claimed_on) SELECT username, 'id', date(retired_at / 1000, 'unixepoch') FROM retired_usernames"
    ));
  } catch { /* no account deleted yet */ }
  stmts.push(db.prepare("INSERT OR REPLACE INTO app_meta (k, v) VALUES ('claims_backfill_id_v1', ?)").bind(today()));
  await db.batch(stmts);
}

// Claims for a list of local parts (Temp inboxes, Mail mailboxes) found in
// another database. Chunked to stay well inside D1's statement limits.
export async function claimMany(db, locals, owner) {
  await ensureClaims(db);
  const list = [...new Set(locals.filter(Boolean))];
  for (let i = 0; i < list.length; i += 50) {
    await db.batch(list.slice(i, i + 50).map((l) => db.prepare(
      "INSERT INTO address_claims (local, owner, claimed_on) VALUES (?,?,?) ON CONFLICT(local) DO NOTHING"
    ).bind(l, owner, today())));
  }
  return list.length;
}
