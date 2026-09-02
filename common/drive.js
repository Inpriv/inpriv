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

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export async function driveToken(env) {
  const nowS = Math.floor(Date.now() / 1000);
  if (_tok.v && _tok.exp - 120 > nowS) return _tok.v;
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

// Exact-name lookup → file id or null.
async function findId(env, folder, name) {
  const q = encodeURIComponent(`name = '${esc(name)}' and '${folder}' in parents and trashed = false`);
  const res = await gapi(env, `${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1`);
  const j = await res.json();
  return (j.files && j.files[0] && j.files[0].id) || null;
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
    await gapi(env, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
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
    if (id) await gapi(env, `${DRIVE_API}/files/${id}`, { method: "DELETE" });
  } catch { /* best effort, like the old .catch(() => {}) */ }
}

// Delete by file id (after kvList).
export async function kvDeleteId(env, id) {
  try { await gapi(env, `${DRIVE_API}/files/${id}`, { method: "DELETE" }); } catch {}
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
