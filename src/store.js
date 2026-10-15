import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomId } from './util.js';

const ID_RE = /^[A-Za-z0-9]{8,32}$/;

/**
 * File-system backed drop storage.
 *
 *   data/drops/<id>/meta.json   metadata (see README "Data layout")
 *   data/drops/<id>/file-<n>    uploaded files, stored under neutral names
 *   data/tmp/                   uploads in progress (wiped on start)
 *
 * All metadata is also kept in memory, so the app is meant to run as a single process.
 */
export class DropStore {
  constructor({ dataDir, now = () => Date.now(), logger = console }) {
    this.dropsDir = path.join(dataDir, 'drops');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.now = now;
    this.logger = logger;
    this.drops = new Map();
    this.active = new Map(); // id -> number of downloads currently streaming
    this.writes = new Map(); // id -> pending metadata write (serializes writes per drop)
    this.removing = new Map(); // id -> pending removal
  }

  static isValidId(id) {
    return ID_RE.test(String(id));
  }

  async init() {
    await fsp.mkdir(this.dropsDir, { recursive: true });
    await fsp.rm(this.tmpDir, { recursive: true, force: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });

    for (const entry of await fsp.readdir(this.dropsDir, { withFileTypes: true })) {
      const dir = path.join(this.dropsDir, entry.name);
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
        if (meta.id !== entry.name) throw new Error('id mismatch');
        this.drops.set(meta.id, meta);
      } catch {
        // Incomplete or corrupt drop: nothing can be served from it.
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    await this.cleanup();
  }

  isAvailable(meta) {
    if (meta.deleted) return false;
    if (meta.expiresAt <= this.now()) return false;
    if (meta.maxDownloads > 0 && meta.downloads >= meta.maxDownloads) return false;
    return true;
  }

  /** Returns the metadata of an available drop, or null if it is unknown, expired, used up or deleted. */
  get(id) {
    if (!ID_RE.test(String(id))) return null;
    const meta = this.drops.get(id);
    if (!meta) return null;
    if (!this.isAvailable(meta)) {
      this.removeWhenIdle(id);
      return null;
    }
    return meta;
  }

  exists(id) {
    return this.drops.has(id);
  }

  filePath(id, index) {
    return path.join(this.dropsDir, id, `file-${index}`);
  }

  async createTempDir() {
    const dir = path.join(this.tmpDir, randomId(16));
    await fsp.mkdir(dir);
    return dir;
  }

  async discardTempDir(dir) {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  /** Moves a finished upload from the temp dir into place and registers it. */
  async commit(tempDir, meta) {
    await fsp.writeFile(path.join(tempDir, 'meta.json'), JSON.stringify(meta));
    await fsp.rename(tempDir, path.join(this.dropsDir, meta.id));
    this.drops.set(meta.id, meta);
    return meta;
  }

  /** Atomically writes the current in-memory metadata of a drop to disk. */
  persist(id) {
    const previous = this.writes.get(id) || Promise.resolve();
    const next = previous.then(async () => {
      const meta = this.drops.get(id);
      if (!meta) return;
      const file = path.join(this.dropsDir, id, 'meta.json');
      const tmp = `${file}.${randomId(6)}.tmp`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(meta));
        await fsp.rename(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (err.code !== 'ENOENT') this.logger.error(`[store] could not save drop ${id}: ${err.message}`);
      }
    });
    this.writes.set(id, next);
    next.finally(() => {
      if (this.writes.get(id) === next) this.writes.delete(id);
    });
    return next;
  }

  /**
   * Counts one download (or link open) and returns the drop, or null if it is no longer available.
   * With `streaming`, the drop is kept on disk until release() is called.
   */
  claimDownload(id, { streaming = true } = {}) {
    const meta = this.get(id);
    if (!meta) return null;
    meta.downloads += 1;
    meta.lastDownloadAt = this.now();
    if (streaming) this.active.set(id, (this.active.get(id) || 0) + 1);
    this.persist(id);
    if (!this.isAvailable(meta)) this.removeWhenIdle(id);
    return meta;
  }

  release(id) {
    const remaining = (this.active.get(id) || 1) - 1;
    if (remaining > 0) this.active.set(id, remaining);
    else this.active.delete(id);
    const meta = this.drops.get(id);
    if (meta && !this.isAvailable(meta)) this.removeWhenIdle(id);
  }

  removeWhenIdle(id) {
    if (this.active.get(id)) return; // release() of the last stream triggers the removal
    this.remove(id).catch((err) => this.logger.error(`[store] could not remove drop ${id}: ${err.message}`));
  }

  /**
   * Deletes a drop. It becomes unavailable immediately; the files are removed as soon
   * as no download of it is streaming anymore (open files cannot be deleted on Windows).
   */
  async remove(id) {
    const meta = this.drops.get(id);
    if (!meta) return false;
    if (!meta.deleted) {
      meta.deleted = true;
      await this.persist(id); // remember the deletion even if removing the files fails
    }
    if (this.active.get(id)) return true;
    if (this.removing.has(id)) return this.removing.get(id);

    const job = (async () => {
      await (this.writes.get(id) || Promise.resolve());
      await fsp.rm(path.join(this.dropsDir, id), { recursive: true, force: true, maxRetries: 3 });
      this.drops.delete(id);
      return true;
    })().finally(() => this.removing.delete(id));
    this.removing.set(id, job);
    return job;
  }

  /** Removes everything that expired, ran out of downloads or was deleted. */
  async cleanup() {
    let removed = 0;
    for (const [id, meta] of this.drops) {
      if (this.isAvailable(meta) || this.active.get(id)) continue;
      try {
        await this.remove(id);
        removed += 1;
      } catch (err) {
        this.logger.error(`[store] cleanup failed for ${id}: ${err.message}`);
      }
    }
    return removed;
  }

  /** Bytes currently occupied by stored drops. */
  usage() {
    let total = 0;
    for (const meta of this.drops.values()) total += meta.totalSize || 0;
    return total;
  }

  stats() {
    let available = 0;
    for (const meta of this.drops.values()) if (this.isAvailable(meta)) available += 1;
    return { drops: available, bytes: this.usage() };
  }
}
