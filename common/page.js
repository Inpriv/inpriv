// ── Inpriv server-rendered page chrome (shared) ─────────────────────────────
// Styles for the small pages Workers render themselves (404, maintenance…).
// Same tokens as common/ui/inpriv-ui.css: ink and paper, one warm accent,
// liquid glass over faint drifting letters. Standalone: no external requests.

export const LOGO_SVG =
  '<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4 18 11.4H6Z"/><path d="M6 12.6h12L12 21.6Z"/></svg>';

export const PAGE_CSS = `
:root{color-scheme:dark;--bg:#0c0c0b;--text:#f2f1ed;--text-2:rgb(242 241 237/.62);--text-3:rgb(242 241 237/.4);
--fill:rgb(255 255 255/.05);--fill-2:rgb(255 255 255/.09);--fill-3:rgb(255 255 255/.16);--hairline:rgb(255 255 255/.08);
--rim:rgb(255 255 255/.45);--spec:rgb(255 255 255/.26);--glass-tint:linear-gradient(180deg,rgb(255 255 255/.09),rgb(255 255 255/.035));
--shadow-lg:0 40px 80px -36px rgb(0 0 0/.85),0 12px 30px -16px rgb(0 0 0/.6);--accent:#ff6a2b;--solid:#f2f1ed;--ink:#0c0c0b;
--focus:rgb(242 241 237/.55);--ticker:rgb(255 255 255/.035);
--font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",Roboto,"Helvetica Neue",sans-serif;
--font-display:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI Variable Display","Segoe UI",Roboto,sans-serif;
--spring:cubic-bezier(.34,1.56,.64,1);--out:cubic-bezier(.22,1,.36,1)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#ebe9e4;--text:#141412;--text-2:rgb(20 20 18/.62);--text-3:rgb(20 20 18/.42);
--fill:rgb(255 255 255/.4);--fill-2:rgb(255 255 255/.6);--fill-3:rgb(255 255 255/.92);--hairline:rgb(20 20 18/.08);
--rim:rgb(255 255 255/.95);--spec:rgb(255 255 255/.9);--glass-tint:linear-gradient(180deg,rgb(255 255 255/.62),rgb(255 255 255/.38));
--shadow-lg:0 40px 80px -40px rgb(30 25 15/.3),0 12px 30px -18px rgb(30 25 15/.22);--accent:#e4511b;--solid:#141412;--ink:#f7f6f2;
--focus:rgb(20 20 18/.5);--ticker:rgb(20 20 18/.045)}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);
font:400 15px/1.5 var(--font);-webkit-font-smoothing:antialiased;overflow-x:hidden}
::selection{background:var(--accent);color:#fff}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.backdrop{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;display:grid;align-content:space-evenly;
color:var(--ticker);font:800 clamp(150px,34vh,380px)/.82 var(--font-display);letter-spacing:-.05em;white-space:nowrap}
.backdrop span{display:block;width:max-content;animation:drift 150s linear infinite}
.backdrop span+span{animation-duration:190s;animation-direction:reverse}
@keyframes drift{to{transform:translate3d(-50%,0,0)}}
main{width:min(100%,440px);display:flex;flex-direction:column;gap:18px}
.brand{display:inline-flex;align-items:center;gap:9px;color:var(--text);text-decoration:none;font:680 19px/1 var(--font-display);letter-spacing:-.03em}
.logo{width:22px;height:22px;fill:currentColor}
.card{position:relative;isolation:isolate;padding:26px 22px 24px;border-radius:32px;background:var(--glass-tint);
-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);
box-shadow:inset 0 1px .5px var(--spec),inset 0 -1px .5px rgb(255 255 255/.06),var(--shadow-lg);
animation:rise .6s var(--out) backwards .04s}
.card::before{content:"";position:absolute;inset:0;z-index:-1;padding:1px;border-radius:inherit;pointer-events:none;
background:linear-gradient(140deg,var(--rim),rgb(255 255 255/.1) 26%,rgb(255 255 255/.02) 50%,rgb(255 255 255/.08) 74%,rgb(255 255 255/.3));
-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
@keyframes rise{from{opacity:0;transform:translateY(10px);filter:blur(8px)}}
.code{font:800 72px/1 var(--font-display);letter-spacing:-.05em;color:var(--text-3);font-variant-numeric:tabular-nums;margin-bottom:14px}
h1{margin:0 0 8px;font:660 26px/1.12 var(--font-display);letter-spacing:-.03em;text-wrap:balance}
h1 span{color:var(--text-3)}
p{margin:0;color:var(--text-2)}
p a{color:var(--text);text-underline-offset:3px}
.msg{margin-top:14px;padding:11px 14px;border-radius:16px;background:var(--fill);box-shadow:inset 0 0 0 1px var(--hairline);color:var(--text);word-break:break-word}
.pill{display:inline-flex;align-items:center;gap:8px;margin-top:16px;height:30px;padding:0 12px;border-radius:999px;
background:var(--fill);box-shadow:inset 0 0 0 1px var(--hairline);color:var(--text-2);font-size:13px;font-weight:550}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{50%{opacity:.3}}
.actions{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap}
.btn{position:relative;isolation:isolate;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:9px;
height:52px;padding:0 22px;border:0;border-radius:999px;font-size:15.5px;font-weight:600;letter-spacing:-.01em;text-decoration:none;cursor:pointer;
transition:transform .3s var(--spring),background .2s}
.btn:active{transform:scale(.97)}
.btn-primary{flex:1;background:var(--solid);color:var(--ink);
box-shadow:inset 0 1px .5px rgb(255 255 255/.5),inset 0 -2px 5px rgb(0 0 0/.12),0 12px 26px -14px rgb(0 0 0/.7)}
.btn-glass{background:var(--fill-2);color:var(--text);box-shadow:inset 0 1px .5px var(--spec),inset 0 0 0 1px var(--hairline)}
.btn-glass:hover{background:var(--fill-3)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
@media (max-width:440px){.card{padding:22px 18px 20px;border-radius:28px}}
`;

// two rows of huge faint letters behind the card
export function backdropHtml() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const row = () => {
    let out = [];
    for (let i = 0; i < 6; i++) {
      let c = "";
      for (let j = 0; j < 4; j++) c += abc[Math.floor(Math.random() * abc.length)];
      out.push(c);
    }
    const run = out.join(" ");
    return `<span>${run} ${run}</span>`;
  };
  return `<div class="backdrop" aria-hidden="true">${row()}${row()}</div>`;
}
