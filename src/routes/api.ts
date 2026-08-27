/**
 * Rotas da API interna — docs/07-api-interna.md (subconjunto base F0/F1).
 *
 * - /api/health: saúde do processo e do banco;
 * - /api/summary?period=YYYY-MM: fechamento mensal determinístico;
 * - /api/sync/run: dispara harvest manualmente (operacional, não UI);
 * - /api/webhooks/pluggy: entrada de webhook autenticada por Bearer
 *   (docs/04 §webhooks) — payload é apenas aviso; a verdade vem do GET.
 *
 * A superfície de métricas da F2 (`/api/v1/*`) vive em `./v1.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { getConfig } from '../config.js';
import { PluggyClient, PluggyError } from '../pluggy/client.js';
import { syncItem } from '../jobs/sync.js';
import { monthlySummary } from '../metrics.js';
import { receiveEnvelope, processInbox } from '../jobs/inbox.js';
import { registerV1Routes } from './v1.js';

const PERIOD_RE = /^\d{4}-\d{2}$/;

export function registerRoutes(app: FastifyInstance, db: Db): void {
  registerV1Routes(app, db);

  app.get('/api/health', async () => {
    const integrity = db.pragma('quick_check', { simple: true });
    const lastRun = db.prepare('SELECT id, kind, ok, finished_at FROM sync_runs ORDER BY started_at DESC LIMIT 1').get();
    const item = db.prepare('SELECT public_id, stale_bucket, next_auto_sync_at FROM items LIMIT 1').get() as
      | { public_id: string; stale_bucket: string | null; next_auto_sync_at: string | null }
      | undefined;
    return {
      status: 'ok',
      db: integrity === 'ok' ? 'ok' : 'degraded',
      sync: item
        ? {
            staleness: item.stale_bucket ?? 'OK',
            policyVersion: 'STALE_POLICY_V1',
            nextAutoSyncAt: item.next_auto_sync_at,
          }
        : null,
      lastSyncRun: lastRun ?? null,
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
    // Recepção síncrona, trabalho assíncrono (docs/06 §7): valida envelope,
    // persiste idempotente por eventId e responde rápido; processamento
    // real acontece no worker da inbox.
    const body = req.body as Record<string, unknown> | null;
    const accepted = receiveEnvelope(db, {
      eventId: typeof body?.['eventId'] === 'string' ? (body['eventId'] as string) : '',
      eventType: (body?.['event'] ?? '') as never,
      itemId: typeof body?.['itemId'] === 'string' ? (body['itemId'] as string) : null,
      accountId: typeof body?.['accountId'] === 'string' ? (body['accountId'] as string) : null,
      triggeredBy: typeof body?.['triggeredBy'] === 'string' ? (body['triggeredBy'] as string) : null,
      transactionIds: Array.isArray(body?.['transactionIds']) ? (body['transactionIds'] as string[]) : null,
    });
    if (!accepted.accepted) {
      req.log.warn({ body, reason: accepted.reason }, 'webhook rejeitado');
      return reply.code(422).send({ error: accepted.reason });
    }
    if (accepted.ignored) {
      req.log.info({ eventType: (body as Record<string, unknown>)?.['event'], reason: accepted.reason }, 'webhook ACK (tipo ignorado)');
      return { received: true, ignored: true };
    }
    void processInbox(db, new PluggyClient(cfg.pluggyClientId, cfg.pluggyClientSecret), cfg.pluggyItemId!)
      .catch(() => {});
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
