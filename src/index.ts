/**
 * Entrypoint — bind 127.0.0.1:3040 (docs/12 §2 regra 8).
 * Publicação só ocorre após decisão de borda (Cloudflare Access, ADR-016/017).
 */
import Fastify from 'fastify';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { openDb } from './db/index.js';
import { registerRoutes } from './routes/api.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerStatic } from './static.js';
import { PluggyClient } from './pluggy/client.js';
import { startHarvestScheduler } from './jobs/scheduler.js';

export function buildServer(dbPath?: string) {
  const cfg = { ...getConfig(), ...(dbPath ? { dbPath } : {}) };
  const app = Fastify({ logger: true });
  const db = openDb(cfg.dbPath);
  registerRoutes(app, db);
  registerAnalyticsRoutes(app, db);
  registerStatic(app);

  // F1: agendador do harvest diário (docs/06 §6) — só liga com item configurado
  let scheduler: ReturnType<typeof startHarvestScheduler> | null = null;
  if (cfg.pluggyItemId) {
    scheduler = startHarvestScheduler(db, new PluggyClient(cfg.pluggyClientId, cfg.pluggyClientSecret), cfg.pluggyItemId);
    app.log.info(`harvest diário agendado para o item ${cfg.pluggyItemId}`);
  }

  return {
    app,
    db,
    close: async () => {
      scheduler?.stop();
      await app.close();
      db.close();
    },
  };
}

/**
 * "Fui executado direto?" comparando caminhos REAIS. A versão anterior fazia
 * `argv[1].split('/')`, que no Windows não separa nada (o caminho usa `\`):
 * o processo subia, não escutava porta nenhuma e saía com código 0.
 */
const entry = process.argv[1] ? resolve(process.argv[1]) : null;
const isMain = entry !== null && resolve(fileURLToPath(import.meta.url)) === entry;
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
