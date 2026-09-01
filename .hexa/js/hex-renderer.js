/* =====================================================================
   hex-renderer.js — Inpriv Hexa art engine
   Copyright (c) 2026 Inpriv Labs — MIT License
   Pure hexagon design. Your text is hashed into a deterministic seed,
   which paints a symmetric honeycomb pattern inside a single big hexagon.
   No square grid, no finder blocks, no QR pixels — just hexagons.
   ===================================================================== */
(function (global) {
  "use strict";

  const SQRT3 = Math.sqrt(3);
  const ANIM_MAX = 600; // above this, batch into one path

  /* ---------- tiny numeric helpers ---------- */
  const f2 = (n) => (Math.round(n * 100) / 100).toString();
  const f3 = (n) => (Math.round(n * 1000) / 1000).toString();

  function shade(hex, amt) {
    const c = hex.replace("#", "");
    const n = parseInt(c.length === 3 ? c.split("").map((x) => x + x).join("") : c, 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r * (1 - amt)); g = Math.round(g * (1 - amt)); b = Math.round(b * (1 - amt));
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function tint(hex, amt) {
    const c = hex.replace("#", "");
    const n = parseInt(c.length === 3 ? c.split("").map((x) => x + x).join("") : c, 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * amt); g = Math.round(g + (255 - g) * amt); b = Math.round(b + (255 - b) * amt);
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  /* ---------- deterministic PRNG (xmur3 seed → sfc32) ---------- */
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21 | c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  function makeRng(text) {
    const seeder = xmur3(text || " ");
    return sfc32(seeder(), seeder(), seeder(), seeder());
  }

  /* ---------- hexagon geometry (pointy-top, flat-top helpers) ---------- */
  // Pointy-top vertices for circumradius R, centered at origin.
  function hexVerts(R) {
    const v = [];
    for (let i = 0; i < 6; i++) {
      const a = (-90 + 60 * i) * Math.PI / 180;
      v.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    return v;
  }
  // Flat-top polygon points string at (cx,cy), circumradius R.
  function flatHexPoints(cx, cy, R) {
    let pts = "";
    for (let i = 0; i < 6; i++) {
      const a = (60 * i) * Math.PI / 180;
      pts += f2(cx + Math.cos(a) * R) + "," + f2(cy + Math.sin(a) * R) + " ";
    }
    return pts.trim();
  }
  // Rounded polygon path 'd' for vertices + round amount (0..1).
  function unit(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }
  function roundedPolygon(verts, roundAmt) {
    const n = verts.length;
    let minEdge = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      minEdge = Math.min(minEdge, Math.hypot(verts[j][0] - verts[i][0], verts[j][1] - verts[i][1]));
    }
    const r = Math.max(0, roundAmt) * minEdge / 2;
    let d = "";
    for (let i = 0; i < n; i++) {
      const p0 = verts[(i - 1 + n) % n], p1 = verts[i], p2 = verts[(i + 1) % n];
      const v1 = unit(p0[0] - p1[0], p0[1] - p1[1]);
      const v2 = unit(p2[0] - p1[0], p2[1] - p1[1]);
      const ax = p1[0] + v1[0] * r, ay = p1[1] + v1[1] * r;
      const bx = p1[0] + v2[0] * r, by = p1[1] + v2[1] * r;
      d += (i === 0 ? "M" : "L") + f2(ax) + " " + f2(ay) + " ";
      d += "Q" + f2(p1[0]) + " " + f2(p1[1]) + " " + f2(bx) + " " + f2(by) + " ";
    }
    return d + "Z";
  }
  // translate an absolute path 'd' by (tx,ty)
  function translatePath(d, tx, ty) {
    let out = "";
    const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
    const cmds = d.match(/[MLQZ]/gi);
    let ni = 0;
    for (let k = 0; k < cmds.length; k++) {
      const c = cmds[k];
      if (c === "Z") continue;
      if (c === "Q") {
        const x1 = parseFloat(nums[ni++]), y1 = parseFloat(nums[ni++]), x2 = parseFloat(nums[ni++]), y2 = parseFloat(nums[ni++]);
        out += "Q" + f2(x1 + tx) + " " + f2(y1 + ty) + " " + f2(x2 + tx) + " " + f2(y2 + ty) + " ";
      } else {
        const x1 = parseFloat(nums[ni++]), y1 = parseFloat(nums[ni++]);
        out += c + f2(x1 + tx) + " " + f2(y1 + ty) + " ";
      }
    }
    return out + "Z";
  }

  /* =====================================================================
     Hexagon grid built around axial coordinates (q,r).
     We render a big hexagonal silhouette ("hex of hexes") and paint the
     cells inside it. Pointy-top cells, offset rows.
     ===================================================================== */
  function cellCenter(q, r, R) {
    // pointy-top axial → pixel
    const x = R * SQRT3 * (q + r / 2);
    const y = R * 1.5 * r;
    return [x, y];
  }

  // Build the set of axial cells whose centers fall inside a big hexagon of
  // circumradius (cellCount * R), centered at origin. "radius" = number of
  // cells from center to a corner.
  function bigHexCellList(radius) {
    const cells = [];
    for (let q = -radius; q <= radius; q++) {
      const r1 = Math.max(-radius, -q - radius);
      const r2 = Math.min(radius, -q + radius);
      for (let r = r1; r <= r2; r++) {
        cells.push([q, r]);
      }
    }
    return cells; // count = 3*radius*(radius+1)+1
  }

  /* ---------- the main render ---------- */
  function render(svg, opts) {
    const o = Object.assign({
      text: " ",
      style: "crystal",   // crystal | spiral | rings | cluster
      density: 3,         // maps to hexagon "radius" (rows)
      stroke: 1.2,
      fill: 0.82,         // hex cell size ratio
      round: 0.35,
      colors: { primary: "#466E47", accent: "#9C4231", surface: "#FAF9F0" },
      logo: { on: false, dataUrl: "", isImg: false },
      animate: true
    }, opts || {});

    const text = o.text || " ";
    const rng = makeRng(text);

    // Map density (slider 0..2 → 4..6..8) onto hexagon radius in cells.
    const radius = [4, 6, 8][Math.max(0, Math.min(2, o.density | 0))] || 6;
    const totalCells = 3 * radius * (radius + 1) + 1;

    // Working canvas (later scaled to a 1000-unit viewBox).
    const R = 26;                 // nominal cell circumradius
    const colPitch = SQRT3 * R;   // pointy-top width per cell
    const rowPitch = 1.5 * R;

    const cells = bigHexCellList(radius);

    // ---------- choose which cells are "on" ----------
    // We generate a pattern in the right half (q >= 0) then mirror to q < 0
    // so every output is left/right symmetric and looks designed.
    const on = new Map();         // "q,r" -> boolean
    const half = cells.filter(([q]) => q >= 0);

    // mirror function applied after we decide the right half
    function commit(q, r, val) {
      on.set(q + "," + r, val);
      on.set(-q + "," + r, val);          // mirror across vertical axis
    }

    if (o.style === "rings") {
      // Concentric hexagonal rings, alternating on/off, with seeded jitter.
      for (const [q, r] of half) {
        const dist = hexDist(q, r);
        let val = (dist % 2 === 0);
        // seed-based jitter so it's not perfectly regular
        if (dist > 0 && dist < radius && rng() < 0.18) val = !val;
        commit(q, r, val);
      }
    } else if (o.style === "spiral") {
      // Cells "on" based on angle + distance → spiral arms.
      for (const [q, r] of half) {
        const [x, y] = cellCenter(q, r, R);
        const ang = Math.atan2(y, x);
        const dist = Math.hypot(x, y) / R;
        const arm = Math.sin(ang * 3 + dist * 0.9 + rng() * 0.4);
        commit(q, r, arm > 0.15);
      }
    } else if (o.style === "cluster") {
      // Seed a few growth centers; cells near them light up → organic blobs.
      const centers = [];
      const nCenters = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < nCenters; i++) {
        const cq = Math.round(rng() * radius * 0.7);
        const cr = Math.round((rng() * 2 - 1) * radius * 0.7);
        centers.push([cq, cr, 1.6 + rng() * 1.8]);
      }
      for (const [q, r] of half) {
        let best = Infinity;
        for (const [cq, cr, reach] of centers) {
          const d = hexDist(q - cq, r - cr) / reach;
          if (d < best) best = d;
        }
        commit(q, r, best < 1);
      }
    } else {
      // "crystal" (default): seeded density with a radial falloff so the
      // middle is richer and the edges breathe — looks crystalline.
      for (const [q, r] of half) {
        const dist = hexDist(q, r) / radius;            // 0 center .. 1 edge
        const falloff = 0.62 - dist * 0.28;             // ~0.62 .. ~0.34
        const jitter = (rng() - 0.5) * 0.22;
        commit(q, r, rng() < falloff + jitter);
      }
    }

    // Always guarantee a crisp center cell + an outline ring frame.
    on.set("0,0", true);
    for (const [q, r] of cells) {
      if (hexDist(q, r) === radius) on.set(q + "," + r, true); // outer ring
    }

    // ---------- geometry → viewBox ----------
    // Compute bounds of all cell centers, expand by hex half-extent.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const halfW = colPitch / 2, halfH = R;
    for (const [q, r] of cells) {
      const [x, y] = cellCenter(q, r, R);
      minX = Math.min(minX, x - halfW); maxX = Math.max(maxX, x + halfW);
      minY = Math.min(minY, y - halfH); maxY = Math.max(maxY, y + halfH);
    }
    const gridW = maxX - minX, gridH = maxY - minY;
    const pad = R * 1.4;
    const side = Math.max(gridW, gridH) + pad * 2;
    const offX = (side - gridW) / 2 - minX;
    const offY = (side - gridH) / 2 - minY;

    const primary = o.colors.primary;
    const accent = o.colors.accent;
    const surface = o.colors.surface;
    const strokeColor = shade(primary, 0.32);

    // Filled hexes use a reduced circumradius (fill ratio) + corner rounding.
    const Reff = Math.max(0.2, R * o.fill);
    const verts = hexVerts(Reff);
    const tmplD = roundedPolygon(verts, o.round);

    // Count "on" cells.
    let onCount = 0;
    for (const [q, r] of cells) if (on.get(q + "," + r)) onCount++;

    // Center logo clear radius (in cells).
    const logoOn = !!(o.logo && o.logo.on);
    const logoClear = logoOn ? Math.max(1.5, radius * 0.32) : 0;

    // ---------- emit SVG ----------
    const parts = [];
    // Backplate: a big flat-top hexagon silhouette so the whole piece reads
    // as one hexagon, not a square QR.
    const backR = (side / 2) * 0.96;
    const cx0 = side / 2, cy0 = side / 2;
    parts.push(
      `<polygon points="${flatHexPoints(cx0, cy0, backR)}" fill="${surface}"/>`
    );
    // Subtle inner outline on the silhouette.
    parts.push(
      `<polygon points="${flatHexPoints(cx0, cy0, backR)}" fill="none" ` +
      `stroke="${shade(surface, Theme_isDark(o) ? 0.45 : -0.06)}" stroke-width="${f2(side * 0.004)}" opacity="0.5"/>`
    );

    const perCell = o.animate && onCount <= ANIM_MAX;

    // Painted cells. Accent is used sparingly for a few seed-picked cells so
    // the primary color dominates but the piece has life.
    const accentSet = pickAccents(cells, on, rng, Math.min(6, Math.max(2, Math.floor(onCount * 0.04))));

    if (perCell) {
      parts.push(`<defs><path id="ihex" d="${tmplD}" /></defs>`);
      parts.push(`<g class="hex-matrix" stroke="${strokeColor}" stroke-width="${f2(o.stroke)}" stroke-linejoin="round">`);
      let i = 0;
      for (const [q, r] of cells) {
        if (!on.get(q + "," + r)) continue;
        if (logoOn && hexDist(q, r) <= logoClear) continue;
        const [x, y] = cellCenter(q, r, R);
        const cx = x + offX, cy = y + offY;
        const fill = accentSet.has(q + "," + r) ? accent : primary;
        const delay = (Math.hypot(q, r) / radius) * 0.28;
        parts.push(
          `<use href="#ihex" x="${f2(cx)}" y="${f2(cy)}" fill="${fill}" class="hex-cell" style="animation-delay:${f3(delay)}s"/>`
        );
        i++;
      }
      parts.push(`</g>`);
    } else {
      let dPrim = "", dAcc = "";
      for (const [q, r] of cells) {
        if (!on.get(q + "," + r)) continue;
        if (logoOn && hexDist(q, r) <= logoClear) continue;
        const [x, y] = cellCenter(q, r, R);
        const seg = translatePath(tmplD, x + offX, y + offY);
        if (accentSet.has(q + "," + r)) dAcc += seg; else dPrim += seg;
      }
      parts.push(
        `<path class="hex-cell hex-matrix" d="${dPrim}" fill="${primary}" stroke="${strokeColor}" stroke-width="${f2(o.stroke)}" stroke-linejoin="round"/>`
      );
      if (dAcc) parts.push(
        `<path class="hex-cell hex-matrix" d="${dAcc}" fill="${accent}" stroke="${shade(accent, 0.28)}" stroke-width="${f2(o.stroke)}" stroke-linejoin="round"/>`
      );
    }

    // Center logo.
    if (logoOn) {
      const [lx, ly] = cellCenter(0, 0, R);
      parts.push(logoSvg(lx + offX, ly + offY, logoClear * R * 0.92, o.logo, primary, accent, surface));
    }

    svg.setAttribute("viewBox", `0 0 ${f2(side)} ${f2(side)}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.innerHTML = parts.join("");

    return {
      style: o.style,
      cells: onCount,
      density: radius,
      bytes: text.length
    };
  }

  // Hex grid distance (axial).
  function hexDist(q, r) {
    return (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;
  }

  // Pick a handful of "on" cells to color with the accent, preferring cells
  // away from the very center so the logo area stays clean.
  function pickAccents(cells, on, rng, n) {
    const pool = cells.filter(([q, r]) => on.get(q + "," + r) && hexDist(q, r) > 1);
    const chosen = new Set();
    for (let i = pool.length - 1; i > 0 && chosen.size < n; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      const [q, r] = pool[i];
      chosen.add(q + "," + r);
    }
    return chosen;
  }

  // Theme hint without importing Theme (renderer stays standalone).
  function Theme_isDark(o) {
    // Heuristic: dark surfaces have low luminance.
    const c = (o.colors && o.colors.surface || "#fff").replace("#", "");
    const n = parseInt(c.length === 3 ? c.split("").map((x) => x + x).join("") : c, 16);
    const lum = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
    return lum < 0.5;
  }

  /* ---------- Center logo (nested hexagons, no circles) ---------- */
  function logoSvg(cx, cy, R, logo, primary, accent, surface) {
    const r = Math.max(8, R);
    let inner = "";
    if (logo.isImg && logo.dataUrl) {
      const s = r * 1.5;
      inner = `<image href="${logo.dataUrl}" x="${f2(cx - s / 2)}" y="${f2(cy - s / 2)}" width="${f2(s)}" height="${f2(s)}" preserveAspectRatio="xMidYMid meet"/>`;
    } else {
      const vOuter = hexVerts(r * 0.62).map((p) => `${f2(cx + p[0])},${f2(cy + p[1])}`).join(" ");
      const vInner = hexVerts(r * 0.26).map((p) => `${f2(cx + p[0])},${f2(cy + p[1])}`).join(" ");
      inner =
        `<polygon points="${vOuter}" fill="none" stroke="${primary}" stroke-width="${f2(r * 0.14)}" stroke-linejoin="round"/>` +
        `<polygon points="${vInner}" fill="${accent}"/>`;
    }
    const frame = hexVerts(r).map((p) => `${f2(cx + p[0])},${f2(cy + p[1])}`).join(" ");
    return (
      `<g class="hex-logo">` +
      `<polygon points="${frame}" fill="${surface}"/>` +
      `<polygon points="${frame}" fill="none" stroke="${primary}" stroke-width="${f2(r * 0.06)}" opacity="0.5"/>` +
      inner +
      `</g>`
    );
  }

  global.HexRenderer = { render, makeRng, bigHexCellList, hexDist, shade, tint };
})(window);
