// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Check — AI review module (OpenAI-compatible API, Mistral)
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// NOTE: the AI engine is armed; it only activates once the worker secret
//   AI_API_KEY (Mistral API key) is set and a redeploy happened. Base URL
//   defaults to https://api.mistral.ai/v1 and the model to devstral-2512
//   (fallback devstral-latest) — the optional secrets AI_BASE_URL,
//   AI_MODEL and AI_MODEL_FALLBACK can override them per deployment.
//   Until the key is set every call degrades to a friendly "not
//   configured" response — the rest of the suite never changes.
// ─────────────────────────────────────────────────────────────────────────────

export const AI_ENABLED = true;

const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_MODEL = "devstral-2512";
const FALLBACK_MODEL = "devstral-latest";
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

// Calls the OpenAI-compatible chat completions endpoint (Mistral by default).
// `files` is an array of {name, code} already trimmed by the caller.
export async function runAiReview({ files, report, env, model }) {
  const cfg = checkConfig(env);
  if (!cfg.ok) return { ok: false, ...cfg };

  const base = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const endpoint = `${base}/chat/completions`;
  const primaryModel = model || env.AI_MODEL || DEFAULT_MODEL;
  const fallbackModel = env.AI_MODEL_FALLBACK || FALLBACK_MODEL;

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

  const callChat = async (chosenModel) => {
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
      return { ok: false, status: res.status, detail: err.slice(0, 300) };
    }
    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content || "").slice(0, MAX_OUTPUT_CHARS);
    return { ok: true, status: 200, detail: "", text };
  };

  // Primary model first; on any failure retry once with the fallback model.
  let attempt;
  try {
    attempt = await callChat(primaryModel);
  } catch (e) {
    attempt = { ok: false, status: 0, detail: String(e).slice(0, 300) };
  }

  let usedModel = primaryModel;
  if (!attempt.ok && fallbackModel && fallbackModel !== primaryModel) {
    try {
      const fb = await callChat(fallbackModel);
      if (fb.ok) {
        attempt = fb;
        usedModel = fallbackModel;
      }
    } catch (e) {
      attempt = { ok: false, status: 0, detail: String(e).slice(0, 300) };
    }
  }

  if (!attempt.ok) {
    return { ok: false, code: "ai_error", message: `AI provider error (HTTP ${attempt.status})`, detail: attempt.detail };
  }
  return { ok: true, model: usedModel, provider: base, content: attempt.text };
}