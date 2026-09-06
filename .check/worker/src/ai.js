// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Check — AI review module (OpenAI-compatible API)
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// NOTE: the AI engine is armed; it only activates once the worker secrets
//   AI_API_KEY (provider key), AI_BASE_URL (OpenAI-compatible base, e.g.
//   https://api.openai.com/v1) and AI_MODEL (model id) are set and
//   a redeploy happened. Until then every call degrades to a friendly
//   "not configured" response — the rest of the suite never changes.
// ─────────────────────────────────────────────────────────────────────────────

export const AI_ENABLED = true;

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_INPUT_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 12_000;

function checkConfig(env) {
  if (!AI_ENABLED) return { ok: false, code: "ai_disabled", message: "AI review is not configured yet — it ships disabled until an AI provider is wired in. Static and VirusTotal scans are fully available." };
  if (!env.AI_API_KEY) return { ok: false, code: "ai_no_key", message: "AI_API_KEY secret is not set." };
  return { ok: true };
}

// Builds a compact, review-friendly context from a static-scan report.
export function buildContext(report) {
  const lines = [];
  lines.push(`Repository/files scanned by Inpriv Check static engine (${report.summary.files} file(s), ${report.summary.lines} lines).`);
  lines.push(`Overall heuristic verdict: ${report.verdict.toUpperCase()} (score ${report.score}).`);
  lines.push("");
  lines.push("Static findings (top 30):");
  for (const f of report.findings.slice(0, 30)) {
    lines.push(`- [${f.severity.toUpperCase()}] ${f.name} (${f.path}:${f.line}) — ${f.message}`);
  }
  if (report.findings.length === 0) lines.push("- none");
  lines.push("");
  lines.push("Please review the code below for cybersecurity issues: malware, backdoors, data exfiltration, credential theft, obfuscation, persistence, or unsafe practices. Be concise, list concrete risks with file/line references, and rate overall risk (low/medium/high/critical).");
  return lines.join("\n");
}

// Calls the OpenAI-compatible chat completions endpoint. `files` is an array of
// {name, code} already trimmed by the caller.
export async function runAiReview({ files, report, env, model }) {
  const cfg = checkConfig(env);
  if (!cfg.ok) return { ok: false, ...cfg };

  const base = (env.AI_BASE_URL || "").replace(/\/+$/, "");
  const endpoint = `${base || "https://api.openai.com/v1"}/chat/completions`;
  const chosenModel = model || env.AI_MODEL || DEFAULT_MODEL;

  // trim code to budget
  let budget = MAX_INPUT_CHARS;
  const trimmed = [];
  for (const f of files) {
    if (budget <= 0) break;
    const take = Math.min(f.code.length, budget);
    trimmed.push({ name: f.name, code: f.code.slice(0, take) });
    budget -= take;
  }

  const system = `You are a senior application-security engineer reviewing source code. You detect malware, backdoors, credential theft, data exfiltration, obfuscation, persistence mechanisms, and unsafe coding practices. React as a security reviewer: concrete, specific, brief.`;
  const user = buildContext(report) + "\n\n--- CODE START ---\n" +
    trimmed.map((f) => `### FILE: ${f.name}\n${f.code}`).join("\n\n") +
    "\n--- CODE END ---\n\nRespond with a structured markdown report: **Risk** (low/medium/high/critical), **Findings** (bullets with file:line), **Recommendations** (bullets).";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: chosenModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    const detail = err.slice(0, 300);
    return { ok: false, code: "ai_error", message: `AI provider error (HTTP ${res.status})`, detail };
  }
  const data = await res.json();
  const text = (data?.choices?.[0]?.message?.content || "").slice(0, MAX_OUTPUT_CHARS);
  return { ok: true, model: chosenModel, provider: base || "openai", content: text };
}