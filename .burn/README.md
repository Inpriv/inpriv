# Inpriv Burn 🔥

Zero-knowledge ephemeral notes. AES-256-GCM encrypted in the browser —
the server only ever stores ciphertext. Key lives in the URL fragment (`#id.key`),
so it never touches the network.

## Architecture

- `index.html` — single-file frontend (create + read modes), M3 earthy forest design
- `worker/` — Cloudflare Worker + KV backend
  - `POST /api/notes` — store encrypted blob (TTL, optional burn-after-read)
  - `GET /api/notes/:id` — fetch blob (destroys it server-side if burn-after-read)
  - `DELETE /api/notes/:id` — manual burn
- KV keys: `note:<id>`, TTL 1h / 24h / 7d, max 30d

## Zero-knowledge guarantee

1. Client generates random `id` (16 B) and `key` (32 B)
2. Note encrypted with AES-256-GCM, `id` used as AAD (binds blob to its ID)
3. Only `{id, ciphertext}` is sent to the server
4. Link = `https://burn.inpriv.xyz/#<id>.<key>` — key never leaves the client

## Deploy

```bash
cd .burn/worker

# 1. Login (browser OAuth)
npx wrangler login

# 2. Create KV namespace, paste the ID into wrangler.toml
npx wrangler kv namespace create BURN_KV

# 3. Copy frontend into the worker's public/ dir
cp ../index.html public/index.html

# 4. Deploy
npx wrangler deploy

# 5. Custom domain (burn.inpriv.xyz) — add via dashboard or:
npx wrangler domains add burn.inpriv.xyz
```

Frontend calls same-origin `/api/notes`, so no CORS config needed once served
by the Worker on the custom domain.

## Limits (worker-enforced)

- Max note: 50 KB (client) / ~150 KB ciphertext (server)
- TTL: 60 s – 30 d
- Burn-after-read: blob deleted on first successful GET (tiny KV race window —
  two simultaneous readers could both fetch it; acceptable for v1)

MIT © 2026 Aurex Labs
