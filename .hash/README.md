# Inpriv Hash

[hash.inpriv.xyz](https://hash.inpriv.xyz) — checksums, hash reversal and encoding in one tool.

| Tab | Was | What it does |
|---|---|---|
| Hash | hash.inpriv.xyz | MD5 / SHA checksums of text and files |
| Brute | brute.inpriv.xyz | Test MD5, SHA-1/256/384/512 hashes against wordlists |
| Encode | new | Base64, Base64URL, URL, HTML entities, Hex — encode and decode |

`worker/public/index.html` is the tab shell; each tab is a single-file page under
`worker/public/m/<tab>/` loaded in a same-origin frame. The Hash and Brute pages
are the original tools with only an `?embed=1` layout tweak and a theme listener.
Everything runs in the browser.

Deep links: `/#hash`, `/#brute`, `/#encode`. `brute.inpriv.xyz` answers with a 301 to `/#brute`.
