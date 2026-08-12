/* =====================================================================
   app.js — Inpriv Hexa controller
   Copyright (c) 2026 Aurex Labs — MIT License
   Wires inputs, presets, customizer, renderer, export, and UI feedback.
   ===================================================================== */
(function () {
  "use strict";

  /* ----------------------------- palettes ----------------------------- */
  const PALETTES = [
    { name: "Forest",   primary: "#466E47", accent: "#9C4231", surface: "#FAF9F0" },
    { name: "Moss",     primary: "#3A5A40", accent: "#A36B2B", surface: "#F4F1E8" },
    { name: "Sage",     primary: "#5B7560", accent: "#9C4231", surface: "#F2F0E6" },
    { name: "Charcoal", primary: "#2B2D28", accent: "#B4513F", surface: "#EDEAE0" },
    { name: "Ocean",    primary: "#2F5D62", accent: "#C26A3A", surface: "#F2F4F1" },
    { name: "Plum",     primary: "#5B3A52", accent: "#C2843A", surface: "#F4EFE9" }
  ];
  const DARK_SURFACES = {
    Forest: "#1F211B", Moss: "#1B2014", Sage: "#1E2418",
    Charcoal: "#13140E", Ocean: "#13201E", Plum: "#1E1320"
  };

  /* ----------------------------- state ----------------------------- */
  const state = {
    preset: "url",
    wifiSec: "WPA",
    style: "crystal",
    density: 2,
    stroke: 1.2,
    fill: 0.82,
    round: 0.35,
    paletteIdx: 0,
    colors: Object.assign({}, PALETTES[0]),
    logo: { on: false, dataUrl: "", isImg: false, name: "" },
    lastText: "",
    meta: null,
    busy: false
  };

  /* ----------------------------- helpers ----------------------------- */
  const $ = (id) => document.getElementById(id);
  const reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms);
    };
  }

  function toast(msg, type) {
    const region = $("toastRegion");
    if (!region) return;
    const t = document.createElement("div");
    t.className = "toast" + (type === "error" ? " toast--error" : "");
    const iconName = type === "error" ? "error" : "check_circle";
    t.innerHTML =
      '<span class="material-symbols-rounded" aria-hidden="true">' + iconName + "</span>" +
      "<span>" + msg + "</span>";
    region.appendChild(t);
    setTimeout(() => {
      t.classList.add("is-out");
      setTimeout(() => t.remove(), 320);
    }, 2600);
  }

  function ripple(btn, ev) {
    if (reduceMotion) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = (ev ? ev.clientX : rect.left + rect.width / 2) - rect.left - size / 2;
    const y = (ev ? ev.clientY : rect.top + rect.height / 2) - rect.top - size / 2;
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = size + "px";
    span.style.left = x + "px";
    span.style.top = y + "px";
    if (getComputedStyle(btn).position === "static") btn.style.position = "relative";
    btn.style.overflow = "hidden";
    btn.appendChild(span);
    setTimeout(() => span.remove(), 600);
  }

  /* ----------------------------- preset / input wiring ----------------------------- */
  const PRESET_LABELS = {
    url: "Enter a URL",
    text: "Enter text",
    wifi: "Wi-Fi details",
    vcard: "Contact details",
    note: "Encrypted note"
  };

  function setPreset(name) {
    state.preset = name;
    document.querySelectorAll(".seg--preset").forEach((b) => {
      const on = b.dataset.preset === name;
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".inputform").forEach((f) => {
      f.hidden = f.dataset.form !== name;
    });
    $("inputLabel").textContent = PRESET_LABELS[name] || "Enter content";
    regenerate();
  }

  function readInputs() {
    const p = state.preset;
    if (p === "url")   return { text: $("urlInput").value };
    if (p === "text")  return { text: $("textInput").value };
    if (p === "wifi")  return {
      ssid: $("wifiSsid").value, pass: $("wifiPass").value,
      sec: state.wifiSec, hidden: $("wifiHidden").checked
    };
    if (p === "vcard") return {
      name: $("vcardName").value, phone: $("vcardPhone").value,
      email: $("vcardEmail").value, org: $("vcardOrg").value, url: $("vcardUrl").value
    };
    if (p === "note")  return { pass: $("notePass").value, body: $("noteBody").value };
    return { text: "" };
  }

  /* ----------------------------- regenerate ----------------------------- */
  async function regenerate() {
    if (state.busy) return;
    const values = readInputs();
    let text;
    if (state.preset === "note") {
      text = await Presets.note(values);
    } else {
      text = Presets.formatSync(state.preset, values);
    }
    state.lastText = text;

    const svg = $("hexCanvas");
    const empty = $("previewEmpty");
    if (!text) {
      svg.innerHTML = "";
      empty.hidden = false;
      updateMeta(null);
      return;
    }
    empty.hidden = true;

    // Surface color follows current theme.
    const surface = currentSurface();
    const info = HexRenderer.render(svg, {
      text,
      style: state.style,
      density: state.density,
      stroke: state.stroke,
      fill: state.fill,
      round: state.round,
      colors: { primary: state.colors.primary, accent: state.colors.accent, surface },
      logo: state.logo,
      animate: !reduceMotion
    });
    if (info && info.error) {
      toast(info.error, "error");
      svg.innerHTML = "";
      empty.hidden = false;
      updateMeta(null);
      return;
    }
    state.meta = info;
    updateMeta(info);
  }

  function currentSurface() {
    return Theme.current() === "dark" ? DARK_SURFACES[state.colors.name] || "#1F211B" : state.colors.surface;
  }

  function updateMeta(info) {
    if (!info) {
      $("metaVersion").textContent = "—";
      $("metaModules").textContent = "—";
      $("metaEc").textContent = "—";
      $("metaBytes").textContent = "—";
      return;
    }
    $("metaVersion").textContent = info.cells;            // Cells
    $("metaModules").textContent = info.density;          // Size
    $("metaEc").textContent = cap(info.style);            // Style
    $("metaBytes").textContent = info.bytes;              // Chars
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—"; }

  const regenerateDebounced = debounce(regenerate, 90);

  /* ----------------------------- controls ----------------------------- */
  function bindControls() {
    // Preset tabs
    document.querySelectorAll(".seg--preset").forEach((b) => {
      b.addEventListener("click", () => setPreset(b.dataset.preset));
    });

    // All text inputs → live recalc
    ["urlInput", "textInput", "wifiSsid", "wifiPass", "vcardName", "vcardPhone",
     "vcardEmail", "vcardOrg", "vcardUrl", "notePass", "noteBody"]
      .forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("input", regenerateDebounced);
      });

    // Wi-Fi security radios
    document.querySelectorAll("#wifiSecGroup .seg").forEach((b) => {
      b.addEventListener("click", () => {
        state.wifiSec = b.dataset.sec;
        document.querySelectorAll("#wifiSecGroup .seg").forEach((x) =>
          x.setAttribute("aria-checked", x === b ? "true" : "false"));
        regenerate();
      });
    });

    // Pattern style segmented
    document.querySelectorAll("#ecGroup .seg").forEach((b) => {
      b.addEventListener("click", () => {
        state.style = b.dataset.style;
        document.querySelectorAll("#ecGroup .seg").forEach((x) =>
          x.setAttribute("aria-checked", x === b ? "true" : "false"));
        regenerate();
      });
    });

    // Sliders
    bindSlider("density", "densityVal", (v) => {
      state.density = parseInt(v, 10); // 0,1,2 → hexagon radius 4,6,8
      return ["Small", "Medium", "Large"][parseInt(v, 10)] || "Medium";
    });
    bindSlider("stroke", "strokeVal", (v) => { state.stroke = parseFloat(v); return parseFloat(v).toFixed(1); });
    bindSlider("fill", "fillVal", (v) => { state.fill = parseFloat(v); return Math.round(parseFloat(v) * 100) + "%"; });
    bindSlider("round", "roundVal", (v) => { state.round = parseFloat(v); return Math.round(parseFloat(v) * 100) + "%"; });

    // Palette swatches
    renderPaletteRow();
    document.querySelectorAll("#paletteRow .palette").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx, 10);
        applyPalette(idx);
      });
    });

    // Color pickers
    bindColor("colPrimary", "swPrimary", (v) => { state.colors.primary = v; });
    bindColor("colAccent", "swAccent", (v) => { state.colors.accent = v; });
    bindColor("colSurface", "swSurface", (v) => { state.colors.surface = v; });

    // Logo toggle + upload
    $("logoToggle").addEventListener("change", (e) => {
      state.logo.on = e.target.checked;
      regenerate();
    });
    $("logoFile").addEventListener("change", handleLogoUpload);
    $("logoClear").addEventListener("click", clearLogo);

    // Reveal passphrase
    $("noteReveal").addEventListener("click", () => {
      const f = $("notePass");
      const showing = f.type === "text";
      f.type = showing ? "password" : "text";
      $("noteReveal").querySelector("span").textContent = showing ? "visibility" : "visibility_off";
      $("noteReveal").setAttribute("aria-label", showing ? "Show passphrase" : "Hide passphrase");
    });

    // Copy / share
    $("copyBtn").addEventListener("click", onCopy);
    $("shareBtn").addEventListener("click", onShare);

    // FAB menu
    $("fab").addEventListener("click", onFabToggle);
    document.querySelectorAll(".fab-menu__item").forEach((b) => {
      b.addEventListener("click", (e) => {
        ripple(b, e);
        closeFab();
        onExport(b.dataset.export);
      });
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".fab-anchor")) closeFab();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeFab();
    });
  }

  function bindSlider(id, valId, fn) {
    const el = $(id);
    el.addEventListener("input", (e) => {
      $(valId).textContent = fn(e.target.value);
      regenerateDebounced();
    });
    // initialize label
    $(valId).textContent = fn(el.value);
  }

  function bindColor(inputId, chipId, fn) {
    const input = $(inputId);
    const chip = $(chipId);
    chip.style.background = input.value;
    chip.addEventListener("click", () => input.click());
    input.addEventListener("input", (e) => {
      chip.style.background = e.target.value;
      fn(e.target.value);
      regenerateDebounced();
    });
  }

  function renderPaletteRow() {
    const row = $("paletteRow");
    row.innerHTML = "";
    PALETTES.forEach((p, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "palette";
      btn.dataset.idx = i;
      btn.setAttribute("aria-pressed", i === state.paletteIdx ? "true" : "false");
      btn.setAttribute("aria-label", p.name + " palette");
      btn.innerHTML =
        '<span class="palette__dots">' +
        '<span style="background:' + p.primary + '"></span>' +
        '<span style="background:' + p.accent + '"></span>' +
        '<span style="background:' + p.surface + '"></span>' +
        "</span>" +
        "<span>" + p.name + "</span>";
      row.appendChild(btn);
    });
  }

  function applyPalette(idx) {
    state.paletteIdx = idx;
    state.colors = Object.assign({}, PALETTES[idx], { name: PALETTES[idx].name });
    // sync color pickers
    setColorValue("colPrimary", "swPrimary", state.colors.primary);
    setColorValue("colAccent", "swAccent", state.colors.accent);
    setColorValue("colSurface", "swSurface", state.colors.surface);
    document.querySelectorAll("#paletteRow .palette").forEach((el) => {
      el.setAttribute("aria-pressed", parseInt(el.dataset.idx, 10) === idx ? "true" : "false");
    });
    regenerate();
  }

  function setColorValue(inputId, chipId, val) {
    const input = $(inputId);
    const chip = $(chipId);
    input.value = val;
    chip.style.background = val;
  }

  /* ----------------------------- logo upload ----------------------------- */
  function handleLogoUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      toast("Logo too large (max 1.5 MB).", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const isSvg = file.type === "image/svg+xml";
      const isPng = file.type === "image/png";
      if (!isSvg && !isPng) {
        toast("Use an SVG or PNG file.", "error");
        return;
      }
      state.logo.dataUrl = reader.result;
      state.logo.isImg = true;
      state.logo.name = file.name;
      state.logo.on = true;
      $("logoToggle").checked = true;
      $("logoFileName").textContent = file.name.length > 18
        ? file.name.slice(0, 15) + "…"
        : file.name;
      $("logoClear").hidden = false;
      regenerate();
      toast("Logo added.");
    };
    reader.readAsDataURL(file);
  }
  function clearLogo() {
    state.logo.dataUrl = "";
    state.logo.isImg = false;
    state.logo.name = "";
    state.logo.on = false;
    $("logoToggle").checked = false;
    $("logoFile").value = "";
    $("logoFileName").textContent = "Upload SVG / PNG";
    $("logoClear").hidden = true;
    regenerate();
  }

  /* ----------------------------- FAB ----------------------------- */
  function onFabToggle(e) {
    const fab = $("fab");
    const menu = $("fabMenu");
    const open = menu.hidden;
    if (open) {
      menu.hidden = false;
      fab.setAttribute("aria-expanded", "true");
    } else {
      closeFab();
    }
    ripple(fab, e);
  }
  function closeFab() {
    $("fabMenu").hidden = true;
    $("fab").setAttribute("aria-expanded", "false");
  }

  /* ----------------------------- export ----------------------------- */
  async function onExport(kind) {
    const svg = $("hexCanvas");
    if (!state.lastText || !svg.innerHTML.trim()) {
      toast("Nothing to export yet.", "error");
      return;
    }
    try {
      const bg = currentSurface();
      if (kind === "svg") {
        Exporter.exportSVG(svg);
        toast("SVG downloaded.");
      } else if (kind === "png") {
        await Exporter.exportPNG(svg, "inpriv-hexa.png", { scale: 4, background: bg });
        toast("PNG downloaded (hi-res).");
      } else if (kind === "pdf") {
        await Exporter.exportPDF(svg, "inpriv-hexa.pdf", { scale: 4, background: bg });
        toast("PDF downloaded.");
      }
    } catch (e) {
      toast("Export failed: " + (e && e.message ? e.message : "unknown error"), "error");
    }
  }

  /* ----------------------------- copy / share ----------------------------- */
  async function onCopy() {
    const svg = $("hexCanvas");
    if (!state.lastText || !svg.innerHTML.trim()) {
      toast("Nothing to copy yet.", "error");
      return;
    }
    const ok = await Exporter.copySVG(svg);
    toast(ok ? "SVG copied to clipboard." : "Copy failed — try again.", ok ? "ok" : "error");
  }

  async function onShare() {
    if (!state.lastText) { toast("Nothing to share yet.", "error"); return; }
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Inpriv Hexa",
          text: "Scan this Inpriv Hexa code",
          url: state.preset === "url" ? state.lastText : undefined
        });
      } catch (_) { /* user cancelled */ }
    } else {
      // fallback: copy the encoded text
      try {
        await navigator.clipboard.writeText(state.lastText);
        toast("Encoded content copied (Web Share unavailable).");
      } catch (_) {
        toast("Sharing not supported here.", "error");
      }
    }
  }

  /* ----------------------------- init ----------------------------- */
  function init() {
    bindControls();
    // initial surface + swatch chips
    setColorValue("colPrimary", "swPrimary", state.colors.primary);
    setColorValue("colAccent", "swAccent", state.colors.accent);
    setColorValue("colSurface", "swSurface", state.colors.surface);
    document.addEventListener("themechange", regenerateDebounced);
    // seed URL input with a sample so the first render isn't empty
    if (!$("urlInput").value) $("urlInput").value = "https://aurexlabs.example";
    regenerate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
