// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Check — VirusTotal integration (hash lookup + file upload + poll)
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// Three calls supported:
//   1. lookupByHash(hash) — files/JSON GET; returns the full analysis report
//      (cached by VT for up to 24h, so usually instant).
//   2. uploadBuffer(buf, filename) — POST multipart, returns analysis_id.
//   3. pollAnalysis(analysisId) — GET analyses/{id}; used after an upload
//      while VT is still scanning.
// All responses are normalized so the UI can render one shape.
// ─────────────────────────────────────────────────────────────────────────────

const VT_API = "https://www.virustotal.com/api/v3";
const VT_TIMEOUT_MS = 20_000;

function vtHeaders(apiKey) {
  return {
    "x-apikey": apiKey,
    Accept: "application/json",
    "User-Agent": "inpriv-check",
  };
}

async function vtFetch(url, apiKey, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), VT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, headers: { ...vtHeaders(apiKey), ...(opts.headers || {}) }, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Normalizes a VT "last_analysis_results" object into our rendering shape.
function normalizeReport(data) {
  const attrs = data?.attributes || {};
  const results = attrs.last_analysis_results || {};
  const stats = attrs.last_analysis_stats || { malicious: 0, suspicious: 0, harmless: 0, undetected: 0, timeout: 0, "confirmed-timeout": 0 };
  const engines = Object.entries(results)
    .map(([engine, r]) => ({
      engine,
      category: r.category,
      result: r.result === "clean" ? "clean" : r.result || r.category,
      method: r.method,
    }))
    .filter((e) => e.category !== "undetected" && e.result !== "clean" && e.result !== "unrated");

  // malicious + suspicious auto-match on known families: derive a "name"
  const names = attrs.names || (attrs.meaningful_name ? [attrs.meaningful_name] : []);
  const sha256 = attrs.sha256 || (data.id || "").replace("sha256:", "");
  const total = (stats.malicious || 0) + (stats.suspicious || 0) + (stats.harmless || 0) + (stats.undetected || 0) + (stats.timeout || 0);

  let verdict = "clean";
  if ((stats.malicious || 0) > 0) verdict = "malicious";
  else if ((stats.suspicious || 0) > 0) verdict = "suspicious";
  else if (total === 0 && attrs.status === "queued") verdict = "queued";

  return {
    sha256,
    md5: attrs.md5 || null,
    sha1: attrs.sha1 || null,
    meaningful_name: attrs.meaningful_name || null,
    names,
    size: attrs.size || 0,
    type: attrs.type_description || null,
    first_submission: attrs.first_submission_date ? new Date(attrs.first_submission_date * 1000).toISOString() : null,
    last_analysis: attrs.last_analysis_date ? new Date(attrs.last_analysis_date * 1000).toISOString() : null,
    stats,
    total,
    maliciousCount: stats.malicious || 0,
    suspiciousCount: stats.suspicious || 0,
    harmlesVsFlagged: verdict !== "clean",
    verdict,
    engines: engines.slice(0, 15),
  };
}

// 1 — hash lookup
export async function lookupByHash(hash, apiKey) {
  const res = await vtFetch(`${VT_API}/files/${encodeURIComponent(hash)}`, apiKey);
  if (res.status === 404) return { found: false, hash };
  if (!res.ok) throw new Error(`VirusTotal API error (HTTP ${res.status})`);
  const data = await res.json();
  return { found: true, hash, report: normalizeReport(data.data) };
}

// 2 — upload (multipart/form-data) → analysis id
export async function uploadBuffer(buf, filename, apiKey) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/octet-stream" }), filename || "sample");
  const res = await vtFetch(`${VT_API}/files`, apiKey, { method: "POST", body: form });
  if (res.status === 429) throw new Error("VirusTotal rate limit — try again in a minute.");
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch {}
    throw new Error(`VirusTotal upload failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = await res.json();
  return data?.data?.id || null;
}

// 3 — poll analysis
export async function pollAnalysis(analysisId, apiKey) {
  const res = await vtFetch(`${VT_API}/analyses/${encodeURIComponent(analysisId)}`, apiKey);
  if (!res.ok) throw new Error(`VirusTotal analysis poll failed (HTTP ${res.status})`);
  const data = await res.json();
  const attrs = data?.data?.attributes || {};
  const status = attrs.status || "queued";
  if (status !== "completed") return { status, completed: false };
  return { status: "completed", completed: true, report: normalizeReport(data.data) };
}

export const VIRUSTOTAL_INFO = {
  endpoint: VT_API,
  uploadLimitBytes: 650 * 1024 * 1024, // VT free cap
};