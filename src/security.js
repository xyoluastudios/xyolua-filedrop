import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Hashes a drop password with scrypt. Format: scrypt$N$r$p$salt$hash */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Short-lived, HMAC-signed access token for one password-protected drop.
 * Stored in an HttpOnly cookie scoped to that drop's API path.
 */
export function signAccessToken(secret, dropId, ttlSeconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${dropId}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyAccessToken(secret, dropId, token, now = Date.now()) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 < now) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${dropId}.${exp}`).digest();
  const given = Buffer.from(m[2], 'base64url');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Simple fixed-window rate limiter kept in memory (single-process deployments). */
export class RateLimiter {
  constructor(limit, windowSeconds) {
    this.limit = limit;
    this.windowMs = windowSeconds * 1000;
    this.hits = new Map();
    this.timer = setInterval(() => this.prune(), Math.min(this.windowMs, 60_000));
    this.timer.unref();
  }

  /** Records one hit for `key`. Returns false when the limit is exceeded. */
  hit(key, now = Date.now()) {
    if (!this.limit) return true;
    let entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** True if `key` already used up its budget (does not count as a hit). */
  isBlocked(key, now = Date.now()) {
    if (!this.limit) return false;
    const entry = this.hits.get(key);
    return Boolean(entry && entry.reset > now && entry.count >= this.limit);
  }

  retryAfter(key, now = Date.now()) {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.reset - now) / 1000)) : 1;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.hits) if (entry.reset <= now) this.hits.delete(key);
  }

  stop() {
    clearInterval(this.timer);
  }
}

/**
 * Resolves the client IP. With TRUST_PROXY=n the n-th address from the right of
 * X-Forwarded-For is used (n = number of reverse proxies in front of the app).
 */
export function clientIp(req, trustProxy) {
  const remote = req.socket.remoteAddress || 'unknown';
  if (!trustProxy) return remote;
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chain = [...forwarded, remote];
  return chain[Math.max(0, chain.length - 1 - trustProxy)];
}

export function isSecureRequest(req, config) {
  if (config.baseUrl) return config.baseUrl.startsWith('https://');
  if (req.socket.encrypted) return true;
  return config.trustProxy > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
};
