/* =====================================================================
   presets.js — content formatters + AES-GCM encrypted notes
   Copyright (c) 2026 Aurex Labs — MIT License
   All encoding is in-browser; nothing is transmitted.
   ===================================================================== */
(function (global) {
  "use strict";

  // Escape characters that break the Wi-Fi / vCard grammar per the spec.
  function escWifi(s) {
    return String(s == null ? "" : s).replace(/([\\;,":])/g, "\\$1");
  }

  // vCard 3.0 line folding: split long lines at 75 octets (simplified — fold at 73 chars).
  function vcardFold(line) {
    if (line.length <= 75) return line;
    const out = [];
    let i = 0;
    while (i < line.length) {
      out.push((i === 0 ? "" : " ") + line.slice(i, i + 73));
      i += 73;
    }
    return out.join("\r\n");
  }
  function vcardLine(prop, value) {
    if (value == null || value === "") return "";
    return vcardFold(prop + ":" + String(value).replace(/\r?\n/g, "\\n")) + "\r\n";
  }

  const Presets = {
    /* ---- URL ---- */
    url(v) {
      const s = (v && v.text || "").trim();
      if (!s) return "";
      // Add scheme if missing so scanners treat it as a link.
      if (!/^[a-z][a-z0-9+.\-]*:/i.test(s) && s.indexOf("//") !== 0) {
        return "https://" + s;
      }
      return s;
    },

    /* ---- Plain text ---- */
    text(v) { return (v && v.text || "").trim(); },

    /* ---- Wi-Fi (popular ZXing / Android grammar) ---- */
    wifi(v) {
      const ssid = (v && v.ssid || "").trim();
      const pass = v && v.pass || "";
      const sec = v && v.sec || "WPA";
      const hidden = !!(v && v.hidden);
      if (!ssid) return "";
      if (sec === "nopass") {
        return `WIFI:T:nopass;S:${escWifi(ssid)};${hidden ? "H:true;" : ""};`;
      }
      return `WIFI:T:${sec};S:${escWifi(ssid)};P:${escWifi(pass)};${hidden ? "H:true;" : ""};`;
    },

    /* ---- vCard 3.0 ---- */
    vcard(v) {
      const name = (v && v.name || "").trim();
      if (!name && !(v && (v.email || v.phone))) return "";
      let out = "BEGIN:VCARD\r\nVERSION:3.0\r\n";
      out += vcardLine("N", name);
      out += vcardLine("FN", name);
      if (v && v.org) out += vcardLine("ORG", v.org);
      if (v && v.phone) {
        out += vcardLine("TEL;TYPE=CELL", String(v.phone).replace(/[^\d+]/g, ""));
      }
      if (v && v.email) out += vcardLine("EMAIL;TYPE=INTERNET", v.email);
      if (v && v.url) out += vcardLine("URL", v.url);
      out += "END:VCARD\r\n";
      return out;
    },

    /* ---- Encrypted note (AES-GCM, passphrase-derived key via PBKDF2) ----
       Payload format:  "INAES1:" + base64(salt(16) | iv(12) | ciphertext)  */
    async note(v) {
      const pass = v && v.pass || "";
      const body = (v && v.body || "").trim();
      if (!body) return "";
      if (!global.crypto || !global.crypto.subtle) {
        // Graceful fallback: leave plaintext (still works as a QR).
        return body;
      }
      try {
        const enc = new TextEncoder();
        const salt = global.crypto.getRandomValues(new Uint8Array(16));
        const iv = global.crypto.getRandomValues(new Uint8Array(12));

        const baseKey = await global.crypto.subtle.importKey(
          "raw", enc.encode(pass), { name: "PBKDF2" }, false, ["deriveKey"]
        );
        const key = await global.crypto.subtle.deriveKey(
          { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
          baseKey,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt"]
        );
        const ct = await global.crypto.subtle.encrypt(
          { name: "AES-GCM", iv }, key, enc.encode(body)
        );
        const combined = new Uint8Array(salt.length + iv.length + ct.byteLength);
        combined.set(salt, 0);
        combined.set(iv, salt.length);
        combined.set(new Uint8Array(ct), salt.length + iv.length);
        return "INAES1:" + base64FromBytes(combined);
      } catch (_) {
        return body; // fallback plaintext
      }
    }
  };

  // Small, dependency-free base64 for Uint8Array (works in older engines).
  function base64FromBytes(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  Presets.formatSync = function (type, values) {
    if (type === "url") return Presets.url(values);
    if (type === "text") return Presets.text(values);
    if (type === "wifi") return Presets.wifi(values);
    if (type === "vcard") return Presets.vcard(values);
    return "";
  };

  global.Presets = Presets;
})(window);
