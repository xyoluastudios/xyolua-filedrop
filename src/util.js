import crypto from 'node:crypto';
import zlib from 'node:zlib';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically random, URL-safe identifier (base62, unbiased). */
export function randomId(length = 12) {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < 248) out += BASE62[byte % 62]; // 248 = 62 * 4 -> no modulo bias
      if (out.length === length) break;
    }
  }
  return out;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that does not leak the length of either input. */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** "500MB" -> 524288000, "0" -> 0. Returns null when the value cannot be parsed. */
export function parseBytes(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(String(value));
  if (!m) return null;
  return Math.floor(Number(m[1]) * SIZE_UNITS[(m[2] || 'b').toLowerCase()]);
}

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** "30m" -> 1800 (seconds), "7d" -> 604800. A bare number means seconds. */
export function parseDuration(value) {
  const m = /^\s*(\d+)\s*(s|m|h|d|w)?\s*$/i.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * DURATION_UNITS[(m[2] || 's').toLowerCase()];
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Turns an uploaded file name into something safe to store and send back:
 * no path components, no control characters, bounded length.
 */
export function sanitizeFilename(name) {
  let clean = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .split(/[\\/]/)
    .pop()
    .trim();
  if (clean === '.' || clean === '..') clean = '';
  if (clean.length > 200) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
    clean = clean.slice(0, 200 - ext.length) + ext;
  }
  return clean || 'file';
}

/** Only keep MIME types that look like "type/subtype"; the value is informational only. */
export function sanitizeMime(mime) {
  const value = String(mime || '').toLowerCase().trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(value)
    ? value
    : 'application/octet-stream';
}

/** RFC 6266 Content-Disposition header that works with non-ASCII names. */
export function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// CRC-32 (needed for ZIP archives). Uses zlib.crc32 when the runtime provides it.
let CRC_TABLE = null;
function crc32Fallback(buf, prev = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0 : crc32Fallback;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
