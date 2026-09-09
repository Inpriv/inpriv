// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Check — code & file security scanner
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// check.inpriv.xyz — paste code, upload a file or point at a GitHub repo.
// Engines:
//   • static   — built-in heuristic engine (regex + combos, ~60 rules)
//   • vt       — VirusTotal hash lookup / file upload (needs VT_API_KEY)
//   • ai       — AI review (PREPARED, disabled until API key+model supplied)
// Rate limiting is in-memory per isolate (no KV per suite convention).
// ─────────────────────────────────────────────────────────────────────────────

import { maintenanceGate, maintenancePage } from "../../../common/gate.js";
import { notFound, serverError } from "../../../common/errors.js";
import { scanFiles, rankFilesByScore, STATIC_ENGINE_INFO } from "./static-scan.js";
import { fetchRepo } from "./github.js";
import { lookupByHash, uploadBuffer, pollAnalysis } from "./virus-total.js";
import { AI_ENABLED, runAiReview } from "./ai.js";

const SERVICE_ID = "check";
const SERVICE_NAME = "Inpriv Check";
const VERSION = "1.0.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-scan-id",
};

const MAX_PASTE_BYTES = 1_500_000;      // 1.5 MB of pasted text
const MAX_UPLOAD_BYTES = 60_000_000;    // 60 MB — base64 JSON must stay under CF free 100 MB body cap
const MAX_FILES_PER_REQUEST = 40;
const MAX_B64_BYTES = 60_000_000;       // 60 MB decoded from base64 JSON

const STATIC_ONLY_HASH_BYTES = 60_000_000; // hash-first, then upload when VT doesn't know it (≤ cap)

// in-memory rate limit: {ip → [timestamps]}
const RL_WINDOW_MS = 60_000;
const RL_MAX = 10; // scans per minute per IP
const rlMap = new Map();

function rateLimited(request) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
  const now = Date.now();
  const arr = (rlMap.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) {
    rlMap.set(ip, arr);
    return true;
  }
  arr.push(now);
  rlMap.set(ip, arr);
  if (rlMap.size > 5000) {
    // crude GC
    for (const [k, v] of rlMap) if (v.length === 0) rlMap.delete(k);
  }
  return false;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

function readText(stream, max) {
  return stream.text().then((t) => (t.length > max ? Promise.reject(new Error(`Payload too large (max ${max} bytes)`)) : t));
}

function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function sha256Hex(buf) {
  return crypto.subtle.digest("SHA-256", buf).then((d) =>
    [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

// ── scan handlers ────────────────────────────────────────────────────────────

async function handleStaticScan(body) {
  const mode = body.mode || "paste"; // paste | file | github
  let files = [];

  if (mode === "paste") {
    const text = String(body.code || "");
    if (!text.trim()) throw new Error("Paste some code first.");
    files = [{ name: body.filename || "paste.txt", code: text }];
  } else if (mode === "file") {
    const entry = body.files;
    if (!entry || !Array.isArray(entry) || entry.length === 0) throw new Error("No files provided.");
    if (entry.length > MAX_FILES_PER_REQUEST) throw new Error(`Too many files (max ${MAX_FILES_PER_REQUEST}).`);
    files = entry.map((f) => {
      if (f.b64) {
        if (f.b64.length > MAX_B64_BYTES * 1.4) throw new Error("File too large.");
        const bytes = base64ToBytes(f.b64);
        return { name: f.name || "upload.bin", code: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
      }
      return { name: f.name || "upload.txt", code: String(f.code || "") };
    });
  } else if (mode === "github") {
    const repoRes = await fetchRepo(body.repo || "", body.githubToken || "");
    files = repoRes.files
      .filter((f) => f.code && f.code.length > 0)
      .map((f) => ({ name: f.name, code: f.code }));
    // attach repo metadata for the UI
    body._repoMeta = { repo: repoRes.repo, branch: repoRes.branch, archived: repoRes.archived, fileCount: repoRes.fileCount, scanned: repoRes.scanned };
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const report = scanFiles(files);
  return { engine: "static", report, repoMeta: body._repoMeta || null };
}

async function handleVtScan(body, env) {
  const mode = body.mode || "paste";
  let hash = body.sha256 || null;
  let found = null;
  let filesForUpload = null;

  // Try hash lookup first when we have bytes (client hashes before upload).
  if (body.fileB64) {
    const bytes = base64ToBytes(String(body.fileB64).replace(/\s+/g, ""));
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("File too large for VirusTotal via API (max 24 MB).");
    if (!hash) hash = await sha256Hex(bytes);
    // only proceed to upload when the hash is NOT known
    if (hash) {
      const res = await lookupByHash(hash, env.VT_API_KEY);
      if (res.found) found = res;
    }
    if (!found && bytes.length <= STATIC_ONLY_HASH_BYTES) {
      filesForUpload = { bytes, name: body.filename || "sample.bin" };
    }
  } else if (mode === "github") {
    // no client-side hashing for repos — only look up hashes we already have
    // (client sends sha256 list); anything unknown gets the static scan path.
    const h = body.sha256;
    if (h) {
      const res = await lookupByHash(h, env.VT_API_KEY);
      if (res.found) found = res;
    }
  } else if (hash) {
    const res = await lookupByHash(hash, env.VT_API_KEY);
    if (res.found) found = res;
  } else {
    throw new Error("Nothing to look up: provide a hash or a file.");
  }

  // Upload → poll
  let analysisId = null;
  if (!found && filesForUpload) {
    analysisId = await uploadBuffer(filesForUpload.bytes, filesForUpload.name, env.VT_API_KEY);
    if (!analysisId) throw new Error("VirusTotal did not return an analysis id.");
  }

  return { engine: "vt", found, analysisId, hash, uploaded: !!analysisId };
}

// ── main ─────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const gate = await maintenanceGate(SERVICE_ID);
    if (gate.locked && path !== "/api/health") {
      return path.startsWith("/api/")
        ? json({ error: "service_locked" }, 503)
        : maintenancePage(SERVICE_NAME, gate.message);
    }

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      // health
      if (path === "/api/health") {
        return json({
          service: "inpriv-check",
          version: VERSION,
          engines: { static: true, vt: !!env.VT_API_KEY, ai: AI_ENABLED },
          staticRules: STATIC_ENGINE_INFO.rules,
        });
      }

      // AI status (prepared engine)
      if (path === "/api/ai/status") {
        return json({ enabled: AI_ENABLED, configured: !!env.AI_API_KEY });
      }

      // status/info for the UI
      if (path === "/api/status" && method === "GET") {
        return json({
          service: SERVICE_NAME,
          version: VERSION,
          vtConfigured: !!env.VT_API_KEY,
          aiEnabled: AI_ENABLED,
          limits: {
            pasteBytes: MAX_PASTE_BYTES,
            uploadBytes: MAX_UPLOAD_BYTES,
            filesPerRequest: MAX_FILES_PER_REQUEST,
            vtHashOnlyAboveBytes: STATIC_ONLY_HASH_BYTES,
          },
          staticEngine: STATIC_ENGINE_INFO,
        });
      }

      // VirusTotal analysis poll (client returns to get completed results)
      if (path === "/api/vt/poll" && method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "Missing analysis id" }, 400);
        const res = await pollAnalysis(id, env.VT_API_KEY);
        return json(res);
      }

      // main scan endpoint
      if (path === "/api/scan" && method === "POST") {
        if (rateLimited(request)) return json({ error: "rate_limited", message: "Too many scans — wait a minute." }, 429, { "Retry-After": "60" });

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, 400);

        const engines = Array.isArray(body.engines) ? body.engines : ["static"];
        const out = {};
        for (const eng of engines) {
          if (eng === "static") {
            out.static = await handleStaticScan(body);
          } else if (eng === "vt") {
            if (!env.VT_API_KEY) out.vt = { engine: "vt", error: "vt_not_configured", message: "VirusTotal is not configured on this deployment yet." };
            else out.vt = await handleVtScan(body, env);
          } else if (eng === "ai") {
            if (!AI_ENABLED) out.ai = { engine: "ai", error: "ai_disabled", message: "AI review is prepared but not enabled yet — an API key and model will be wired in soon." };
            else {
              // ai needs a static report first for context
              const staticRes = out.static || await handleStaticScan(body);
              const ai = await runAiReview({ files: staticRes.report.files.map((f) => ({ name: f.path, code: f.code || "" })), report: staticRes.report, env });
              out.ai = ai;
            }
          }
        }
        return json({ ok: true, ...out });
      }

      // SEO- / docs-friendly pages
      if (path === "/api/vt/lookup" && method === "GET") {
        if (!env.VT_API_KEY) return json({ error: "vt_not_configured" }, 501);
        const h = url.searchParams.get("hash");
        if (!h || !/^[0-9a-fA-F]{32,64}$/.test(h)) return json({ error: "Provide a valid SHA-256 hash" }, 400);
        const res = await lookupByHash(h.toLowerCase(), env.VT_API_KEY);
        return json(res);
      }

      // static assets (the app itself)
      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(request);
        if (res.status === 404) return notFound(request, SERVICE_NAME);
        return res;
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return serverError(request, SERVICE_NAME, err.message || String(err));
    }
  },
};