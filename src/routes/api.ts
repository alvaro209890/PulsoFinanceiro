/**
 * Rotas da API interna — docs/07-api-interna.md (subconjunto base F0/F1).
 *
 * - /api/health: saúde do processo e do banco;
 * - /api/summary?period=YYYY-MM: fechamento mensal determinístico;
 * - /api/sync/run: dispara harvest manualmente (operacional, não UI);
 * - /api/webhooks/pluggy: entrada de webhook autenticada por Bearer
 *   (docs/04 §webhooks) — payload é apenas aviso; a verdade vem do GET.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { getConfig } from '../config.js';
import { PluggyClient, PluggyError } from '../pluggy/client.js';
import { syncItem } from '../jobs/sync.js';
import { monthlySummary } from '../metrics.js';

const PERIOD_RE = /^\d{4}-\d{2}$/;

export function registerRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/health', async () => {
    const integrity = db.pragma('quick_check', { simple: true });
    const lastRun = db.prepare('SELECT id, kind, ok, finished_at FROM sync_runs ORDER BY started_at DESC LIMIT 1').get();
    return {
      status: 'ok',
      db: integrity === 'ok' ? 'ok' : 'degraded',
      lastSync: lastRun ?? null,
      time: new Date().toISOString(),
    };
  });

  app.get<{ Querystring: { period?: string } }>(
    '/api/summary',
    { schema: { querystring: { type: 'object', properties: { period: { type: 'string' } } } } },
    async (req, reply) => {
      const period = req.query.period ?? new Date().toISOString().slice(0, 7);
      if (!PERIOD_RE.test(period)) {
        return reply.code(400).send({ error: 'PERIOD_INVALID', detail: 'use YYYY-MM' });
      }
      return monthlySummary(db, period);
    }
  );

  app.post('/api/sync/run', async (_req, reply) => {
    const cfg = getConfig();
    if (!cfg.pluggyItemId) {
      return reply.code(409).send({ error: 'NO_ITEM_CONFIGURED' });
    }
    const client = new PluggyClient(cfg.pluggyClientId, cfg.pluggyClientSecret);
    const result = await syncItem(db, client, cfg.pluggyItemId, 'daily');
    return reply.code(result.ok ? 200 : 502).send(result);
  });

  app.post<{
    Headers: { authorization?: string };
    Body: unknown;
  }>('/api/webhooks/pluggy', async (req, reply) => {
    const cfg = getConfig();
    const auth = req.headers.authorization ?? '';
    const expected = cfg.webhookBearerToken ? `Bearer ${cfg.webhookBearerToken}` : null;
    if (!expected || auth !== expected) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    // Payload é apenas sinal (docs/04 §4): registramos o evento de forma
    // sanitizada e respondemos rápido; a coleta real usa GET.
    app.log.info({ eventKeys: typeof req.body === 'object' && req.body ? Object.keys(req.body).length : 0 }, 'webhook recebido');
    return { received: true };
  });

  // Erros do cliente Pluggy viram resposta estruturada, nunca stack trace
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PluggyError) {
      return reply.code(err.status && err.status >= 400 && err.status < 500 ? 502 : 502).send({
        error: 'PLUGGY_UPSTREAM',
        code: err.errorCode,
        upstreamStatus: err.status,
      });
    }
    app.log.error({ err }, 'erro interno');
    return reply.code(500).send({ error: 'INTERNAL' });
  });
}
