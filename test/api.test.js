import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig } from '../src/config.js';
import { start } from '../src/server.js';

const silent = { log() {}, error() {} };

async function boot(env = {}, { dataDir } = {}) {
  dataDir ||= await fs.mkdtemp(path.join(os.tmpdir(), 'filedrop-test-'));
  const clock = { now: Date.now() };
  const config = loadConfig({
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: '0',
    MAX_UPLOAD_SIZE: '1MB',
    MAX_FILES: '5',
    RATE_LIMIT_UPLOADS: '0',
    ...env,
  });
  const instance = await start(config, { now: () => clock.now, logger: silent });
  return {
    ...instance,
    base: instance.url,
    dataDir,
    clock,
    async close({ keepData = false } = {}) {
      await instance.stop();
      if (!keepData) await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function createDrop(base, { files = [['hello.txt', 'hello world']], fields = {}, headers = {} } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ expiresIn: '3600', maxDownloads: '0', ...fields })) form.append(key, value);
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  const res = await fetch(`${base}/api/drops`, { method: 'POST', body: form, headers });
  return { res, body: await res.json().catch(() => null) };
}

async function waitFor(check, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** Minimal ZIP reader for verifying our own archives. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), crc, data: buf.subarray(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe('XyoLua FileDrop API', () => {
  let app;
  before(async () => {
    app = await boot();
  });
  after(async () => {
    await app.close();
  });

  test('serves config and pages with security headers', async () => {
    const res = await fetch(`${app.base}/api/config`);
    assert.equal(res.status, 200);
    const config = await res.json();
    assert.equal(config.maxUploadSize, 1024 * 1024);
    assert.equal(config.maxFiles, 5);
    assert.equal(config.uploadKeyRequired, false);

    const page = await fetch(`${app.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await page.text(), /<title>/);
  });

  test('uploads, describes and downloads a file', async () => {
    const { res, body } = await createDrop(app.base, { files: [['Über uns ü.txt', 'grüße']] });
    assert.equal(res.status, 201);
    assert.match(body.id, /^[A-Za-z0-9]{12}$/);
    assert.equal(body.url, `${app.base}/d/${body.id}`);
    assert.ok(body.manageUrl.includes('#owner='));

    const meta = await (await fetch(`${app.base}/api/drops/${body.id}`)).json();
    assert.equal(meta.files.length, 1);
    assert.equal(meta.files[0].name, 'Über uns ü.txt');
    assert.equal(meta.files[0].size, Buffer.byteLength('grüße'));
    assert.equal(meta.owner, false);
    assert.equal(meta.remaining, null);

    const dl = await fetch(`${app.base}/api/drops/${body.id}/files/0`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''%C3%9Cber%20uns%20%C3%BC\.txt/);
    assert.equal(await dl.text(), 'grüße');

    const after = await (await fetch(`${app.base}/api/drops/${body.id}`)).json();
    assert.equal(after.downloads, 1);

    const page = await fetch(`${app.base}/d/${body.id}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  });

  test('deletes a drop after its last allowed download', async () => {
    const { body } = await createDrop(app.base, { fields: { maxDownloads: '1' } });
    const first = await fetch(`${app.base}/api/drops/${body.id}/files/0`);
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${app.base}/api/drops/${body.id}/files/0`);
    assert.equal(second.status, 404);
    assert.equal((await fetch(`${app.base}/api/drops/${body.id}`)).status, 404);
    assert.ok(await waitFor(async () => !(await exists(path.join(app.dataDir, 'drops', body.id)))), 'files removed from disk');
  });

  test('protects drops with a password', async () => {
    const { body } = await createDrop(app.base, { fields: { password: 'correct horse' } });
    assert.equal(body.protected, true);

    const locked = await fetch(`${app.base}/api/drops/${body.id}`);
    assert.equal(locked.status, 401);
    const lockedBody = await locked.json();
    assert.equal(lockedBody.error, 'locked');
    assert.equal(lockedBody.files, undefined, 'no file names before unlocking');

    assert.equal((await fetch(`${app.base}/api/drops/${body.id}/files/0`)).status, 401);

    const unlock = (password) =>
      fetch(`${app.base}/api/drops/${body.id}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

    const wrong = await unlock('wrong');
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers.get('set-cookie'), null);

    const ok = await unlock('correct horse');
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^fd_${body.id}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, new RegExp(`Path=/api/drops/${body.id}`));
    assert.equal((await ok.json()).files.length, 1);

    const token = cookie.split(';')[0];
    const dl = await fetch(`${app.base}/api/drops/${body.id}/files/0`, { headers: { Cookie: token } });
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'hello world');

    // the token is bound to this drop
    const other = await createDrop(app.base, { fields: { password: 'x' } });
    const forged = token.replace(`fd_${body.id}`, `fd_${other.body.id}`);
    assert.equal((await fetch(`${app.base}/api/drops/${other.body.id}`, { headers: { Cookie: forged } })).status, 401);

    // unlocking requires JSON (CSRF protection)
    const form = await fetch(`${app.base}/api/drops/${body.id}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=correct+horse',
    });
    assert.equal(form.status, 415);
  });

  test('rate-limits password guessing', async () => {
    const limited = await boot({ RATE_LIMIT_UNLOCK: '3' });
    try {
      const { body } = await createDrop(limited.base, { fields: { password: 'secret' } });
      const attempt = (password) =>
        fetch(`${limited.base}/api/drops/${body.id}/unlock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
      for (let i = 0; i < 3; i++) assert.equal((await attempt('nope')).status, 403);
      const blocked = await attempt('secret');
      assert.equal(blocked.status, 429, 'even the right password is refused while blocked');
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    } finally {
      await limited.close();
    }
  });

  test('expires drops and cleans them up', async () => {
    const { body } = await createDrop(app.base, { fields: { expiresIn: '600' } });
    assert.equal((await fetch(`${app.base}/api/drops/${body.id}`)).status, 200);
    app.clock.now += 601_000;
    try {
      assert.equal((await fetch(`${app.base}/api/drops/${body.id}`)).status, 404);
      assert.equal((await fetch(`${app.base}/api/drops/${body.id}/files/0`)).status, 404);
      await app.store.cleanup();
      assert.equal(await exists(path.join(app.dataDir, 'drops', body.id)), false);
    } finally {
      app.clock.now -= 601_000;
    }
  });

  test('lets the owner see stats and delete early', async () => {
    const { body } = await createDrop(app.base, { fields: { password: 'pw', maxDownloads: '5' } });
    const asOwner = await fetch(`${app.base}/api/drops/${body.id}`, { headers: { 'X-Owner-Key': body.ownerKey } });
    assert.equal(asOwner.status, 200);
    const meta = await asOwner.json();
    assert.equal(meta.owner, true);
    assert.equal(meta.maxDownloads, 5);

    const del = (key) => fetch(`${app.base}/api/drops/${body.id}`, { method: 'DELETE', headers: key ? { 'X-Owner-Key': key } : {} });
    assert.equal((await del()).status, 403);
    assert.equal((await del('wrong-key')).status, 403);
    assert.equal((await del(body.ownerKey)).status, 204);
    assert.equal((await fetch(`${app.base}/api/drops/${body.id}`, { headers: { 'X-Owner-Key': body.ownerKey } })).status, 404);
    assert.ok(await waitFor(async () => !(await exists(path.join(app.dataDir, 'drops', body.id)))));
  });

  test('shares links without revealing them up front', async () => {
    const { res, body } = await createDrop(app.base, {
      files: [],
      fields: { type: 'link', url: 'https://example.com/some/secret/path?x=1', maxDownloads: '1' },
    });
    assert.equal(res.status, 201);
    const meta = await (await fetch(`${app.base}/api/drops/${body.id}`)).json();
    assert.equal(meta.type, 'link');
    assert.equal(meta.linkHost, 'example.com');
    assert.equal(meta.url, undefined);

    const owner = await (await fetch(`${app.base}/api/drops/${body.id}`, { headers: { 'X-Owner-Key': body.ownerKey } })).json();
    assert.equal(owner.url, 'https://example.com/some/secret/path?x=1');

    const open = () => fetch(`${app.base}/api/drops/${body.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const first = await open();
    assert.equal(first.status, 200);
    assert.equal((await first.json()).url, 'https://example.com/some/secret/path?x=1');
    assert.equal((await open()).status, 404);
  });

  test('rejects unsafe links', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'not a url', '']) {
      const { res, body } = await createDrop(app.base, { files: [], fields: { type: 'link', url } });
      assert.equal(res.status, 400, url);
      assert.equal(body.error, 'invalid_url');
    }
  });

  test('builds a valid ZIP of all files', async () => {
    const files = [
      ['a.txt', 'first file'],
      ['a.txt', 'same name, different file'],
      ['ü/../ñ.bin', Buffer.from([0, 1, 2, 3, 255])],
    ];
    const { body } = await createDrop(app.base, { files });
    const meta = await (await fetch(`${app.base}/api/drops/${body.id}`)).json();
    assert.equal(meta.zip, true);
    assert.deepEqual(
      meta.files.map((f) => f.name),
      ['a.txt', 'a.txt', 'ñ.bin'],
    );

    const res = await fetch(`${app.base}/api/drops/${body.id}/zip`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), buf.length);

    const entries = readZip(buf);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['a.txt', 'a (2).txt', 'ñ.bin'],
    );
    entries.forEach((entry, i) => {
      const expected = Buffer.from(files[i][1]);
      assert.deepEqual(entry.data, expected);
      assert.equal(entry.crc, zlib.crc32(expected) >>> 0);
    });
    assert.equal((await (await fetch(`${app.base}/api/drops/${body.id}`)).json()).downloads, 1);
  });

  test('enforces upload limits', async () => {
    const tooMany = await createDrop(app.base, { files: Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, 'x']) });
    assert.equal(tooMany.res.status, 400);
    assert.equal(tooMany.body.error, 'too_many_files');

    const tooBig = await createDrop(app.base, { files: [['big.bin', Buffer.alloc(1024 * 1024 + 10)]] });
    assert.equal(tooBig.res.status, 413);

    const noFiles = await createDrop(app.base, { files: [] });
    assert.equal(noFiles.body.error, 'no_files');

    for (const expiresIn of ['10', String(8 * 86400), 'abc']) {
      const { res, body } = await createDrop(app.base, { fields: { expiresIn } });
      assert.equal(res.status, 400);
      assert.equal(body.error, 'invalid_expiry');
    }
    for (const maxDownloads of ['-1', '1001', '1.5']) {
      const { res, body } = await createDrop(app.base, { fields: { maxDownloads } });
      assert.equal(res.status, 400);
      assert.equal(body.error, 'invalid_max_downloads');
    }

    const notMultipart = await fetch(`${app.base}/api/drops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(notMultipart.status, 415);

    // nothing may be left behind from failed uploads
    assert.ok(await waitFor(async () => (await fs.readdir(path.join(app.dataDir, 'tmp'))).length === 0), 'temp dir is empty');
  });

  test('refuses cross-site requests from browsers', async () => {
    const form = new FormData();
    form.append('files', new Blob(['x']), 'x.txt');
    const res = await fetch(`${app.base}/api/drops`, { method: 'POST', body: form, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 403);
  });

  test('never serves files outside the public directory', async () => {
    for (const p of ['/assets/../package.json', '/assets/..%2Fpackage.json', '/assets/%2e%2e/src/app.js', '/src/app.js', '/.secret', '/data/.secret']) {
      const res = await fetch(`${app.base}${p}`);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(await res.text(), /createApp|"dependencies"/);
    }
    for (const p of ['/api/drops/..%2F..%2Fpackage.json', '/api/drops/abc/files/0', '/api/drops/AAAAAAAAAAAA/zip']) {
      assert.equal((await fetch(`${app.base}${p}`)).status, 404, p);
    }
    assert.equal((await fetch(`${app.base}/api/drops`, { method: 'DELETE' })).status, 405);
  });
});

describe('instance options', () => {
  test('requires the upload password when configured', async () => {
    const app = await boot({ UPLOAD_PASSWORD: 'let-me-in' });
    try {
      const config = await (await fetch(`${app.base}/api/config`)).json();
      assert.equal(config.uploadKeyRequired, true);
      assert.equal((await createDrop(app.base)).res.status, 401);
      assert.equal((await createDrop(app.base, { headers: { 'X-Upload-Key': 'nope' } })).res.status, 401);
      assert.equal((await createDrop(app.base, { headers: { 'X-Upload-Key': 'let-me-in' } })).res.status, 201);

      const check = (key) => fetch(`${app.base}/api/upload-key`, { method: 'POST', headers: key ? { 'X-Upload-Key': key } : {} });
      assert.equal((await check('nope')).status, 401);
      assert.equal((await check('let-me-in')).status, 204);
    } finally {
      await app.close();
    }
  });

  test('respects the storage limit', async () => {
    const app = await boot({ MAX_STORAGE: '2KB' });
    try {
      assert.equal((await createDrop(app.base, { files: [['a.bin', Buffer.alloc(1500)]] })).res.status, 201);
      const full = await createDrop(app.base, { files: [['b.bin', Buffer.alloc(1500)]] });
      assert.equal(full.res.status, 507);
      assert.equal(full.body.error, 'storage_full');
    } finally {
      await app.close();
    }
  });

  test('keeps drops across restarts', async () => {
    const first = await boot();
    const { body } = await createDrop(first.base, { fields: { maxDownloads: '3' } });
    await (await fetch(`${first.base}/api/drops/${body.id}/files/0`)).text();
    await first.close({ keepData: true });

    const second = await boot({}, { dataDir: first.dataDir });
    try {
      const meta = await (await fetch(`${second.base}/api/drops/${body.id}`)).json();
      assert.equal(meta.downloads, 1);
      assert.equal(meta.remaining, 2);
      const del = await fetch(`${second.base}/api/drops/${body.id}`, { method: 'DELETE', headers: { 'X-Owner-Key': body.ownerKey } });
      assert.equal(del.status, 204);
    } finally {
      await second.close();
    }
  });

  test('rejects invalid configuration', () => {
    assert.throws(() => loadConfig({ MAX_UPLOAD_SIZE: 'lots' }), /MAX_UPLOAD_SIZE/);
    assert.throws(() => loadConfig({ BASE_URL: 'drop.example.com' }), /BASE_URL/);
    assert.throws(() => loadConfig({ PORT: '-1' }), /PORT/);
  });
});
