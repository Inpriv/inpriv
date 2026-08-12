import asyncio
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
from ddgs import DDGS
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_PANEL_CONFIG = os.path.join(BASE_DIR, "..", ".panel", "config.json")

# ── Panel integration: service suspension check ───────────────────────────────

def _is_service_enabled(service_name: str) -> bool:
    """Read panel config.json and return whether the service is enabled."""
    try:
        cfg_path = os.path.normpath(_PANEL_CONFIG)
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            return cfg.get("services", {}).get(service_name, {}).get("enabled", True)
    except Exception:
        pass
    return True


_SUSPENDED_HTML = """<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0f1119">
  <title>Usługa Wstrzymana — Inpriv</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-card: rgba(24, 26, 37, 0.45);
      --text-primary: #e8eaef;
      --text-secondary: #9498a4;
      --border: rgba(255, 255, 255, 0.07);
      --radius-xl: 24px;
      --gradient-bg: linear-gradient(170deg, #0a0c14 0%, #11141f 30%, #161925 60%, #0f1119 100%);
      --status-warning: #fbbf24;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: var(--gradient-bg);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: var(--bg-card);
      backdrop-filter: blur(28px) saturate(150%);
      -webkit-backdrop-filter: blur(28px) saturate(150%);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      box-shadow: 0 4px 20px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04);
      padding: 48px 40px;
      text-align: center;
      max-width: 500px;
      width: 100%;
    }
    .icon { font-size: 48px; margin-bottom: 24px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 16px; letter-spacing: -0.5px; }
    p { color: var(--text-secondary); line-height: 1.6; font-size: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>Usługa chwilowo wstrzymana</h1>
    <p>Ta usługa została tymczasowo wyłączona przez administratora. Spróbuj ponownie później.</p>
  </div>
</body>
</html>"""

app = FastAPI(title="OSINT AI Search API")

# Thread pool for running synchronous calls (DuckDuckGo, etc.)
_thread_pool = ThreadPoolExecutor(max_workers=4)


@app.middleware("http")
async def suspension_check(request: Request, call_next):
    """Block all traffic if the osint service is disabled in panel config."""
    if not _is_service_enabled("osint"):
        if request.url.path.startswith("/api"):
            return JSONResponse(
                status_code=503,
                content={"error": "Service temporarily suspended", "status": "suspended"},
            )
        return HTMLResponse(content=_SUSPENDED_HTML, status_code=503)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
SEARXNG_URL = os.getenv("SEARXNG_URL", "http://localhost:8080")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "openai/gpt-4o-mini")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
MODELS_CACHE_TTL = int(os.getenv("MODELS_CACHE_TTL", "600"))

# Simple in-memory cache for the OpenRouter /models listing so we don't hit
# the API on every page load.
_models_cache = {"data": None, "expires_at": 0.0}


class SearchRequest(BaseModel):
    query: str
    model: str = DEFAULT_MODEL


@app.get("/")
async def read_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(os.path.join(BASE_DIR, "favicon.ico")) if os.path.exists(os.path.join(BASE_DIR, "favicon.ico")) else Response(status_code=204)


@app.get("/api/models")
async def get_models():
    now = time.time()
    if _models_cache["data"] is not None and now < _models_cache["expires_at"]:
        return _models_cache["data"]

    if not OPENROUTER_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="OPENROUTER_API_KEY is not set. Add it to your .env file.",
        )

    try:
        async with httpx.AsyncClient() as client:
            headers = {"Authorization": f"Bearer {OPENROUTER_API_KEY}"}
            res = await client.get(
                f"{OPENROUTER_BASE_URL}/models",
                headers=headers,
                timeout=15.0,
            )
            res.raise_for_status()
            payload = res.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenRouter /models error: {e}")

    models = []
    for m in payload.get("data", []):
        model_id = m.get("id")
        if not model_id:
            continue
        models.append({
            "id": model_id,
            "name": m.get("name") or model_id,
            "context_length": m.get("context_length"),
            "pricing": m.get("pricing", {}),
        })

    if not models:
        raise HTTPException(status_code=500, detail="OpenRouter returned no models.")

    default_id = (
        DEFAULT_MODEL
        if any(m["id"] == DEFAULT_MODEL for m in models)
        else models[0]["id"]
    )

    response = {"models": models, "default": default_id}
    _models_cache["data"] = response
    _models_cache["expires_at"] = now + MODELS_CACHE_TTL
    return response


@app.post("/api/search")
async def osint_search(req: SearchRequest):
    # ── Try SearXNG first, fall back to multi-query DuckDuckGo ──
    results = []
    searx_failed = False

    if SEARXNG_URL:
        searx_params = {
            "q": req.query,
            "format": "json",
            "safesearch": 0,
            "categories": "general,images,social media"
        }
        try:
            async with httpx.AsyncClient() as client:
                searx_response = await client.get(
                    f"{SEARXNG_URL}/search",
                    params=searx_params,
                    timeout=10.0
                )
                searx_response.raise_for_status()
                searx_data = searx_response.json()
                results = searx_data.get("results", [])[:15]
        except Exception:
            searx_failed = True

    if searx_failed or not results:
        try:
            loop = asyncio.get_event_loop()
            query = req.query

            # Build query variations for broader coverage
            queries = [query]
            if not query.startswith('"'):
                queries.append(f'"{query}"')
            # Social media / forum specific
            queries.append(f"({query}) (site:reddit.com OR site:twitter.com OR site:linkedin.com OR site:github.com)")

            # Run searches in parallel
            def _ddg_search(q, n):
                return list(DDGS().text(q, max_results=n))

            tasks = [
                loop.run_in_executor(_thread_pool, _ddg_search, q, 8)
                for q in queries
            ]
            all_results = await asyncio.gather(*tasks)

            # Merge and deduplicate by URL
            seen_urls = set()
            for batch in all_results:
                for r in batch:
                    url = r.get("href", "")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        results.append({
                            "title": r.get("title", ""),
                            "url": url,
                            "content": r.get("body", ""),
                        })
                        if len(results) >= 15:
                            break
                if len(results) >= 15:
                    break
        except Exception as e:
            if searx_failed:
                raise HTTPException(
                    status_code=500,
                    detail=f"SearXNG unavailable and DuckDuckGo fallback also failed: {e}",
                )
            raise HTTPException(
                status_code=500,
                detail=f"DuckDuckGo search error: {e}",
            )

    context = "\n".join([
        f"[{i+1}] Title: {r.get('title')}\nContent: {r.get('content')}\nURL: {r.get('url')}"
        for i, r in enumerate(results)
    ])

    system_prompt = (
        "You are an elite OSINT (Open Source Intelligence) analyst AI. "
        "Your task is to analyze search results about a specific person, username, entity, or topic. "
        "Produce a thorough, well-structured intelligence report using Markdown formatting. "
        "Structure your report with these sections:\n\n"
        "## Summary\n"
        "A one-paragraph high-level overview of findings.\n\n"
        "## Key Identifiers\n"
        "Usernames, emails, names, locations, affiliations — anything that identifies the target.\n\n"
        "## Digital Footprint\n"
        "Platforms, accounts, posts, mentions, and online presence found.\n\n"
        "## Affiliations & Associations\n"
        "Organizations, groups, networks, or relationships discovered.\n\n"
        "## Notable Findings\n"
        "Anything unusual, interesting, or high-signal.\n\n"
        "Cite sources using bracketed numbers [1], [2] corresponding to the provided context. "
        "Use bold for key terms and bullet lists where appropriate."
    )

    user_prompt = f"Target/Query: {req.query}\n\nGathered OSINT Data:\n{context}\n\nWrite your OSINT review:"

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8000",
        "X-Title": "OSINT AI Search"
    }

    payload = {
        "model": req.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.3
    }

    try:
        async with httpx.AsyncClient() as client:
            or_response = await client.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                json=payload,
                headers=headers,
                timeout=60.0
            )
            or_response.raise_for_status()
            or_data = or_response.json()
            ai_review = or_data["choices"][0]["message"]["content"]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenRouter API Error: {str(e)}")

    return {
        "review": ai_review,
        "sources": [
            {"title": r.get('title'), "url": r.get('url'), "content": r.get('content')}
            for r in results
        ],
        "usage": or_data.get("usage", {}),
    }


def _wait_to_close():
    """Keep the console open so double-click launchers can show errors."""
    try:
        input("\nPress Enter to close...")
    except EOFError:
        pass


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))

    try:
        print(f"[*] OSINT AI starting on http://localhost:{port} ...")
        uvicorn.run(app, host=host, port=port)
    except Exception:
        import traceback
        traceback.print_exc()
        print("\n[!] Failed to start. Common fixes:")
        print("    - pip install -r requirements.txt")
        print("    - Make sure nothing else is using the port.")
        _wait_to_close()
