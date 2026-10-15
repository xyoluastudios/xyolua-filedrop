#!/usr/bin/env node
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { DropStore } from './store.js';
import { createApp } from './app.js';
import { formatBytes, randomToken } from './util.js';

/** Uses SECRET from the environment, or a random secret persisted in the data directory. */
async function loadSecret(config) {
  if (config.secret) return config.secret;
  const file = path.join(config.dataDir, '.secret');
  try {
    const existing = (await fsp.readFile(file, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // first start
  }
  const secret = randomToken(48);
  await fsp.writeFile(file, secret, { mode: 0o600 });
  return secret;
}

/**
 * Starts FileDrop. Used by the CLI entry point below and by the test suite.
 * @returns {Promise<{ server: http.Server, store: DropStore, url: string, stop(): Promise<void> }>}
 */
export async function start(config = loadConfig(), { now, logger = console } = {}) {
  await fsp.mkdir(config.dataDir, { recursive: true });
  const store = new DropStore({ dataDir: config.dataDir, now, logger });
  await store.init();
  const secret = await loadSecret(config);
  const app = await createApp({ config, store, secret, logger });

  const server = http.createServer(app.handle);
  server.requestTimeout = 0; // large uploads may take a long time
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const cleanupTimer = setInterval(() => {
    store.cleanup().catch((err) => logger.error('[cleanup]', err));
  }, config.cleanupInterval * 1000);
  cleanupTimer.unref();

  const { port } = server.address();
  const url = `http://${config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host}:${port}`;

  return {
    server,
    store,
    url,
    async stop() {
      clearInterval(cleanupTimer);
      app.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      });
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  try {
    const instance = await start(config);
    const stats = instance.store.stats();
    console.log(`
  ${config.siteName} is running
  -> ${config.baseUrl || instance.url}

  data directory   ${config.dataDir}
  max upload       ${formatBytes(config.maxUploadSize)} / ${config.maxFiles} files
  storage limit    ${config.maxStorage ? formatBytes(config.maxStorage) : 'unlimited'}
  upload password  ${config.uploadPassword ? 'required' : 'off (anyone can upload)'}
  stored drops     ${stats.drops} (${formatBytes(stats.bytes)})
`);

    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received, shutting down...`);
      await instance.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : err);
    process.exit(1);
  }
}
