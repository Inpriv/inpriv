// Inpriv QR API — Free, no-auth QR code generation API
// GET /api/qr?data=<text>&format=svg|png&ec=L|M|Q|H&size=256&margin=4&fg=000000&bg=ffffff
// Copyright (c) 2026 Aurex Labs — MIT License

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const HEX_RE = /^[0-9a-fA-F]{6}$/;

const QRCodeLib = (function () {
      "use strict";
      const GF256 = (function () {
        const exp = new Uint16Array(512), log = new Uint16Array(256);
        let x = 1;
        for (let i = 0; i < 255; i++) { exp[i] = x; exp[i + 255] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
        return { exp, log, mul(a, b) { return a && b ? exp[log[a] + log[b]] : 0; } };
      })();
      function rsRemainder(data, divisor) {
        const result = divisor.map(function(){return 0;});
        for (const b of data) {
          const factor = b ^ result.shift();
          result.push(0);
          for (let i = 0; i < divisor.length; i++) result[i] ^= GF256.mul(divisor[i], factor);
        }
        return result;
      }
      function rsDivisor(degree) {
        const result = new Array(degree).fill(0);
        result[degree - 1] = 1;
        let root = 1;
        for (let i = 0; i < degree; i++) {
          for (let j = 0; j < degree; j++) {
            result[j] = GF256.mul(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
          }
          root = GF256.mul(root, 0x02);
        }
        return result;
      }
      const ECC_CODEWORDS_PER_BLOCK = [
        [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
        [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
        [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
        [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
      ];
      const NUM_EC_BLOCKS = [
        [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
        [-1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
        [-1,1,1,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
        [-1,1,1,2,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
      ];
      function blockLayout(version, ecOrd) {
        const numBlocks = NUM_EC_BLOCKS[ecOrd][version];
        const eccpb = ECC_CODEWORDS_PER_BLOCK[ecOrd][version];
        const rawModules = (function(v){let r=(16*v+128)*v+64;if(v>=2){const na=Math.floor(v/7)+2;r-=(25*na-10)*na-55;if(v>=7)r-=36;}return r;})(version);
        const totalDataCw = Math.floor(rawModules/8) - eccpb*numBlocks;
        const longDataCw = Math.ceil(totalDataCw / numBlocks);
        const numShort = numBlocks*longDataCw - totalDataCw;
        const shortDataCw = longDataCw - 1;
        return { numBlocks: numBlocks, numShort: numShort, longDataCw: longDataCw, shortDataCw: shortDataCw, eccpb: eccpb };
      }

      const ALIGN = {"1":[],"2":[6,18],"3":[6,22],"4":[6,26],"5":[6,30],"6":[6,34],"7":[6,22,38],"8":[6,24,42],"9":[6,26,46],"10":[6,28,50],"11":[6,30,54],"12":[6,32,58],"13":[6,34,62],"14":[6,26,46,66],"15":[6,26,48,70],"16":[6,26,50,74],"17":[6,30,54,78],"18":[6,30,56,82],"19":[6,30,58,86],"20":[6,34,62,90],"21":[6,28,50,72],"22":[6,26,50,74],"23":[6,30,54,78],"24":[6,28,54,80],"25":[6,32,58,84],"26":[6,30,58,86],"27":[6,34,62,90],"28":[6,26,50,74,98],"29":[6,30,54,78,102],"30":[6,26,52,78,104],"31":[6,30,56,82,108],"32":[6,34,60,86,112],"33":[6,30,58,86,114],"34":[6,34,62,90,118],"35":[6,30,54,78,102],"36":[6,24,50,76,102],"37":[6,28,54,80,106],"38":[6,32,58,84,110],"39":[6,26,54,82,110],"40":[6,30,58,86,114]};
      const BYTECAP = {"1":{"L":17,"M":14,"Q":11,"H":7},"2":{"L":32,"M":26,"Q":20,"H":14},"3":{"L":53,"M":42,"Q":32,"H":24},"4":{"L":78,"M":62,"Q":46,"H":34},"5":{"L":106,"M":84,"Q":60,"H":44},"6":{"L":134,"M":106,"Q":74,"H":58},"7":{"L":154,"M":122,"Q":86,"H":64},"8":{"L":192,"M":152,"Q":108,"H":84},"9":{"L":230,"M":180,"Q":130,"H":98},"10":{"L":271,"M":213,"Q":151,"H":119},"11":{"L":321,"M":251,"Q":177,"H":137},"12":{"L":367,"M":287,"Q":203,"H":155},"13":{"L":425,"M":331,"Q":241,"H":177},"14":{"L":458,"M":362,"Q":258,"H":194},"15":{"L":520,"M":412,"Q":292,"H":220},"16":{"L":586,"M":450,"Q":322,"H":250},"17":{"L":644,"M":504,"Q":364,"H":280},"18":{"L":718,"M":560,"Q":394,"H":310},"19":{"L":792,"M":624,"Q":442,"H":338},"20":{"L":858,"M":666,"Q":482,"H":382},"21":{"L":929,"M":711,"Q":509,"H":403},"22":{"L":1003,"M":779,"Q":565,"H":439},"23":{"L":1091,"M":857,"Q":611,"H":461},"24":{"L":1171,"M":911,"Q":661,"H":511},"25":{"L":1273,"M":997,"Q":715,"H":535},"26":{"L":1367,"M":1059,"Q":751,"H":593},"27":{"L":1465,"M":1125,"Q":805,"H":625},"28":{"L":1528,"M":1190,"Q":868,"H":658},"29":{"L":1628,"M":1264,"Q":908,"H":698},"30":{"L":1732,"M":1370,"Q":982,"H":742},"31":{"L":1840,"M":1452,"Q":1030,"H":790},"32":{"L":1952,"M":1538,"Q":1112,"H":842},"33":{"L":2068,"M":1628,"Q":1168,"H":898},"34":{"L":2188,"M":1722,"Q":1228,"H":958},"35":{"L":2303,"M":1809,"Q":1283,"H":983},"36":{"L":2431,"M":1911,"Q":1351,"H":1051},"37":{"L":2563,"M":1989,"Q":1423,"H":1093},"38":{"L":2699,"M":2099,"Q":1499,"H":1139},"39":{"L":2809,"M":2213,"Q":1579,"H":1219},"40":{"L":2953,"M":2331,"Q":1663,"H":1273}};
      const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
      function getSize(v){return 17+4*v;}
      function formatBits(ecLevel, mask){const ec=EC_BITS[ecLevel]!=null?EC_BITS[ecLevel]:1;let data=(ec<<3)|mask,g=0x537,rem=data<<10;for(let i=4;i>=0;i--){if(rem&(1<<(i+10)))rem^=g<<i;}return ((data<<10)|rem)^0x5412;}
      function versionBits(v){let data=v<<12,g=0x1F25,rem=data;for(let i=5;i>=0;i--){if(rem&(1<<(i+12)))rem^=g<<i;}return (data|rem);}

      const MASK_FNS = [
        function(x,y){return (x+y)%2===0;},
        function(x,y){return y%2===0;},
        function(x){return x%3===0;},
        function(x,y){return (x+y)%3===0;},
        function(x,y){return (Math.floor(x/3)+Math.floor(y/2))%2===0;},
        function(x,y){return ((x*y)%2)+((x*y)%3)===0;},
        function(x,y){return (((x*y)%2)+((x*y)%3))%2===0;},
        function(x,y){return (((x+y)%2)+((x*y)%3))%2===0;}
      ];

      // FIXED encodeQR – corrected eccpb property access
      function encodeQR(text, ecLevel) {
        ecLevel = (ecLevel && EC_BITS[ecLevel] != null) ? ecLevel : 'M';
        const ecOrd = { L: 0, M: 1, Q: 2, H: 3 }[ecLevel];
        const bytes = new TextEncoder().encode(text);
        let version = 1;
        for (; version <= 40; version++) { if (bytes.length <= BYTECAP[version][ecLevel]) break; }
        if (version > 40) version = 40;
        const size = getSize(version);
        const m = Array(size).fill(0).map(function(){return Array(size).fill(false);});
        const isFn = Array(size).fill(0).map(function(){return Array(size).fill(false);});
        function setFunctionModule(x,y,v){if(0<=x&&x<size&&0<=y&&y<size){m[y][x]=!!v;isFn[y][x]=true;}}

        for (let i = 0; i < 3; i++) {
          const fx = i===0?0:(i===1?size-7:0), fy = i===0?0:(i===1?0:size-7);
          for (let dy = -1; dy <= 7; dy++) {
            for (let dx = -1; dx <= 7; dx++) {
              const x = fx+dx, y = fy+dy;
              if (0<=x&&x<size&&0<=y&&y<size) {
                let dark = false;
                if (dx>=0&&dx<=6&&dy>=0&&dy<=6) dark = (dx===0||dx===6||dy===0||dy===6||(dx>=2&&dx<=4&&dy>=2&&dy<=4));
                setFunctionModule(x, y, dark);
              }
            }
          }
        }
        for (let i = 0; i < size; i++) {
          if (!isFn[6][i]) setFunctionModule(i, 6, i%2===0);
          if (!isFn[i][6]) setFunctionModule(6, i, i%2===0);
        }
        setFunctionModule(8, size-8, true);
        for (let i = 0; i < 9; i++) { isFn[8][i] = true; isFn[i][8] = true; }
        for (let i = 0; i < 8; i++) { isFn[8][size-1-i] = true; isFn[size-1-i][8] = true; }
        const alignPat = ALIGN[version];
        for (let i = 0; i < alignPat.length; i++) {
          for (let j = 0; j < alignPat.length; j++) {
            const cx = alignPat[i], cy = alignPat[j];
            if ((cx===6 && cy===6) || (cx===6 && cy===size-7) || (cx===size-7 && cy===6)) continue;
            setFunctionModule(cx-2, cy-2, true);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) setFunctionModule(cx+dx, cy+dy, dx===0&&dy===0);
            setFunctionModule(cx+2, cy-2, true);
            for (let k = -2; k <= 2; k++) { setFunctionModule(cx-2, cy+k, true); setFunctionModule(cx+2, cy+k, true); setFunctionModule(cx+k, cy-2, true); setFunctionModule(cx+k, cy+2, true); }
          }
        }
        if (version >= 7) {
          for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { isFn[size-11+j][i] = true; isFn[i][size-11+j] = true; }
        }

        const cc = version <= 9 ? 8 : 16;
        const bb = [];
        function appendBits(val, len) { for (let i = len-1; i >= 0; i--) bb.push((val >>> i) & 1); }
        appendBits(0x4, 4);
        appendBits(bytes.length, cc);
        for (const b of bytes) appendBits(b, 8);
        const bl = blockLayout(version, ecOrd);
        const totalDataCw = bl.shortDataCw * bl.numShort + (bl.numBlocks - bl.numShort) * bl.longDataCw;
        const capBits = totalDataCw * 8;
        appendBits(0, Math.min(4, capBits - bb.length));
        while (bb.length % 8 !== 0) bb.push(0);
        for (let pi = 0; bb.length < capBits; pi = (pi+1)%2) appendBits(pi===0?0xEC:0x11, 8);
        const dataCW = new Array(bb.length/8);
        for (let i = 0; i < dataCW.length; i++) { let v=0; for (let j=0;j<8;j++) v=(v<<1)|bb[i*8+j]; dataCW[i]=v; }

        // ★ FIX: use correct property name 'eccpb'
        const eccpb = bl.eccpb;
        if (eccpb == null || isNaN(eccpb) || eccpb < 1) {
          throw new Error('Invalid ECC codeword count: ' + eccpb);
        }
        const divisor = rsDivisor(eccpb);
        const blocks = [];
        let off = 0;
        for (let k = 0; k < bl.numBlocks; k++) {
          const dlen = (k < bl.numShort) ? bl.shortDataCw : bl.longDataCw;
          const dat = dataCW.slice(off, off+dlen); off += dlen;
          const ec = rsRemainder(dat, divisor);
          blocks.push({ data: dat, ec: ec });
        }
        const all = [];
        for (let i = 0; i < bl.longDataCw; i++) for (const b of blocks) if (i < b.data.length) all.push(b.data[i]);
        for (let i = 0; i < eccpb; i++) for (const b of blocks) all.push(b.ec[i]);

        let bi = 0;
        for (let right = size-1; right >= 1; right -= 2) {
          if (right === 6) right = 5;
          for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
              const x = right - j;
              const upward = ((right + 1) & 2) === 0;
              const y = upward ? size-1-vert : vert;
              if (!isFn[y][x] && bi < all.length*8) { m[y][x] = ((all[bi>>>3] >>> (7-(bi&7))) & 1) !== 0; bi++; }
            }
          }
        }

        let bestMask = 0, bestPenalty = Infinity;
        function penaltyScore(cm) {
          let result = 0;
          for (let y = 0; y < size; y++) {
            let runColor = false, runLength = 0;
            for (let x = 0; x < size; x++) {
              if (cm[y][x] === runColor) { runLength++; if (runLength === 5) result += 3; else if (runLength > 5) result++; }
              else { runColor = cm[y][x]; runLength = 1; }
            }
          }
          for (let x = 0; x < size; x++) {
            let runColor = false, runLength = 0;
            for (let y = 0; y < size; y++) {
              if (cm[y][x] === runColor) { runLength++; if (runLength === 5) result += 3; else if (runLength > 5) result++; }
              else { runColor = cm[y][x]; runLength = 1; }
            }
          }
          for (let y = 0; y < size-1; y++) for (let x = 0; x < size-1; x++) {
            const c = cm[y][x]; if (cm[y][x+1]===c && cm[y+1][x]===c && cm[y+1][x+1]===c) result += 3;
          }
          for (let y = 0; y < size; y++) for (let x = 0; x+6 < size; x++) {
            if (cm[y][x+0] && !cm[y][x+1] && cm[y][x+2] && cm[y][x+3] && cm[y][x+4] && !cm[y][x+5] && cm[y][x+6]) result += 40;
          }
          for (let x = 0; x < size; x++) for (let y = 0; y+6 < size; y++) {
            if (cm[y+0][x] && !cm[y+1][x] && cm[y+2][x] && cm[y+3][x] && cm[y+4][x] && !cm[y+5][x] && cm[y+6][x]) result += 40;
          }
          let dark = 0; for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (cm[y][x]) dark++;
          result += Math.floor(Math.abs(dark*20 - size*size*10) / size) * 10;
          return result;
        }
        for (let mk = 0; mk < 8; mk++) {
          const cm = m.map(function(r){return r.slice();});
          const mf = MASK_FNS[mk];
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && mf(x,y)) cm[y][x] = !cm[y][x];
          const p = penaltyScore(cm);
          if (p < bestPenalty) { bestPenalty = p; bestMask = mk; }
        }
        const mf = MASK_FNS[bestMask];
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && mf(x,y)) m[y][x] = !m[y][x];

        const fb = formatBits(ecLevel, bestMask);
        for (let i = 0; i <= 5; i++) m[i][8] = ((fb >>> i) & 1) !== 0;
        m[7][8] = ((fb >>> 6) & 1) !== 0;
        m[8][8] = ((fb >>> 7) & 1) !== 0;
        m[8][7] = ((fb >>> 8) & 1) !== 0;
        for (let i = 9; i < 15; i++) m[8][14-i] = ((fb >>> i) & 1) !== 0;
        for (let i = 0; i < 8; i++) m[8][size-1-i] = ((fb >>> i) & 1) !== 0;
        for (let i = 8; i < 15; i++) m[size-15+i][8] = ((fb >>> i) & 1) !== 0;

        if (version >= 7) {
          const vb = versionBits(version);
          for (let i = 0; i < 18; i++) {
            const bit = ((vb >>> i) & 1) !== 0;
            const a = size-11 + i%3, b = i/3 | 0;
            m[b][a] = bit;
            m[a][b] = bit;
          }
        }

        const modules = m.map(function(r){return r.map(function(v){return v?1:0;});});
        return { size: size, modules: modules, version: version };
      }

      function drawToCanvas(canvas, text, opts) {
        opts = opts || {};
        const qr = encodeQR(text, opts.ecLevel || 'M');
        const cell = opts.cell || 6, margin = opts.margin || 4;
        const total = qr.size + margin * 2;
        canvas.width = total * cell; canvas.height = total * cell;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = opts.bg || '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = opts.fg || '#000000';
        for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) ctx.fillRect((x + margin) * cell, (y + margin) * cell, cell, cell);
        return qr;
      }

      function toSVG(text, opts) {
        opts = opts || {};
        const qr = encodeQR(text, opts.ecLevel || 'M');
        const margin = opts.margin || 4;
        const total = qr.size + margin * 2;
        let rects = '';
        for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) rects += '<rect x="' + (x + margin) + '" y="' + (y + margin) + '" width="1" height="1"/>';
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges"><rect width="' + total + '" height="' + total + '" fill="#ffffff"/><g fill="#000000">' + rects + '</g></svg>';
      }

      return { encode: encodeQR, draw: drawToCanvas, toSVG: toSVG };
    })();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ─── GET /api/qr — generate QR code ───
    if (path === "/api/qr" || path === "/qr") {
      const data = url.searchParams.get("data");
      if (!data) {
        return json({ error: "Missing 'data' parameter", usage: "/api/qr?data=<text>&format=svg|png&ec=M&size=256&margin=4&fg=000000&bg=ffffff" }, 400);
      }
      if (data.length > 2000) {
        return json({ error: "Data too long (max 2000 chars)" }, 400);
      }

      const format = (url.searchParams.get("format") || "svg").toLowerCase();
      const ec = (url.searchParams.get("ec") || "M").toUpperCase();
      const margin = Math.min(Math.max(parseInt(url.searchParams.get("margin"), 10) || 4, 0), 20);
      const fg = HEX_RE.test(url.searchParams.get("fg") || "") ? url.searchParams.get("fg") : "000000";
      const bg = HEX_RE.test(url.searchParams.get("bg") || "") ? url.searchParams.get("bg") : "ffffff";

      const validEC = ["L", "M", "Q", "H"].includes(ec) ? ec : "M";
      const validFormat = ["svg", "png"].includes(format) ? format : "svg";

      try {
        if (validFormat === "svg") {
          const svg = generateSVG(data, validEC, margin, fg, bg);
          return new Response(svg, {
            status: 200,
            headers: {
              "Content-Type": "image/svg+xml",
              "Cache-Control": "public, max-age=86400, s-maxage=604800",
              ...CORS,
            },
          });
        } else {
          const png = generatePNG(data, validEC, margin, fg, bg, 8);
          return new Response(png, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=86400, s-maxage=604800",
              ...CORS,
            },
          });
        }
      } catch (e) {
        return json({ error: "Generation failed: " + e.message }, 500);
      }
    }

    // ─── Health check ───
    if (path === "/api/health" || path === "/") {
      return json({
        service: "inpriv-qr-api",
        version: "1.0.0",
        endpoints: {
          "GET /api/qr": "Generate QR code",
          "params": {
            "data": "Text to encode (required)",
            "format": "svg (default) | png",
            "ec": "L | M (default) | Q | H",
            "margin": "0-20, default 4",
            "size": "PNG only, default 256",
            "fg": "hex color without #, default 000000",
            "bg": "hex color without #, default ffffff",
          },
        },
        limits: { "max_data_length": 2000 },
      });
    }

    return json({ error: "Not found" }, 404);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function generateSVG(text, ecLevel, margin, fg, bg) {
  const qr = QRCodeLib.encode(text, ecLevel);
  const total = qr.size + margin * 2;
  let rects = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) {
        rects += "<rect x=\"" + (x + margin) + "\" y=\"" + (y + margin) + "\" width=\"1\" height=\"1\"/>";
      }
    }
  }
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + total + " " + total + "\" shape-rendering=\"crispEdges\"><rect width=\"" + total + "\" height=\"" + total + "\" fill=\"#" + bg + "\"/><g fill=\"#" + fg + "\"><rect x=\"0\" y=\"0\" width=\"" + total + "\" height=\"" + total + "\" fill=\"#" + bg + "\"/>" + rects + "</g></svg>";
}

function generatePNG(text, ecLevel, margin, fg, bg, scale) {
  const qr = QRCodeLib.encode(text, ecLevel);
  const total = qr.size + margin * 2;
  const width = total * scale;
  const height = total * scale;

  // Build raw RGBA pixel data
  const pixels = new Uint8Array(width * height * 4);
  const fgR = parseInt(fg.slice(0, 2), 16), fgG = parseInt(fg.slice(2, 4), 16), fgB = parseInt(fg.slice(4, 6), 16);
  const bgR = parseInt(bg.slice(0, 2), 16), bgG = parseInt(bg.slice(2, 4), 16), bgB = parseInt(bg.slice(4, 6), 16);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const qx = Math.floor(px / scale) - margin;
      const qy = Math.floor(py / scale) - margin;
      const dark = qx >= 0 && qy >= 0 && qx < qr.size && qy < qr.size && qr.modules[qy][qx];
      const idx = (py * width + px) * 4;
      pixels[idx] = dark ? fgR : bgR;
      pixels[idx + 1] = dark ? fgG : bgG;
      pixels[idx + 2] = dark ? fgB : bgB;
      pixels[idx + 3] = 255;
    }
  }

  return encodePNG(pixels, width, height);
}

// ─── Minimal PNG encoder (uncompressed, zlib stored blocks) ───
function encodePNG(rgba, width, height) {
  const enc = new PNGEncoder(width, height);
  return enc.encode(rgba);
}

function PNGEncoder(width, height) {
  this.width = width;
  this.height = height;
}

PNGEncoder.prototype.encode = function(rgba) {
  // PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];

  // IHDR
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, this.width);
  dv.setUint32(4, this.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw scanlines with filter byte (0 = None)
  const rowLen = this.width * 4;
  const raw = new Uint8Array((rowLen + 1) * this.height);
  for (let y = 0; y < this.height; y++) {
    raw[y * (rowLen + 1)] = 0; // filter: None
    raw.set(rgba.subarray(y * rowLen, (y + 1) * rowLen), y * (rowLen + 1) + 1);
  }

  // zlib stored blocks
  const compressed = zlibStored(raw);

  // Build chunks
  const chunks = [];
  chunks.push(makeChunk("IHDR", ihdr));
  chunks.push(makeChunk("IDAT", compressed));
  chunks.push(makeChunk("IEND", new Uint8Array(0)));

  // Assemble
  let totalLen = sig.length;
  for (const c of chunks) totalLen += c.length;
  const out = new Uint8Array(totalLen);
  let off = 0;
  out.set(sig, off); off += sig.length;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};

function makeChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 0; i < 4 + data.length; i++) {
    crc ^= chunk[4 + i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  dv.setUint32(8 + data.length, crc ^ 0xffffffff);
  return chunk;
}

function zlibStored(data) {
  // zlib header
  const header = new Uint8Array([0x78, 0x01]);
  // Stored blocks (uncompressed)
  const blocks = [];
  let off = 0;
  const maxBlock = 65535;
  while (off < data.length) {
    const remaining = data.length - off;
    const blockLen = Math.min(remaining, maxBlock);
    const isLast = (off + blockLen >= data.length) ? 1 : 0;
    const block = new Uint8Array(5 + blockLen);
    block[0] = isLast;
    block[1] = blockLen & 0xff;
    block[2] = (blockLen >> 8) & 0xff;
    const inv = ~blockLen & 0xffff;
    block[3] = inv & 0xff;
    block[4] = (inv >> 8) & 0xff;
    block.set(data.subarray(off, off + blockLen), 5);
    blocks.push(block);
    off += blockLen;
  }
  // Adler-32 checksum
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = new Uint8Array(4);
  adler[0] = (b >> 8) & 0xff; adler[1] = b & 0xff;
  adler[2] = (a >> 8) & 0xff; adler[3] = a & 0xff;

  let totalLen = header.length;
  for (const blk of blocks) totalLen += blk.length;
  totalLen += adler.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  out.set(header, pos); pos += header.length;
  for (const blk of blocks) { out.set(blk, pos); pos += blk.length; }
  out.set(adler, pos);
  return out;
}
