// ── Inpriv Drive KV (shared) ─────────────────────────────────────────────────
// Google Drive as a tiny KV store for Inpriv workers (user OAuth token).
// Each service gets one flat folder: DRIVE_PARENT / DRIVE_FOLDER_NAME
// (e.g. "inpriv/.burn"). Keys map 1:1 to file names; values are file bodies.
//
// Why: Cloudflare free KV caps at 1k writes/day. Drive allows ~1k requests
// per 100 s per user — orders of magnitude more headroom, at the cost of
// ~200–500 ms per operation (fine for notes, rooms, snapshots, admin state).
//
// All helpers take (env) and require:
//   env.DRIVE_OAUTH        — secret: {"client_id","client_secret","refresh_token"}
//   env.DRIVE_PARENT       — var: parent folder id ("inpriv" folder)
//   env.DRIVE_FOLDER_NAME  — var: service folder name (".burn", ".share", …)

const _tok = { v: null, exp: 0 }; // access token cache (per isolate)
const _folders = new Map();       // service folder id cache (per isolate)
const _fileIds = new Map();       // "folder|name" -> file id (per isolate)

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export async function driveToken(env) {
  const nowS = Math.floor(Date.now() / 1000);
  if (_tok.v && _tok.exp - 120 > nowS) return _tok.v;
  // Cross-isolate token share via the edge Cache API: tokens live 1 h, so a
  // warm cache entry saves every cold isolate a ~1 s OAuth round-trip.
  try {
    const cache = caches.default;
    const ck = new Request("https://cache.local/drive_token");
    const hit = await cache.match(ck);
    if (hit) {
      const j = await hit.json();
      if (j && j.exp - 300 > nowS) { _tok.v = j.v; _tok.exp = j.exp; return _tok.v; }
    }
  } catch {}
  let oa;
  try { oa = JSON.parse(env.DRIVE_OAUTH); } catch { throw new Error("drive_bad_oauth_secret"); }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: oa.client_id,
      client_secret: oa.client_secret,
      refresh_token: oa.refresh_token,
    }),
  });
  if (!res.ok) throw new Error("drive_oauth_refresh_failed: " + res.status);
  const d = await res.json();
  _tok.v = d.access_token;
  _tok.exp = nowS + (d.expires_in || 3600);
  try {
    const cache = caches.default;
    const ck = new Request("https://cache.local/drive_token");
    await cache.put(ck, new Response(JSON.stringify({ v: _tok.v, exp: _tok.exp }), {
      headers: { "cache-control": "public, max-age=3300" },
    }));
  } catch {}
  return _tok.v;
}

async function gapi(env, url, opts = {}) {
  const token = await driveToken(env);
  const res = await fetch(url, {
    ...opts,
    headers: { authorization: "Bearer " + token, ...(opts.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("drive_api_error: " + res.status + " " + (await res.text()).slice(0, 200));
  return res;
}

// Resolve (or lazily create) the service folder; cached per isolate.
export async function driveFolder(env) {
  const name = env.DRIVE_FOLDER_NAME;
  if (_folders.has(name)) return _folders.get(name);
  const parent = env.DRIVE_PARENT;
  const q = encodeURIComponent(
    `name = '${name}' and '${parent}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`
  );
  const res = await gapi(env, `${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1`);
  const j = await res.json();
  let id = j.files && j.files[0] && j.files[0].id;
  if (!id) {
    const cr = await gapi(env, `${DRIVE_API}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parent] }),
    });
    id = (await cr.json()).id;
  }
  _folders.set(name, id);
  return id;
}

function esc(s) { return s.replace(/'/g, "\\'"); }

// Exact-name lookup → file id or null (per-isolate cache; misses are NOT
// cached negatively so brand-new keys still resolve on the next call).
async function findId(env, folder, name) {
  const ck = folder + "|" + name;
  const hit = _fileIds.get(ck);
  if (hit !== undefined) return hit;
  const q = encodeURIComponent(`name = '${esc(name)}' and '${folder}' in parents and trashed = false`);
  const res = await gapi(env, `${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1`);
  const j = await res.json();
  const id = (j.files && j.files[0] && j.files[0].id) || null;
  if (id) _fileIds.set(ck, id);
  return id;
}

// KV-style put (create or overwrite by exact name).
// NOTE: body must be a plain STRING. A Blob body makes Workers send the
// request chunked, and Drive then stores the raw multipart text as the file
// content (the infamous "Untitled in root" bug).
export async function kvPut(env, key, value) {
  const folder = await driveFolder(env);
  const id = await findId(env, folder, key);
  const boundary = "ip" + crypto.randomUUID().replace(/-/g, "");
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: key, parents: [folder] }) +
    `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n` +
    value +
    `\r\n--${boundary}--\r\n`;
  if (id) {
    // updates: media PATCH keeps name/parents, replaces content only
    await gapi(env, `${DRIVE_UPLOAD}/files/${id}?uploadType=media`, {
      method: "PATCH",
      headers: { "content-type": "application/octet-stream" },
      body: value,
    });
  } else {
    const res = await gapi(env, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
    // cache the new id so the next get/put skips the lookup round-trip
    try {
      const nid = (await res.json()).id;
      if (nid) _fileIds.set(folder + "|" + key, nid);
    } catch {}
  }
}

// KV-style get → string or null.
export async function kvGet(env, key) {
  const folder = await driveFolder(env);
  const id = await findId(env, folder, key);
  if (!id) return null;
  const res = await gapi(env, `${DRIVE_API}/files/${id}?alt=media`);
  return res ? await res.text() : null;
}

export async function kvDelete(env, key) {
  try {
    const folder = await driveFolder(env);
    const id = await findId(env, folder, key);
    if (id) {
      await gapi(env, `${DRIVE_API}/files/${id}`, { method: "DELETE" });
      _fileIds.delete(folder + "|" + key);
    }
  } catch { /* best effort, like the old .catch(() => {}) */
  }
}

// Delete by file id (after kvList).
export async function kvDeleteId(env, id) {
  try { await gapi(env, `${DRIVE_API}/files/${id}`, { method: "DELETE" }); } catch {}
  // drop any cached id entries pointing at this file
  for (const [k, v] of _fileIds) if (v === id) _fileIds.delete(k);
}


// Media fetch by file id (use after kvList to skip the name lookup).
export async function kvGetId(env, id) {
  try {
    const res = await gapi(env, `${DRIVE_API}/files/${id}?alt=media`);
    return res ? await res.text() : null;
  } catch { return null; }
}

// List keys whose name contains `prefix` → [{ id, name }].
// Drive has no "starts with", but names are built so the prefix includes
// separators (e.g. "note_"), which keeps contains-filtering unambiguous.
export async function kvList(env, prefix) {
  const folder = await driveFolder(env);
  const q = encodeURIComponent(`'${folder}' in parents and trashed = false and name contains '${esc(prefix)}'`);
  const out = [];
  let pageToken = "";
  do {
    const res = await gapi(env, `${DRIVE_API}/files?q=${q}&fields=files(id,name),nextPageToken&pageSize=200`);
    const j = await res.json();
    for (const f of j.files || []) {
      if (f.name.startsWith(prefix)) out.push({ id: f.id, name: f.name });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}
