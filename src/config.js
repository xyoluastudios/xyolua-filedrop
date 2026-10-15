import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBytes, parseDuration } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(env, name, fallback) {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function toInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid value for ${name}: "${value}" (expected a non-negative integer)`);
  return n;
}

function toBool(name, value) {
  if (typeof value === 'boolean') return value;
  const v = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Invalid value for ${name}: "${value}" (expected true/false)`);
}

function toBytes(name, value) {
  const n = parseBytes(value);
  if (n === null) throw new Error(`Invalid size for ${name}: "${value}" (examples: 500MB, 2GB)`);
  return n;
}

function toDuration(name, value) {
  const n = parseDuration(value);
  if (n === null) throw new Error(`Invalid duration for ${name}: "${value}" (examples: 30m, 12h, 7d)`);
  return n;
}

/**
 * Builds the runtime configuration from environment variables.
 * Every option is documented in .env.example and the README.
 */
export function loadConfig(env = process.env) {
  const get = (name, fallback) => readEnv(env, name, fallback);

  const maxExpiry = toDuration('MAX_EXPIRY', get('MAX_EXPIRY', '7d'));
  const expiryPresets = String(get('EXPIRY_PRESETS', '10m,1h,1d,3d,7d'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => toDuration('EXPIRY_PRESETS', s))
    .filter((s) => s <= maxExpiry);
  if (!expiryPresets.length) expiryPresets.push(maxExpiry);

  let defaultExpiry = toDuration('DEFAULT_EXPIRY', get('DEFAULT_EXPIRY', '1d'));
  if (defaultExpiry > maxExpiry) defaultExpiry = maxExpiry;

  const baseUrl = String(get('BASE_URL', '')).replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\/[^/]+(\/.*)?$/i.test(baseUrl)) {
    throw new Error(`Invalid BASE_URL: "${baseUrl}" (expected something like https://drop.example.com)`);
  }

  return {
    rootDir: ROOT,
    publicDir: path.join(ROOT, 'public'),
    host: get('HOST', '0.0.0.0'),
    port: toInt('PORT', get('PORT', '8080')),
    baseUrl,
    dataDir: path.resolve(ROOT, get('DATA_DIR', 'data')),
    siteName: String(get('SITE_NAME', 'XyoLua FileDrop')).slice(0, 60),

    // Upload limits
    maxUploadSize: toBytes('MAX_UPLOAD_SIZE', get('MAX_UPLOAD_SIZE', '1GB')),
    maxFiles: Math.max(1, toInt('MAX_FILES', get('MAX_FILES', '20'))),
    maxStorage: toBytes('MAX_STORAGE', get('MAX_STORAGE', '0')), // 0 = unlimited
    uploadPassword: String(get('UPLOAD_PASSWORD', '')),

    // Drop options
    maxExpiry,
    defaultExpiry,
    expiryPresets: [...new Set(expiryPresets)].sort((a, b) => a - b),
    maxDownloadsLimit: Math.max(1, toInt('MAX_DOWNLOADS', get('MAX_DOWNLOADS', '1000'))),
    allowUnlimitedDownloads: toBool('ALLOW_UNLIMITED_DOWNLOADS', get('ALLOW_UNLIMITED_DOWNLOADS', 'true')),
    allowLinks: toBool('ALLOW_LINKS', get('ALLOW_LINKS', 'true')),
    allowZip: toBool('ALLOW_ZIP', get('ALLOW_ZIP', 'true')),

    // Security
    secret: String(get('SECRET', '')),
    trustProxy: toInt('TRUST_PROXY', get('TRUST_PROXY', '0')),
    uploadRateLimit: toInt('RATE_LIMIT_UPLOADS', get('RATE_LIMIT_UPLOADS', '30')), // per IP per hour, 0 = off
    unlockRateLimit: toInt('RATE_LIMIT_UNLOCK', get('RATE_LIMIT_UNLOCK', '10')), // per IP per 15 min, 0 = off

    // Housekeeping
    cleanupInterval: toDuration('CLEANUP_INTERVAL', get('CLEANUP_INTERVAL', '1m')),
  };
}
