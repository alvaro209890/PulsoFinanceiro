/**
 * Entrypoint — bind 127.0.0.1:3040 (docs/12 §2 regra 8).
 * Publicação só ocorre após decisão de borda (Cloudflare Access, ADR-016/017).
 */
import Fastify from 'fastify';
import { getConfig } from './config.js';
import { openDb } from './db/index.js';
import { registerRoutes } from './routes/api.js';
import { registerStatic } from './static.js';

export function buildServer(dbPath?: string) {
  const cfg = { ...getConfig(), ...(dbPath ? { dbPath } : {}) };
  const app = Fastify({ logger: true });
  const db = openDb(cfg.dbPath);
  registerRoutes(app, db);
  registerStatic(app);
  return { app, db };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const cfg = getConfig();
  const { app } = buildServer(cfg.dbPath);
  app
    .listen({ port: cfg.port, host: cfg.host })
    .then((address) => {
      app.log.info(`PulsoFinanceiro em ${address}`);
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
