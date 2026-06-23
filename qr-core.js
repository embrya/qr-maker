/* QR encoding utilities: chunking, CRC32, Base64URL, SHA-256. */
(function (global) {
  "use strict";

  const PROTOCOL = "AGQR1";
  const crcTable = makeCrcTable();

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  }

  function crc32Ascii(text) {
    let crc = 0xffffffff;
    for (let i = 0; i < text.length; i += 1) {
      crc = crcTable[(crc ^ text.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  }

  async function sha256Hex(bytes) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function textToBase64Url(text) {
    return bytesToBase64Url(new TextEncoder().encode(text));
  }

  function base64UrlToText(value) {
    return new TextDecoder().decode(base64UrlToBytes(value));
  }

  async function makeFrames(file, chunkChars) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256Hex(bytes);
    const sid = sha.slice(0, 12);
    const body = bytesToBase64Url(bytes);
    const chunks = [];
    for (let offset = 0; offset < body.length; offset += chunkChars) chunks.push(body.slice(offset, offset + chunkChars));
    const total = chunks.length;
    const meta = [
      PROTOCOL,
      "M",
      sid,
      String(total),
      String(bytes.length),
      sha,
      textToBase64Url(file.name || "restored.bin"),
      textToBase64Url(file.type || "application/octet-stream"),
    ].join("|");
    const data = chunks.map((chunk, index) => [PROTOCOL, "D", sid, String(index), String(total), crc32Ascii(chunk), chunk].join("|"));
    return { sid, sha, size: bytes.length, total, meta, data, frames: [meta].concat(data), base64Chars: body.length };
  }

  function parseFrame(raw) {
    const text = String(raw || "").trim();
    const parts = text.split("|");
    if (parts[0] !== PROTOCOL) return null;
    if (parts[1] === "M" && parts.length >= 8) {
      return {
        kind: "meta",
        sid: parts[2],
        total: parseInt(parts[3], 10),
        size: parseInt(parts[4], 10),
        sha: parts[5],
        name: base64UrlToText(parts[6]),
        mime: base64UrlToText(parts[7]),
        raw: text,
      };
    }
    if (parts[1] === "D" && parts.length >= 7) {
      const chunk = parts.slice(6).join("|");
      return {
        kind: "data",
        sid: parts[2],
        index: parseInt(parts[3], 10),
        total: parseInt(parts[4], 10),
        crc: parts[5],
        chunk,
        raw: text,
      };
    }
    return null;
  }

  function missingRanges(total, chunks) {
    const ranges = [];
    let start = null;
    for (let i = 0; i < total; i += 1) {
      const missing = !chunks.has(i);
      if (missing && start === null) start = i;
      if ((!missing || i === total - 1) && start !== null) {
        const end = missing && i === total - 1 ? i : i - 1;
        ranges.push(start === end ? String(start + 1) : `${start + 1}-${end + 1}`);
        start = null;
      }
    }
    return ranges;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "-";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  const api = {
    PROTOCOL,
    crc32Ascii,
    sha256Hex,
    bytesToBase64Url,
    base64UrlToBytes,
    textToBase64Url,
    base64UrlToText,
    makeFrames,
    parseFrame,
    missingRanges,
    formatBytes,
  };
  global.QRMaker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
