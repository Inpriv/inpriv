# Inpriv WebRTC — Interface Exposure & Leak Shield

> Enterprise WebRTC Interface Exposure Audit & Threat Intelligence Shield

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

WebRTC Audit enumerates local ICE candidates exposed by `RTCPeerConnection` and flags real local/private IP addresses that could leak through WebRTC. It opens transient peer connections against four STUN servers (Google, Cloudflare, Mozilla, Nextcloud), parses the SDP/candidates, enriches discovered IPs with ASN/threat intelligence, and compares WebRTC egress against your HTTP gateway IP to detect VPN bypass leaks. Pure client-side — it reads only its own candidates.

## Features

- **Multi-server STUN probing** — queries 4 STUN servers across different ports (19302, 3478, 443)
- **ICE candidate enumeration** — detailed table of type, protocol, IP, port, and source server
- **Public/private IP classification** — detects RFC 1918 private ranges and mDNS-masking
- **HTTP baseline comparison** — cross-references WebRTC IPs against HTTP egress IP
- **VPN/datacenter detection** — keyword engine flags known VPN/hosting providers
- **Media device audit** — enumerates cameras/microphones and checks if labels are exposed
- **Threat intelligence enrichment** — ISP, ASN, and geolocation via `ipwho.is` (fallback: `ipapi.co`)
- **JSON report export** — full audit results copied to clipboard
- **Security posture matrix** — STUN, gateway alignment, mDNS, and device exposure status

## How it works

The tool creates `RTCPeerConnection` instances with each STUN server config, adds a data channel, and triggers `createOffer()`/`setLocalDescription()`. ICE candidates are captured via `onicecandidate` and also parsed from the SDP. Each candidate string is split to extract IP, port, type, and protocol. Public IPs are enriched with IP intelligence APIs to determine ISP/ASN/location. The tool then compares WebRTC-discovered IPs against the HTTP egress IP — if WebRTC reveals a residential IP different from the VPN tunnel, a leak is flagged.

## Run locally

```bash
# Serve the suite
python -m http.server 8080
# Open http://localhost:8080/.webrtc/index.html
```

Or just open `index.html` directly in a browser — no build step required.

## Security

- ✅ Client-side only — opens its own transient peer connections, reads only its own candidates
- ✅ No `eval()`, no hardcoded secrets
- ✅ Private key handling: N/A (no crypto operations)
- ⚠️ Makes external API calls to `ipwho.is` and `ipapi.co` for IP geolocation (your IP is sent to these services by design)
- ⚠️ `innerHTML` used with API-returned data (ISP/location strings) — not directly user-controlled but worth sanitizing
- ⚠️ External font dependencies (Google Fonts: Roboto Flex + Material Symbols Rounded)
- ⚠️ No Content-Security-Policy header (consider adding a CSP `<meta>` tag)

## Tech

- Vanilla HTML/CSS/JS
- Material Design 3 (Inpriv Labs Design System)
- WebRTC API (`RTCPeerConnection`, ICE candidates, SDP parsing)
- `navigator.mediaDevices.enumerateDevices()` for device audit
- Roboto Flex + Material Symbols Rounded (Google Fonts)
