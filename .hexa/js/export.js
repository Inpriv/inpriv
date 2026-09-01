/* =====================================================================
   export.js — SVG / PNG (high-res) / PDF export + clipboard helpers
   Copyright (c) 2026 Inpriv Labs — MIT License
   Pure client-side. PDFs are assembled by hand and embed a JPEG raster.
   ===================================================================== */
(function (global) {
  "use strict";

  const XMLNS = "http://www.w3.org/2000/svg";
  const XLINKNS = "http://www.w3.org/1999/xlink";

  /* ---------- serialize live SVG to a standalone string ---------- */
  function svgToString(svg) {
    // Clone so we can strip animation classes & add xmlns without touching the live DOM.
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", XMLNS);
    clone.removeAttribute("class");
    // Remove animation-only attributes/classes for a clean export.
    clone.querySelectorAll(".hex-cell, .hex-matrix, .hex-target, .hex-logo").forEach((el) => {
      el.removeAttribute("class");
      el.removeAttribute("style");
    });
    // Ensure <use href> works in standalone SVG viewers (add xlink:href).
    clone.querySelectorAll("use").forEach((u) => {
      const h = u.getAttribute("href");
      if (h && !u.getAttribute("xlink:href")) u.setAttributeNS(XLINKNS, "xlink:href", h);
    });
    const out = new XMLSerializer().serializeToString(clone);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
  }

  function download(filename, dataUrl, mime) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function svgDataUrl(svgStr) {
    // Use base64 to safely transport unicode + special chars.
    const b64 = btoa(unescape(encodeURIComponent(svgStr)));
    return "data:image/svg+xml;base64," + b64;
  }

  /* ---------- SVG ---------- */
  function exportSVG(svg, filename) {
    const str = svgToString(svg);
    const url = svgDataUrl(str);
    download(filename || "inpriv-hexa.svg", url);
    return str;
  }

  /* ---------- PNG (hi-res) ---------- */
  function exportPNG(svg, filename, opts) {
    const o = Object.assign({ scale: 4, background: "#ffffff", mime: "image/png" }, opts || {});
    const str = svgToString(svg);
    const vb = (svg.getAttribute("viewBox") || "0 0 1000 1000").split(/\s+/).map(parseFloat);
    const w = vb[2], h = vb[3];
    const outW = Math.round(w * o.scale), outH = Math.round(h * o.scale);

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = o.background;
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(img, 0, 0, outW, outH);
        try {
          const dataUrl = canvas.toDataURL(o.mime, 0.95);
          download(filename || "inpriv-hexa.png", dataUrl);
          resolve(dataUrl);
        } catch (e) { reject(e); }
      };
      img.onerror = (e) => reject(new Error("Could not rasterize SVG. " + (e && e.message)));
      img.src = svgDataUrl(str);
    });
  }

  /* ---------- PDF (JPEG embedded in a single-page PDF) ---------- */
  async function exportPDF(svg, filename, opts) {
    const o = Object.assign({ scale: 4, background: "#ffffff" }, opts || {});
    const str = svgToString(svg);
    const vb = (svg.getAttribute("viewBox") || "0 0 1000 1000").split(/\s+/).map(parseFloat);
    const w = vb[2], h = vb[3];
    const outW = Math.round(w * o.scale), outH = Math.round(h * o.scale);

    // Raster to JPEG (PDFs embed JPEGs compactly).
    const jpegDataUrl = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = o.background;
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(img, 0, 0, outW, outH);
        resolve(canvas.toDataURL("image/jpeg", 0.92));
      };
      img.onerror = () => reject(new Error("PDF raster failed"));
      img.src = svgDataUrl(str);
    });
    const b64 = jpegDataUrl.split(",")[1];
    const pdf = buildImagePDF(outW, outH, b64);
    const url = "data:application/pdf;base64," + btoa(pdf);
    download(filename || "inpriv-hexa.pdf", url);
    return url;
  }

  // Minimal single-image PDF (binary string). Letter/A-agnostic — uses image pixel size as points.
  function buildImagePDF(w, h, jpegB64) {
    const encImg = jpegB64;
    const imgBytes = atob(encImg);
    const hexImg = "";
    // We embed via DCT (JPEG) stream using the raw bytes (latin1).
    const xref = [];
    let pos = 0;
    const objects = [];
    function add(str) {
      objects.push(str);
      xref.push(pos);
      pos += str.length;
    }
    // obj 1: catalog
    add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    // obj 2: pages
    add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    // obj 3: page
    add(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + w + " " + h + "] " +
      "/Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n"
    );
    // obj 4: contents (draw image full-bleed)
    const content = "q\n" + w + " 0 0 " + h + " 0 0 cm\n/Im1 Do\nQ\n";
    add("4 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "endstream\nendobj\n");
    // obj 5: image XObject (DCTDecode = JPEG)
    const imgHeader =
      "5 0 obj\n<< /Type /XObject /Subtype /Image /Width " + w + " /Height " + h +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + imgBytes.length + " >>\nstream\n";
    const imgFooter = "\nendstream\nendobj\n";

    const header = "%PDF-1.4\n";
    let pdf = header;
    for (let i = 0; i < objects.length; i++) {
      pdf += objects[i];
    }
    const imgStartOffset = pdf.length + imgHeader.length; // not used; xref needs byte offsets though.
    // For correctness of xref we must count the image stream bytes (latin1).
    // Rebuild xref offsets including image bytes:
    const xref2 = [];
    let pos2 = header.length;
    for (let i = 0; i < 4; i++) { xref2.push(pos2); pos2 += objects[i].length; }
    xref2.push(pos2); pos2 += imgHeader.length + imgBytes.length + imgFooter.length;

    let body = "";
    for (let i = 0; i < 4; i++) body += objects[i];
    body += imgHeader + imgBytes + imgFooter;

    const xrefPos = header.length + body.length;
    let xrefTable = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 0; i < 5; i++) {
      xrefTable += String(xref2[i]).padStart(10, "0") + " 00000 n \n";
    }
    const trailer =
      "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF";
    return header + body + xrefTable + trailer;
  }

  /* ---------- clipboard ---------- */
  async function copySVG(svg) {
    const str = svgToString(svg);
    try {
      await navigator.clipboard.writeText(str);
      return true;
    } catch (_) {
      // fallback: temporary textarea
      try {
        const ta = document.createElement("textarea");
        ta.value = str;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e) { return false; }
    }
  }

  async function copyPNG(svg, scale) {
    try {
      const str = svgToString(svg);
      const vb = (svg.getAttribute("viewBox") || "0 0 1000 1000").split(/\s+/).map(parseFloat);
      const outW = Math.round(vb[2] * (scale || 3)), outH = Math.round(vb[3] * (scale || 3));
      const blob = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = outW; c.height = outH;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, outW, outH);
          c.toBlob(resolve, "image/png");
        };
        img.onerror = reject;
        img.src = svgDataUrl(str);
      });
      if (!blob || !navigator.clipboard || !window.ClipboardItem) return false;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    } catch (_) { return false; }
  }

  global.Exporter = { exportSVG, exportPNG, exportPDF, copySVG, copyPNG, svgToString, svgDataUrl };
})(window);
