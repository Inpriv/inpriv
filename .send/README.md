# Inpriv Send

[send.inpriv.xyz](https://send.inpriv.xyz) — one-time notes and peer-to-peer file transfer.

| Path | Was | What it does |
|---|---|---|
| `/burn/` Note | burn.inpriv.xyz | Client-side encrypted, self-destructing note |
| `/share/` File | share.inpriv.xyz | End-to-end encrypted WebRTC file transfer |

Both are the original pages served top-level (keys stay in the URL fragment). The backends stay in
`inpriv-burn` and `inpriv-share` (own Drive credentials, secrets, sweep); this worker forwards
`/burn/api/*` and `/share/api/*` to them through service bindings.

The old hosts answer page requests with a 301 to the new path. The redirect has no fragment, so
browsers keep the original one and existing links (`burn.inpriv.xyz/#id.key`,
`share.inpriv.xyz/#code`) keep working. Their `/api/*` remains available.
