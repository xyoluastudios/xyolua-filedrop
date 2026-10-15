import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { createZip, zipSupported } from './zip.js';
import {
  RateLimiter,
  SECURITY_HEADERS,
  clientIp,
  hashPassword,
  isSecureRequest,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './security.js';
import {
  HttpError,
  contentDisposition,
  crc32,
  randomId,
  randomToken,
  safeEqual,
  sanitizeFilename,
  sanitizeMime,
  sha256,
} from './util.js';

const require = createRequire(import.meta.url);
const ACCESS_TTL = 3600; // seconds a password unlock stays valid
const MAX_PASSWORD_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const DRAIN_LIMIT = 2 * 1024 * 1024; // see sendError()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Builds a map of every servable public file. Nothing outside this list is ever read from disk. */
async function indexStaticFiles(config) {
  const files = new Map();
  async function walk(dir, prefix) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const urlPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(abs, urlPath);
      else if (MIME[path.extname(entry.name).toLowerCase()]) files.set(urlPath, abs);
    }
  }
  await walk(config.publicDir, '');
  const qrcodeMain = require.resolve('qrcode-generator'); // .../dist/qrcode.js
  files.set('/assets/vendor/qrcode.mjs', path.join(path.dirname(qrcodeMain), 'qrcode.mjs'));
  return files;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req, limit = 4096) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'json_required');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

/**
 * Browsers mark cross-site requests with Sec-Fetch-Site. State-changing endpoints refuse them,
 * so other websites cannot upload, unlock or delete drops in a visitor's name.
 */
function assertSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'cross_site_request');
}

function validateLink(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > MAX_URL_LENGTH) throw new HttpError(400, 'invalid_url');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'invalid_url');
  return url.href;
}

function parseIntField(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : NaN;
}

/**
 * Creates the request handler.
 * @returns {{ handle(req, res): Promise<void>, close(): void }}
 */
export async function createApp({ config, store, secret, logger = console }) {
  const staticFiles = await indexStaticFiles(config);
  const pkg = JSON.parse(await fsp.readFile(path.join(config.rootDir, 'package.json'), 'utf8'));

  const limiters = {
    uploads: new RateLimiter(config.uploadRateLimit, 3600),
    uploadKeyFailures: new RateLimiter(10, 900),
    unlockFailures: new RateLimiter(config.unlockRateLimit, 900),
    unlockFailuresPerDrop: new RateLimiter(config.unlockRateLimit ? 100 : 0, 3600),
  };
  let inflightBytes = 0; // bytes of uploads that are still in progress (for MAX_STORAGE)

  const routes = [
    ['GET', /^\/$/, (req, res) => servePage(req, res, 'index.html')],
    ['GET', /^\/d\/[A-Za-z0-9]{8,32}$/, (req, res) => servePage(req, res, 'drop.html', { 'X-Robots-Tag': 'noindex, nofollow' })],
    ['GET', /^\/healthz$/, (req, res) => sendJson(res, 200, { status: 'ok' })],
    ['GET', /^\/api\/config$/, getConfig],
    ['POST', /^\/api\/upload-key$/, checkUploadKey],
    ['POST', /^\/api\/drops$/, createDrop],
    ['GET', /^\/api\/drops\/([^/]+)$/, getDrop],
    ['DELETE', /^\/api\/drops\/([^/]+)$/, deleteDrop],
    ['POST', /^\/api\/drops\/([^/]+)\/unlock$/, unlockDrop],
    ['GET', /^\/api\/drops\/([^/]+)\/files\/(\d{1,5})$/, downloadFile],
    ['GET', /^\/api\/drops\/([^/]+)\/zip$/, downloadZip],
    ['POST', /^\/api\/drops\/([^/]+)\/open$/, openLink],
  ];

  async function handle(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        throw new HttpError(400, 'bad_request');
      }
      const method = req.method === 'HEAD' && !pathname.startsWith('/api/') ? 'GET' : req.method;

      if (method === 'GET' && staticFiles.has(pathname)) return await serveStatic(req, res, staticFiles.get(pathname));

      let pathMatched = false;
      for (const [routeMethod, pattern, handler] of routes) {
        const match = pattern.exec(pathname);
        if (!match) continue;
        pathMatched = true;
        if (routeMethod === method) return await handler(req, res, ...match.slice(1));
      }
      if (pathMatched) throw new HttpError(405, 'method_not_allowed');
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'not_found');
      return await servePage(req, res, '404.html', {}, 404);
    } catch (err) {
      sendError(req, res, err);
    }
  }

  function sendError(req, res, err) {
    if (!(err instanceof HttpError)) {
      logger.error(`[http] ${req.method} ${req.url?.split('?')[0]} failed:`, err);
      err = new HttpError(500, 'internal_error');
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const headers = {};
    if (err.retryAfter) headers['Retry-After'] = String(err.retryAfter);
    const respond = () => sendJson(res, err.status, { error: err.code }, headers);

    // The request body was not consumed (e.g. a rejected upload). Small bodies are read and
    // discarded so the client reliably receives the error. For large ones the connection is
    // closed instead of reading possibly gigabytes of data we are going to throw away.
    if (!req.complete && !req.destroyed) {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared <= DRAIN_LIMIT) {
        req.on('error', () => {});
        req.once('end', respond);
        req.resume();
        return;
      }
      headers.Connection = 'close';
    }
    respond();
  }

  async function serveStatic(req, res, absPath, extraHeaders = {}, status = 200) {
    let stat;
    try {
      stat = await fsp.stat(absPath);
    } catch {
      throw new HttpError(404, 'not_found');
    }
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(status, {
      'Content-Type': MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(absPath), res).catch(() => {});
  }

  function servePage(req, res, file, headers, status) {
    return serveStatic(req, res, path.join(config.publicDir, file), headers, status);
  }

  function absoluteUrl(req, urlPath) {
    if (config.baseUrl) return config.baseUrl + urlPath;
    const proto = isSecureRequest(req, config) ? 'https' : 'http';
    const forwardedHost = config.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
    let host = forwardedHost || req.headers.host || '';
    if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) host = `localhost:${config.port}`;
    return `${proto}://${host}${urlPath}`;
  }

  // ----- access control helpers -----

  function requireDrop(id) {
    const meta = store.get(id);
    if (!meta) throw new HttpError(404, 'not_found');
    return meta;
  }

  function isOwner(req, meta) {
    const key = req.headers['x-owner-key'];
    return typeof key === 'string' && key.length > 0 && key.length <= 128 && safeEqual(sha256(key), meta.ownerKeyHash);
  }

  function hasAccess(req, meta) {
    if (!meta.password) return true;
    const token = parseCookies(req.headers.cookie)[`fd_${meta.id}`];
    return verifyAccessToken(secret, meta.id, token, store.now());
  }

  function requireAccess(req, meta) {
    if (!hasAccess(req, meta) && !isOwner(req, meta)) throw new HttpError(401, 'locked');
  }

  function view(meta, owner) {
    const result = {
      id: meta.id,
      type: meta.type,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      maxDownloads: meta.maxDownloads,
      downloads: meta.downloads,
      remaining: meta.maxDownloads > 0 ? meta.maxDownloads - meta.downloads : null,
      protected: Boolean(meta.password),
      owner,
      now: store.now(),
    };
    if (meta.type === 'files') {
      result.files = meta.files.map((f, index) => ({ index, name: f.name, size: f.size, type: f.type }));
      result.totalSize = meta.totalSize;
      result.zip = config.allowZip && meta.files.length > 1 && zipSupported(meta.files);
    } else {
      // Visitors only see the destination host until they decide to open the link.
      result.linkHost = new URL(meta.url).host;
      if (owner) result.url = meta.url;
    }
    return result;
  }

  // ----- route handlers -----

  function getConfig(req, res) {
    sendJson(res, 200, {
      siteName: config.siteName,
      version: pkg.version,
      maxUploadSize: config.maxUploadSize,
      maxFiles: config.maxFiles,
      maxExpiry: config.maxExpiry,
      defaultExpiry: config.defaultExpiry,
      expiryPresets: config.expiryPresets,
      maxDownloads: config.maxDownloadsLimit,
      allowUnlimitedDownloads: config.allowUnlimitedDownloads,
      allowLinks: config.allowLinks,
      allowZip: config.allowZip,
      uploadKeyRequired: Boolean(config.uploadPassword),
    });
  }

  /** Throws unless the request carries the instance's upload password (if one is configured). */
  function assertUploadKey(req, ip) {
    if (!config.uploadPassword) return;
    if (limiters.uploadKeyFailures.isBlocked(ip)) {
      throw Object.assign(new HttpError(429, 'rate_limited'), { retryAfter: limiters.uploadKeyFailures.retryAfter(ip) });
    }
    const key = req.headers['x-upload-key'];
    if (typeof key !== 'string' || !safeEqual(key, config.uploadPassword)) {
      limiters.uploadKeyFailures.hit(ip);
      throw new HttpError(401, 'upload_key_invalid');
    }
  }

  /** Lets the UI verify the upload password before it starts sending a large upload. */
  function checkUploadKey(req, res) {
    assertSameOrigin(req);
    assertUploadKey(req, clientIp(req, config.trustProxy));
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }

  async function createDrop(req, res) {
    assertSameOrigin(req);
    const ip = clientIp(req, config.trustProxy);
    assertUploadKey(req, ip);
    if (!limiters.uploads.hit(ip)) {
      throw Object.assign(new HttpError(429, 'rate_limited'), { retryAfter: limiters.uploads.retryAfter(ip) });
    }
    if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
      throw new HttpError(415, 'multipart_required');
    }
    const declared = Number(req.headers['content-length']) || 0;
    if (declared > config.maxUploadSize + 1024 * 1024) throw new HttpError(413, 'too_large');
    if (config.maxStorage && store.usage() + inflightBytes + declared > config.maxStorage + 1024 * 1024) {
      throw new HttpError(507, 'storage_full');
    }

    const tempDir = await store.createTempDir();
    let counted = 0;
    const onBytes = (n) => {
      counted += n;
      inflightBytes += n;
      return !config.maxStorage || store.usage() + inflightBytes <= config.maxStorage;
    };
    try {
      const { fields, files, total } = await parseUpload(req, tempDir, onBytes);
      const now = store.now();

      const type = fields.type === 'link' ? 'link' : 'files';
      const expiresIn = parseIntField(fields.expiresIn, config.defaultExpiry);
      if (!(expiresIn >= 60 && expiresIn <= config.maxExpiry)) throw new HttpError(400, 'invalid_expiry');

      const maxDownloads = parseIntField(fields.maxDownloads, config.allowUnlimitedDownloads ? 0 : 1);
      const validDownloads =
        (maxDownloads === 0 && config.allowUnlimitedDownloads) || (maxDownloads >= 1 && maxDownloads <= config.maxDownloadsLimit);
      if (!validDownloads) throw new HttpError(400, 'invalid_max_downloads');

      const password = fields.password || '';
      if (password.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, 'password_too_long');

      let url = null;
      if (type === 'link') {
        if (!config.allowLinks) throw new HttpError(400, 'links_disabled');
        if (files.length) throw new HttpError(400, 'unexpected_files');
        url = validateLink(fields.url);
      } else if (!files.length) {
        throw new HttpError(400, 'no_files');
      }

      let id;
      do id = randomId(12);
      while (store.exists(id));
      const ownerKey = randomToken(32);

      const meta = {
        v: 1,
        id,
        type,
        createdAt: now,
        expiresAt: now + expiresIn * 1000,
        maxDownloads,
        downloads: 0,
        password: password ? await hashPassword(password) : null,
        ownerKeyHash: sha256(ownerKey),
        totalSize: total,
        files: type === 'files' ? files : [],
        url,
      };
      await store.commit(tempDir, meta);

      const shareUrl = absoluteUrl(req, `/d/${id}`);
      sendJson(res, 201, {
        id,
        type,
        url: shareUrl,
        path: `/d/${id}`,
        ownerKey,
        manageUrl: `${shareUrl}#owner=${ownerKey}`,
        expiresAt: meta.expiresAt,
        maxDownloads,
        protected: Boolean(meta.password),
        now,
        files: files.length,
        totalSize: total,
      });
    } catch (err) {
      await store.discardTempDir(tempDir);
      throw err;
    } finally {
      inflightBytes -= counted;
    }
  }

  /** Streams multipart files straight to disk while enforcing size, count and storage limits. */
  function parseUpload(req, tempDir, onBytes) {
    return new Promise((resolve, reject) => {
      let parser;
      try {
        parser = busboy({
          headers: req.headers,
          defParamCharset: 'utf8',
          limits: {
            fields: 10,
            fieldSize: MAX_URL_LENGTH + 64,
            files: config.maxFiles,
            fileSize: config.maxUploadSize,
            parts: config.maxFiles + 10,
          },
        });
      } catch {
        reject(new HttpError(400, 'invalid_upload'));
        return;
      }

      const fields = Object.create(null);
      const files = [];
      const streams = [];
      const writes = [];
      let total = 0;
      let failed = null;
      let finished = false;

      const fail = (err) => {
        if (failed || finished) return;
        if (err instanceof HttpError) failed = err;
        else if (err?.code === 'ENOSPC') failed = new HttpError(507, 'storage_full');
        else failed = new HttpError(400, 'upload_failed');
        req.unpipe(parser);
        for (const stream of streams) stream.destroy(failed);
        Promise.allSettled(writes).then(() => reject(failed));
      };

      parser.on('field', (name, value, info) => {
        if (info.nameTruncated || info.valueTruncated) return fail(new HttpError(400, 'field_too_long'));
        if (['type', 'url', 'expiresIn', 'maxDownloads', 'password'].includes(name)) fields[name] = value;
      });

      parser.on('file', (name, stream, info) => {
        if (failed || name !== 'files') {
          stream.resume();
          return;
        }
        const index = files.length;
        const entry = { name: sanitizeFilename(info.filename), type: sanitizeMime(info.mimeType), size: 0, crc32: 0 };
        files.push(entry);
        streams.push(stream);

        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            total += chunk.length;
            entry.size += chunk.length;
            entry.crc32 = crc32(chunk, entry.crc32);
            const storageOk = onBytes(chunk.length);
            if (total > config.maxUploadSize) return callback(new HttpError(413, 'too_large'));
            if (!storageOk) return callback(new HttpError(507, 'storage_full'));
            callback(null, chunk);
          },
        });
        stream.on('limit', () => meter.destroy(new HttpError(413, 'too_large')));
        const out = fs.createWriteStream(path.join(tempDir, `file-${index}`), { flags: 'wx' });
        writes.push(pipeline(stream, meter, out).catch(fail));
      });

      parser.on('filesLimit', () => fail(new HttpError(400, 'too_many_files')));
      parser.on('fieldsLimit', () => fail(new HttpError(400, 'invalid_upload')));
      parser.on('partsLimit', () => fail(new HttpError(400, 'invalid_upload')));
      parser.on('error', () => fail(new HttpError(400, 'invalid_upload')));
      parser.on('close', async () => {
        await Promise.allSettled(writes);
        if (failed) return;
        finished = true;
        resolve({ fields, files, total });
      });
      req.on('close', () => {
        if (!req.complete) fail(new HttpError(400, 'upload_aborted'));
      });
      req.pipe(parser);
    });
  }

  function getDrop(req, res, id) {
    const meta = requireDrop(id);
    const owner = isOwner(req, meta);
    if (!owner && !hasAccess(req, meta)) {
      return sendJson(res, 401, { error: 'locked', id: meta.id, type: meta.type, expiresAt: meta.expiresAt, protected: true });
    }
    sendJson(res, 200, view(meta, owner));
  }

  async function unlockDrop(req, res, id) {
    assertSameOrigin(req);
    const meta = requireDrop(id);
    const owner = isOwner(req, meta);
    const body = await readJson(req);

    if (meta.password && !owner) {
      const ip = clientIp(req, config.trustProxy);
      if (limiters.unlockFailures.isBlocked(ip) || limiters.unlockFailuresPerDrop.isBlocked(id)) {
        const retryAfter = Math.max(limiters.unlockFailures.retryAfter(ip), limiters.unlockFailuresPerDrop.retryAfter(id));
        throw Object.assign(new HttpError(429, 'rate_limited'), { retryAfter });
      }
      const password = typeof body.password === 'string' ? body.password : '';
      const ok = password.length > 0 && password.length <= MAX_PASSWORD_LENGTH && (await verifyPassword(password, meta.password));
      if (!ok) {
        limiters.unlockFailures.hit(ip);
        limiters.unlockFailuresPerDrop.hit(id);
        throw new HttpError(403, 'wrong_password');
      }
    }

    const headers = {};
    if (meta.password) {
      const ttl = Math.max(1, Math.min(ACCESS_TTL, Math.ceil((meta.expiresAt - store.now()) / 1000)));
      const token = signAccessToken(secret, meta.id, ttl, store.now());
      const cookie = [`fd_${meta.id}=${token}`, `Path=/api/drops/${meta.id}`, `Max-Age=${ttl}`, 'HttpOnly', 'SameSite=Strict'];
      if (isSecureRequest(req, config)) cookie.push('Secure');
      headers['Set-Cookie'] = cookie.join('; ');
    }
    sendJson(res, 200, view(meta, owner), headers);
  }

  async function deleteDrop(req, res, id) {
    assertSameOrigin(req);
    const meta = requireDrop(id);
    if (!isOwner(req, meta)) throw new HttpError(403, 'forbidden');
    await store.remove(id);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }

  async function downloadFile(req, res, id, indexParam) {
    const meta = requireDrop(id);
    requireAccess(req, meta);
    const index = Number(indexParam);
    const file = meta.type === 'files' ? meta.files[index] : undefined;
    if (!file) throw new HttpError(404, 'not_found');

    // Open first, so a broken drop does not eat a download.
    let handle;
    try {
      handle = await fsp.open(store.filePath(id, index), 'r');
    } catch {
      throw new HttpError(404, 'not_found');
    }
    if (!store.claimDownload(id)) {
      await handle.close();
      throw new HttpError(404, 'not_found');
    }
    try {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': file.size,
        'Content-Disposition': contentDisposition(file.name),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      await pipeline(handle.createReadStream(), res);
    } catch {
      res.destroy(); // client went away; the download still counts
    } finally {
      await handle.close().catch(() => {});
      store.release(id);
    }
  }

  async function downloadZip(req, res, id) {
    const meta = requireDrop(id);
    requireAccess(req, meta);
    if (meta.type !== 'files' || !config.allowZip || meta.files.length < 2 || !zipSupported(meta.files)) {
      throw new HttpError(404, 'not_found');
    }
    const entries = meta.files.map((f, i) => ({ name: f.name, size: f.size, crc32: f.crc32, path: store.filePath(id, i) }));
    try {
      await Promise.all(entries.map((e) => fsp.access(e.path)));
    } catch {
      throw new HttpError(404, 'not_found');
    }
    if (!store.claimDownload(id)) throw new HttpError(404, 'not_found');

    try {
      const zip = createZip(entries, new Date(meta.createdAt));
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zip.size,
        'Content-Disposition': contentDisposition(`filedrop-${id}.zip`),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      await zip.write(res);
    } catch {
      res.destroy();
    } finally {
      store.release(id);
    }
  }

  function openLink(req, res, id) {
    assertSameOrigin(req);
    const meta = requireDrop(id);
    if (meta.type !== 'link') throw new HttpError(404, 'not_found');
    requireAccess(req, meta);
    const claimed = store.claimDownload(id, { streaming: false });
    if (!claimed) throw new HttpError(404, 'not_found');
    sendJson(res, 200, { url: claimed.url });
  }

  return {
    handle,
    close() {
      for (const limiter of Object.values(limiters)) limiter.stop();
    },
  };
}
