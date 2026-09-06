// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Check — GitHub repository fetching
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// Fetches a public GitHub repo by downloading its codeload TARBALL
// (https://codeload.github.com/...) and parsing tar.gz right here on the
// edge. This deliberately avoids the api.github.com REST API for contents:
// its unauthenticated rate limit (60 req/h per IP) is nearly always
// exhausted on shared Cloudflare egress IPs, while codeload/raw have no
// such API quota. Only the tree + ~60 content requests would otherwise be
// needed; a tarball does both in ONE request.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILES = 60;
const MAX_BYTES_PER_FILE = 1_500_000; // per-file cap (1.5 MB)
const MAX_TOTAL_BYTES = 10_000_000;   // total scanned budget (10 MB)
const MAX_TARBALL_BYTES = 60_000_000; // decompressed cap (60 MB) — bail above
const TIMEOUT_MS = 30_000;
const BRANCHES = ["main", "master"];

function normalizeRepo(input) {
  // accepts: user/repo, https://github.com/user/repo, git@github.com:user/repo.git
  let s = String(input || "").trim().replace(/\.git$/, "");
  s = s.replace(/^git@github\.com:/, "").replace(/^https?:\/\/github\.com\//, "").replace(/^github\.com\//, "");
  s = s.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const parts = s.split("/");
  if (parts.length < 2 || parts.length > 3) return null;
  const [owner, repo] = parts;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

const TEXT_EXT = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "py", "sh", "bash", "ps1", "psm1",
  "bat", "cmd", "vbs", "vba", "bas", "php", "rb", "pl", "pm", "java", "c", "h", "cpp",
  "hpp", "cc", "cxx", "go", "rs", "html", "htm", "css", "sql", "md", "txt", "yml",
  "yaml", "toml", "ini", "cfg", "conf", "env", "xml", "csv", "lock", "jse", "wsf",
  "hta", "msi", "jar", "exe", "scr", "com", "pif", "lnk", "vbe",
]);
const SKIP_PATHS = /(^|\/)(node_modules|vendor|\.git|dist|build|target|\.next|\.nuxt|\.cache|bower_components|\.venv|venv|site-packages|\.gitlab|\.github|\.idea|\.vscode|__pycache__)(\/|$)/i;
const SKIP_FILES = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/i;

function isScannable(path, size) {
  if (SKIP_PATHS.test(path)) return false;
  const base = path.split("/").pop() || "";
  if (SKIP_FILES.test(base)) return false;
  const ext = path.split(".").pop().toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  return /^(dockerfile|makefile|rakefile|gemfile|justfile|\.env.*)$/i.test(base);
}

function order(p) {
  const b = p.split("/").pop().toLowerCase();
  let s = 0;
  if (/\.(ps1|bat|cmd|vbs|vba|jse|wsf|hta|scr|exe|jar|msi|sh|py|js|php)$/.test(b)) s += 4;
  if (/\.(js|ts|py|php|rb|pl|go|rs|java|c|cpp|csv|json|sql)$/.test(b)) s += 2;
  if (SKIP_PATHS.test(p)) s -= 6;
  return s;
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": "inpriv-check", Accept: "application/octet-stream" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

// ── tarball download + parse ────────────────────────────────────────────────

export async function fetchRepo(repoInput) {
  const norm = normalizeRepo(repoInput);
  if (!norm) throw new Error("Invalid GitHub repository. Use the form owner/repo or a full github.com URL.");

  let branch = null;
  for (const b of BRANCHES) {
    if (await branchExists(norm, b)) { branch = b; break; }
  }
  if (!branch) throw new Error("Repository not found or private. Only public repositories can be scanned.");

  const tarballUrl = `https://codeload.github.com/${norm.owner}/${norm.repo}/tar.gz/refs/heads/${branch}`;
  const res = await fetchWithTimeout(tarballUrl);
  if (!res.ok) throw new Error(`Could not download repository (HTTP ${res.status}).`);
  const buf = await res.arrayBuffer();
  const raw = new Uint8Array(buf);

  // decompress gzip
  let plain;
  try {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    plain = new Uint8Array(ab);
  } catch (e) {
    throw new Error("Repository archive could not be decompressed.");
  }
  if (plain.length > MAX_TARBALL_BYTES) {
    throw new Error("Repository is too large to scan (archive exceeds 60 MB decompressed).");
  }

  const entries = parseTar(plain);
  if (entries.length === 0) throw new Error("Repository appears to be empty.");

  // keep interesting files, respecting caps
  const interesting = entries
    .filter((e) => e.type === "file" && isScannable(e.name, e.size))
    .sort((a, b) => order(b.name) - order(a.name) || (a.name < b.name ? -1 : 1));

  const files = [];
  let total = 0;
  for (const e of interesting) {
    if (files.length >= MAX_FILES) break;
    if (e.size > MAX_BYTES_PER_FILE) {
      files.push({ name: e.name, code: "", skipped: "file_too_large", size: e.size });
      continue;
    }
    total += e.size;
    if (total > MAX_TOTAL_BYTES) {
      files.push({ name: e.name, code: "", skipped: "total_too_large", size: e.size });
      break;
    }
    let code = "";
    try {
      code = new TextDecoder("utf-8", { fatal: false }).decode(e.data);
    } catch {
      code = "";
    }
    if (code.length === 0 && e.size > 0) {
      files.push({ name: e.name, code: "", skipped: "binary", size: e.size });
      continue;
    }
    files.push({ name: e.name, code, size: e.size });
  }

  return {
    repo: `${norm.owner}/${norm.repo}`,
    branch,
    archived: false,
    fileCount: entries.filter((e) => e.type === "file").length,
    files,
    scanned: files.filter((f) => f.code.length > 0).length,
  };
}

async function branchExists(norm, branch) {
  try {
    const res = await fetchWithTimeout(
      `https://codeload.github.com/${norm.owner}/${norm.repo}/tar.gz/refs/heads/${branch}`
    );
    return res.ok;
  } catch {
    return false;
  }
}

// Minimal ustar parser over a Uint8Array. Returns [{name, size, type, data}].
function parseTar(buf) {
  const entries = [];
  const td = new TextDecoder("latin1");
  let off = 0;
  let longName = null;

  while (off + 512 <= buf.length) {
    // two consecutive zero blocks = end of archive
    let zero = true;
    for (let i = 0; i < 512; i++) {
      if (buf[off + i] !== 0) { zero = false; break; }
    }
    if (zero) break;

    const name = td.decode(buf.subarray(off, off + 100)).replace(/\0.*$/, "");
    const sizeStr = td.decode(buf.subarray(off + 124, off + 136)).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(buf[off + 156]);

    let realName = name;
    if (longName) { realName = longName; longName = null; }

    let data = new Uint8Array(0);
    if (type === "0" || type === "\0" || type === "L") {
      data = buf.subarray(off + 512, off + 512 + size);
    }

    if (type === "L") {
      // GNU long name: next entry inherits this name
      longName = td.decode(data).replace(/\0.*$/, "").replace(/^\.\//, "");
    } else if (type === "0" || type === "\0") {
      // strip the leading "<owner>-<repo>-<branch>/" component codeload adds
      let path = realName.replace(/^\.\//, "");
      const idx = path.indexOf("/");
      if (idx > 0) path = path.slice(idx + 1);
      entries.push({ name: path || realName, size, type: "file", data });
    }
    // '5' directories and 'x'/'g' pax headers are skipped (data consumed below)

    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// Fetch a single GitHub file by URL — via raw.githubusercontent.com (no API quota).
export async function fetchSingleFile(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/]+)\/(.+)$/);
  if (!m) throw new Error("Not a valid GitHub blob URL. Use the .../blob/<branch>/<path> form.");
  const [, owner, repo, ref, path] = m;
  const res = await fetchWithTimeout(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error("File not found (is the repository public?).");
    throw new Error(`GitHub file fetch failed (HTTP ${res.status})`);
  }
  const text = await res.text();
  return { name: path.split("/").pop(), code: text.slice(0, MAX_BYTES_PER_FILE) };
}