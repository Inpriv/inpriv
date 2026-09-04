# Inpriv Labs Design System

**CURRENT BASELINE (2026-09-04): Google Material 3** — the token set from
m3.material.io/get-started. Dark theme is the default; light theme fully
supported. (The previous "Earthy Forest" green look is RETIRED — it survives
only as the documented legacy experiment on labs.inpriv.xyz.)

## Color tokens

| Token | Light | Dark |
|---|---|---|
| `--md-primary` | `#9F86FF` | `#CBBEFF` |
| `--md-on-primary` | `#FFFFFF` | `#340098` |
| `--md-primary-container` | `#9F86FF` | `#4B21BD` |
| `--md-on-primary-container` | `#1E0060` | `#E6DEFF` |
| `--md-secondary` | `#5D5D74` | `#C6C4DE` |
| `--md-secondary-container` | `#DCDAF5` | `#45425C` |
| `--md-on-secondary-container` | `#21182B` | `#E2E0F1` |
| `--md-tertiary` | `#E37402` | `#FFB868` |
| `--md-tertiary-container` | `#F1D3F9` | `#4E3655` |
| `--md-on-tertiary-container` | `#271430` | `#F5D9FC` |
| `--md-surface` | `#FEFBFF` | `#141218` |
| `--md-surface-container-low` | `#F8F1F6` | `#1F1D24` |
| `--md-surface-container` | `#F2ECEE` | `#242229` |
| `--md-surface-container-high` | `#ECE7E9` | `#2F2C33` |
| `--md-surface-container-highest` | `#E6E1E3` | `#3A373F` |
| `--md-surface-container-lowest` | `#FFFFFF` | `#0F0E13` |
| `--md-on-surface` | `#1C1B1D` | `#E6E1E3` |
| `--md-on-surface-variant` | `#4D4256` | `#CBC4D4` |
| `--md-outline` | `#787579` | `#948F99` |
| `--md-outline-variant` | `#E6E1E3` | `#47464F` |
| `--md-error` | `#FF6240` | `#FF8670` |
| `--md-error-container` | `#F9DEDC` | `#93000A` |
| `--md-on-error-container` | `#490909` | `#FFDAD3` |
| `--md-inverse-surface` | `#303030` | `#E6E1E3` |
| `--md-inverse-on-surface` | `#F5EFF1` | `#303030` |
| `--md-inverse-primary` | `#4B21BD` | `#CBBDFF` |

Browser-bar / `<meta name="theme-color">`: `#141218` (dark, default) /
`#FEFBFF` (light). Legacy values `#13140E` / `#FAF9F0` must not appear.

Theme switching uses the `data-theme` attribute on `<html>` (`dark` is the
default state, also expressed on `:root`). The active theme is persisted in
`localStorage` under the suite-wide `inpriv_theme` key (id.js keeps services
in sync).

## Typography

- **Display:** Google Sans — weight 475 (self-hosted `@font-face` straight to
  `fonts.gstatic.com` URLs extracted from m3.material.io; verified 200 +
  `Access-Control-Allow-Origin: *`). Used for `.hero h1`, brand names.
- **Text:** Google Sans Text — 400 / 500 / 700, first in the
  `--font-sans` stack: `'Google Sans Text', 'Roboto Flex', system-ui, …`
  (Roboto Flex stays as the offline/fallback face).
- Weight scale is 400/475/500 (+700 for strong). Avoid 600/800 — Google uses
  few weights; use 500 where Earthy Forest used 600/700/800.
- **Icons:** Material Symbols Rounded — `opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200`
- Google Fonts CSS2 axis parameters must stay in **alphabetical order**
  (`FILL,GRAD,opsz,wght`), otherwise the request returns `400` and icon glyphs
  render as dead text.
- Icon classes must include `-webkit-font-feature-settings: 'liga';` so ligature
  names (e.g. `lock`, `mail_lock`) resolve.
- **CSP:** pages that self-declare gstatic `@font-face` need
  `font-src … https://fonts.gstatic.com` (hush needed this fix).

## Shapes & elevation

- Cards: `border-radius: 24px`, white (`#FFFFFF`) in light with M3 elevation-1
  shadow `0 1px 2px 0 rgb(0 0 0 / 30%), 0 1px 3px 1px rgb(0 0 0 / 15%)`;
  `--md-surface-container-low`-style tint in dark (no hard shadows).
- Pills/buttons stay full-radius (`9999px`).
- The Earthy Forest backdrop (dot grid `.bg-dots` + drifting `.bg-blob`) is
  RETIRED — plain flat surfaces now.

## Motion

- Standard: `cubic-bezier(0.2, 0.0, 0.0, 1.0)`
- Emphasized: `cubic-bezier(0.3, 0.0, 0.0, 1.0)`
- Spring (presses/entrances): `cubic-bezier(0.2, 1.4, 0, 1)` —
  `var(--inpriv-ease, cubic-bezier(0.2, 1.4, 0, 1))`
- Spring soft: `cubic-bezier(0.34, 1.3, 0.64, 1.0)`
- Press feedback: `transform: scale(0.985)` on interactive cards.

## Component conventions

- Single-file tools: all tokens inline in `:root`, no external CSS.
- App bars / headers on mobile (<600px): floating glass pill — sticky, inset 12px,
  full radius, `backdrop-filter: blur(24px) saturate(180%)`, hairline
  `--md-outline-variant` border, spring entrance animation.
- Mobile-first interactive apps (Mail, Hush): bottom navigation with
  `env(safe-area-inset-bottom)` padding and touch targets of at least 48px.
- No emoji in rendered UI — use inline SVG or Material Symbols glyphs.
- Placeholders stay generic (`username`, `yourname@inpriv.xyz`) — never personal data.

## Accessibility & hygiene

- Every multi-view stylesheet carries the global guard
  `[hidden] { display: none !important; }` so the `hidden` attribute always wins
  over component `display:` rules.
- Theme persistence failures are non-fatal (wrapped in `try/catch`).

## Legacy — M3 Earthy Forest (RETIRED, do not build on this)

Forest-green on warm paper (light) / near-black with soft green (dark),
Roboto Flex everywhere, dot-grid + blob backdrop. Key values for reference
(mirrors the legacy experiment card on labs.inpriv.xyz):
primary `#466E47`/`#ABD37A`, on-primary `#FFFFFF`/`#173800`, surface
`#FAF9F0`/`#13140E`, containers `#F4F3E9 #EEEDE2 #E8E7DB` (light) /
`#1A1C17 #1E201A #282A24` (dark), on-surface `#1A1C17`/`#E3E2D3`,
outline `#75796B`/`#8D9283`, outline-variant `#C5C8B8`/`#43483D`,
tertiary `#9C4231`/`#FFB4A5`.
