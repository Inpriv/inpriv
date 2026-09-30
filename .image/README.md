# Inpriv Image

[image.inpriv.xyz](https://image.inpriv.xyz) — one home for the image tools:

| Tab | Was | What it does |
|---|---|---|
| Wipe | wipe.inpriv.xyz | Inspect and strip EXIF / GPS / XMP metadata |
| Compress | compress.inpriv.xyz | Resize and recompress; re-encoding also drops metadata |
| Censor | censor.inpriv.xyz | Blur, pixelate or black out regions |
| Stego | stego.inpriv.xyz | Hide / reveal data in an image |

`worker/public/index.html` is the shell (tabs + shared dropzone). Each tab is the
original single-file tool under `worker/public/m/<mode>/`, loaded in a same-origin
frame; the shell hands the chosen file(s) to the active tab with `postMessage`.
The mode pages are unchanged apart from an `?embed=1` layout tweak and a small
message listener at the end of the file. Everything runs in the browser.

Deep links: `/#wipe`, `/#compress`, `/#censor`, `/#stego`.
The old hostnames answer with a 301 to the matching tab.
