import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { contentDisposition, crc32, parseBytes, parseDuration, randomId, sanitizeFilename, sanitizeMime } from '../src/util.js';
import { hashPassword, verifyPassword, signAccessToken, verifyAccessToken, clientIp } from '../src/security.js';

test('sanitizeFilename strips paths, control and bidi characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(sanitizeFilename('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(sanitizeFilename('a\u0000b\nc.txt'), 'abc.txt');
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('..'), 'file');
  assert.equal(sanitizeFilename(undefined), 'file');
  const long = sanitizeFilename(`${'x'.repeat(300)}.tar.gz`);
  assert.ok(long.length <= 200);
  assert.ok(long.endsWith('.gz'));
});

test('sanitizeMime only keeps well-formed types', () => {
  assert.equal(sanitizeMime('image/png'), 'image/png');
  assert.equal(sanitizeMime('text/html; charset=utf-8'), 'application/octet-stream');
  assert.equal(sanitizeMime('<script>'), 'application/octet-stream');
});

test('contentDisposition encodes unicode and neutralises quotes', () => {
  const header = contentDisposition('a "quoted"; name ü.txt');
  assert.match(header, /^attachment; filename="a _quoted__ name _\.txt"; filename\*=UTF-8''/);
  assert.ok(header.includes('%C3%BC'));
});

test('parses sizes and durations', () => {
  assert.equal(parseBytes('1GB'), 1024 ** 3);
  assert.equal(parseBytes('1.5 mb'), 1.5 * 1024 ** 2);
  assert.equal(parseBytes('0'), 0);
  assert.equal(parseBytes('lots'), null);
  assert.equal(parseDuration('7d'), 604800);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('1y'), null);
});

test('randomId is base62 and unique', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => randomId(12)));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{12}$/);
});

test('crc32 matches zlib, also when chained', () => {
  const data = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(data), 0x414fa339);
  assert.equal(crc32(data.subarray(10), crc32(data.subarray(0, 10))), zlib.crc32(data) >>> 0);
});

test('password hashing round-trip', async () => {
  const hash = await hashPassword('hunter2');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('hunter2', hash), true);
  assert.equal(await verifyPassword('hunter3', hash), false);
  assert.equal(await verifyPassword('hunter2', 'garbage'), false);
});

test('access tokens are bound to drop and time', () => {
  const now = Date.now();
  const token = signAccessToken('s3cret', 'dropA', 60, now);
  assert.equal(verifyAccessToken('s3cret', 'dropA', token, now), true);
  assert.equal(verifyAccessToken('s3cret', 'dropB', token, now), false);
  assert.equal(verifyAccessToken('other', 'dropA', token, now), false);
  assert.equal(verifyAccessToken('s3cret', 'dropA', token, now + 61_000), false);
  assert.equal(verifyAccessToken('s3cret', 'dropA', 'nonsense', now), false);
});

test('clientIp honours TRUST_PROXY hops', () => {
  const req = { socket: { remoteAddress: '10.0.0.2' }, headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } };
  assert.equal(clientIp(req, 0), '10.0.0.2');
  assert.equal(clientIp(req, 1), '1.2.3.4');
  assert.equal(clientIp(req, 2), '6.6.6.6');
  assert.equal(clientIp(req, 9), '6.6.6.6');
});
