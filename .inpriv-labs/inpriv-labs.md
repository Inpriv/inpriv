# Inpriv Labs Design System

Material Design 3 with an "Earthy Forest" aesthetic. All Inpriv UI follows these
tokens and conventions. Dark theme is the default; light theme is fully supported.

## Color tokens

| Token | Light | Dark |
|---|---|---|
| `--md-primary` | `#466E47` | `#ABD37A` |
| `--md-on-primary` | `#FFFFFF` | `#173800` |
| `--md-primary-container` | `#C7EFA0` | `#2E4F2F` |
| `--md-on-primary-container` | `#0C2000` | `#C7EFA0` |
| `--md-secondary` | `#55624C` | `#BCCBAF` |
| `--md-surface` | `#FAF9F0` | `#13140E` |
| `--md-surface-container` | `#EEEDDE` | `#1F211B` |
| `--md-surface-container-high` | — | `#292B25` |
| `--md-on-surface` | `#1A1C17` | `#E3E2D3` |
| `--md-on-surface-variant` | `#43483D` | `#C3C8B6` |
| `--md-outline` | `#74796C` | `#8D9283` |
| `--md-outline-variant` | `#C3C8B6` | `#43483D` |
| `--md-error` | `#BA1A1A` | `#FFB4AB` |

Theme switching uses the `data-theme` attribute on `<html>` (`dark` is the
default state, also expressed on `:root`). The active theme is persisted in
`localStorage` under the `inpriv_theme` key.

## Typography

- **Text:** Roboto Flex — `ital,opsz,wght@0,8..144,300..800;1,8..144,300..800`
- **Icons:** Material Symbols Rounded — `opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200`
- Google Fonts CSS2 axis parameters must stay in **alphabetical order**
  (`FILL,GRAD,opsz,wght`), otherwise the request returns `400` and icon glyphs
  render as dead text.
- Icon classes must include `-webkit-font-feature-settings: 'liga';` so ligature
  names (e.g. `lock`, `mail_lock`) resolve.

## Motion

- Standard: `cubic-bezier(0.2, 0.0, 0.0, 1.0)`
- Emphasized: `cubic-bezier(0.3, 0.0, 0.0, 1.0)`
- Spring (primary brand feel, used for presses and entrances):
  `cubic-bezier(0.2, 1.4, 0, 1)` — referenced in CSS as `var(--inpriv-ease, cubic-bezier(0.2, 1.4, 0, 1))`
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
