// Inpriv ID — QR code generator for the 2FA setup screen.
// Runs in the browser so the TOTP secret never leaves the page.
// Byte mode, error correction level M, versions 1–40, automatic mask choice.
// Follows the structure of Project Nayuki's QR Code generator (MIT).
/* global window */
(function () {
  "use strict";

  // per-version tables for error correction level M
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  var FORMAT_ECL_M = 0;

  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  // ── Reed–Solomon over GF(2^8), polynomial 0x11D ──
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    var res = [];
    for (var i = 0; i < degree - 1; i++) res.push(0);
    res.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], root);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return res;
  }
  function rsRemainder(data, divisor) {
    var res = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ res.shift();
      res.push(0);
      divisor.forEach(function (coef, i) { res[i] ^= gfMul(coef, factor); });
    });
    return res;
  }

  function utf8(text) {
    var out = [], s = unescape(encodeURIComponent(text));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function encode(text) {
    var bytes = utf8(text);
    var ver, ccBits;
    for (ver = 1; ; ver++) {
      if (ver > 40) throw new Error("data too long for a QR code");
      ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    }
    var size = ver * 4 + 17;

    // bit stream: mode, length, data, terminator, padding
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, ccBits);
    bytes.forEach(function (b) { put(b, 8); });
    var capBits = dataCodewords(ver) * 8;
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }

    // error correction + interleaving
    var nBlocks = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver];
    var rawCw = Math.floor(rawModules(ver) / 8);
    var nShort = nBlocks - rawCw % nBlocks, shortLen = Math.floor(rawCw / nBlocks);
    var div = rsDivisor(eccLen), blocks = [];
    for (i = 0, j = 0; i < nBlocks; i++) {
      var dat = data.slice(j, j + shortLen - eccLen + (i < nShort ? 0 : 1));
      j += dat.length;
      var ecc = rsRemainder(dat, div);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var cw = [];
    for (i = 0; i < blocks[0].length; i++) {
      blocks.forEach(function (blk, k) {
        if (i !== shortLen - eccLen || k >= nShort) cw.push(blk[i]);
      });
    }

    // matrix
    var mod = [], fn = [];
    for (i = 0; i < size; i++) {
      mod.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    function setF(x, y, dark) { mod[y][x] = dark; fn[y][x] = true; }
    function finder(x, y) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
      }
    }
    function align(x, y) {
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++)
        setF(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    function formatBits(mask) {
      var d = (FORMAT_ECL_M << 3) | mask, rem = d;
      for (var k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var b = ((d << 10) | rem) ^ 0x5412;
      var bit = function (n) { return ((b >>> n) & 1) !== 0; };
      for (k = 0; k <= 5; k++) setF(8, k, bit(k));
      setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
      for (k = 9; k < 15; k++) setF(14 - k, 8, bit(k));
      for (k = 0; k < 8; k++) setF(size - 1 - k, 8, bit(k));
      for (k = 8; k < 15; k++) setF(8, size - 15 + k, bit(k));
      setF(8, size - 8, true);
    }
    function versionBits() {
      if (ver < 7) return;
      var rem = ver;
      for (var k = 0; k < 12; k++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var b = (ver << 12) | rem;
      for (k = 0; k < 18; k++) {
        var on = ((b >>> k) & 1) !== 0, a = size - 11 + k % 3, c = Math.floor(k / 3);
        setF(a, c, on); setF(c, a, on);
      }
    }
    for (i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    if (ver > 1) {
      var nA = Math.floor(ver / 7) + 2;
      var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (nA * 2 - 2)) * 2;
      var pos = [6];
      for (var p = size - 7; pos.length < nA; p -= step) pos.splice(1, 0, p);
      for (i = 0; i < nA; i++) for (j = 0; j < nA; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === nA - 1) || (i === nA - 1 && j === 0)) continue;
        align(pos[i], pos[j]);
      }
    }
    formatBits(0);
    versionBits();

    // data modules in the zig-zag order
    var bi = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (j = 0; j < 2; j++) {
          var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
          if (!fn[y][x] && bi < cw.length * 8) {
            mod[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
            bi++;
          }
        }
      }
    }

    function applyMask(m) {
      for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) {
        var inv;
        switch (m) {
          case 0: inv = (xx + yy) % 2 === 0; break;
          case 1: inv = yy % 2 === 0; break;
          case 2: inv = xx % 3 === 0; break;
          case 3: inv = (xx + yy) % 3 === 0; break;
          case 4: inv = (Math.floor(xx / 3) + Math.floor(yy / 2)) % 2 === 0; break;
          case 5: inv = xx * yy % 2 + xx * yy % 3 === 0; break;
          case 6: inv = (xx * yy % 2 + xx * yy % 3) % 2 === 0; break;
          default: inv = ((xx + yy) % 2 + xx * yy % 3) % 2 === 0;
        }
        if (!fn[yy][xx] && inv) mod[yy][xx] = !mod[yy][xx];
      }
    }
    function addHistory(len, h) { if (h[0] === 0) len += size; h.pop(); h.unshift(len); }
    function countPatterns(h) {
      var n = h[1], core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    }
    function terminate(color, len, h) {
      if (color) { addHistory(len, h); len = 0; }
      len += size;
      addHistory(len, h);
      return countPatterns(h);
    }
    function penalty() {
      var score = 0, dark = 0, a, b;
      for (var pass = 0; pass < 2; pass++) {
        for (a = 0; a < size; a++) {
          var color = false, run = 0, h = [0, 0, 0, 0, 0, 0, 0];
          for (b = 0; b < size; b++) {
            var c = pass === 0 ? mod[a][b] : mod[b][a];
            if (c === color) {
              run++;
              if (run === 5) score += 3; else if (run > 5) score++;
            } else {
              addHistory(run, h);
              if (!color) score += countPatterns(h) * 40;
              color = c; run = 1;
            }
          }
          score += terminate(color, run, h) * 40;
        }
      }
      for (a = 0; a < size - 1; a++) for (b = 0; b < size - 1; b++) {
        var cc = mod[a][b];
        if (cc === mod[a][b + 1] && cc === mod[a + 1][b] && cc === mod[a + 1][b + 1]) score += 3;
      }
      mod.forEach(function (row) { row.forEach(function (m) { if (m) dark++; }); });
      var total = size * size;
      score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return score;
    }
    var best = 0, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); formatBits(m);
      var sc = penalty();
      if (sc < bestScore) { best = m; bestScore = sc; }
      applyMask(m);
    }
    applyMask(best); formatBits(best);
    mod.mask = best;
    return mod;
  }

  // SVG with a 4-module quiet zone; dark modules in one path
  function svg(text) {
    var mod = encode(text), n = mod.length, q = 4, d = "";
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++)
      if (mod[y][x]) d += "M" + (x + q) + "," + (y + q) + "h1v1h-1z";
    var s = n + q * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + " " + s +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="' +
      d + '" fill="#000"/></svg>';
  }

  window.InprivQR = { encode: encode, svg: svg };
})();
