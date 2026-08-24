/**
 * Rotas F4 — análises e correções dirigidas (docs/12 §8).
 *
 * Somente estas DUAS rotas de mutação existem no tráfego do frontend:
 *   PUT /api/v1/transactions/:id/category-override
 *   PUT /api/v1/transactions/:id/internal-transfer-override
 *
 * Overrides: taxonomia existente, If-Match obrigatório (ETag de revisão),
 * idempotente na repetição, recalcula métricas dependentes no backend
 * (bump data_revision) preservando decisão original para auditoria.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { buildEnvelope, bumpDataRevision, dataRevision, dataThroughInstant } from '../finance/envelope.js';
import {
  MERCHANTS_METRIC_VERSION,
  PIX_METRIC_VERSION,
  merchantsRanking,
  pixByCounterparty,
} from '../finance/merchants-pix.js';
import { ANOMALIES_METRIC_VERSION, findDuplicates, logZscoreAnomalies } from '../finance/anomalies.js';
import { SAVINGS_METRIC_VERSION, savingsEvolution } from '../finance/savings.js';
import { MetricNotAvailable } from '../finance/pace.js';

/** Mesma forma do ValidationError do v1.ts (não exportado lá). */
class ValidationError extends Error {
  constructor(public readonly details: Array<{ field: string; reason: string }>) {
    super('VALIDATION_ERROR');
  }
}

function errorBody(code: string, message: string, req: FastifyRequest) {
  return { error: { code, message, requestId: req.id } };
}

export function registerAnalyticsRoutes(app: FastifyInstance, db: Db): void {
  const windowOf = (req: FastifyRequest): { from: string; to: string; timezone?: string } => {
    const q = (req.query ?? {}) as { from?: string; to?: string };
    // Janela default: últimos 90 dias (analytics olham para trás, não o mês corrente)
    const to = q.to;
    const from = q.from;
    if (!to && !from) {
      const end = new Date();
      const start = new Date(end.getTime() - 90 * 86_400_000);
      return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
    }
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new ValidationError([{ field: 'from/to', reason: 'Formato esperado: YYYY-MM-DD' }]);
    }
    if (to <= from) throw new ValidationError([{ field: 'to', reason: 'Fim deve ser maior que início' }]);
    return { from, to };
  };

  // ── GET /api/v1/analytics/merchants ────────────────────────────────────
  app.get('/api/v1/analytics/merchants', async (req, reply) => {
    try {
      const w = windowOf(req);
      const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 25), 100);
      const r = merchantsRanking(db, { ...w, limit });
      reply.header('ETag', `W/"${MERCHANTS_METRIC_VERSION}:${dataRevision(db)}"`);
      return buildEnvelope({
        period: { from: w.from, to: w.to },
        currencyCode: r.currencyCode,
        counts: { merchants: r.merchants.length, distinctKeys: r.sampleCount },
        metricVersion: MERCHANTS_METRIC_VERSION,
        quality: r.merchants.length ? 'complete' : 'insufficient',
        dataThrough: dataThroughInstant(db),
        data: { ranking: r.merchants },
      });
    } catch (err) {
      return fail(reply, req, err);
    }
  });

  // ── GET /api/v1/analytics/pix ──────────────────────────────────────────
  app.get('/api/v1/analytics/pix', async (req, reply) => {
    try {
      const w = windowOf(req);
      const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 25), 100);
      const r = pixByCounterparty(db, { ...w, limit });
      reply.header('ETag', `W/"${PIX_METRIC_VERSION}:${dataRevision(db)}"`);
      return buildEnvelope({
        period: { from: w.from, to: w.to },
        currencyCode: r.currencyCode,
        counts: { counterparties: r.counterparties.length },
        metricVersion: PIX_METRIC_VERSION,
        quality: r.counterparties.length ? 'complete' : 'insufficient',
        dataThrough: dataThroughInstant(db),
        data: { counterparties: r.counterparties },
      });
    } catch (err) {
      return fail(reply, req, err);
    }
  });

  // ── GET /api/v1/analytics/duplicates ──────────────────────────────────
  app.get('/api/v1/analytics/duplicates', async (req, reply) => {
    try {
      const w = windowOf(req);
      const r = findDuplicates(db, w);
      reply.header('ETag', `W/"${ANOMALIES_METRIC_VERSION}:dup:${dataRevision(db)}"`);
      return buildEnvelope({
        period: { from: w.from, to: w.to },
        currencyCode: r.currencyCode,
        counts: { pairs: r.duplicates.length },
        metricVersion: ANOMALIES_METRIC_VERSION,
        quality: 'complete',
        dataThrough: dataThroughInstant(db),
        data: { duplicates: r.duplicates },
      });
    } catch (err) {
      return fail(reply, req, err);
    }
  });

  // ── GET /api/v1/analytics/anomalies ───────────────────────────────────
  app.get<{ Querystring: { threshold?: string } }>('/api/v1/analytics/anomalies', async (req, reply) => {
    try {
      const w = windowOf(req);
      let threshold = Number((req.query as { threshold?: string }).threshold ?? 3);
      if (!Number.isFinite(threshold) || threshold < 2 || threshold > 6) threshold = 3;
      const r = logZscoreAnomalies(db, { ...w, threshold });
      if (r.categoriesEvaluated === 0) {
        throw new MetricNotAvailable('Nenhuma categoria com amostra >= 20 transações');
      }
      reply.header('ETag', `W/"${ANOMALIES_METRIC_VERSION}:z:${threshold}:${dataRevision(db)}"`);
      return buildEnvelope({
        period: { from: w.from, to: w.to },
        currencyCode: 'BRL',
        counts: {
          anomalies: r.anomalies.length,
          categoriesEvaluated: r.categoriesEvaluated,
          categoriesSkippedLowSample: r.categoriesSkippedLowSample,
        },
        metricVersion: ANOMALIES_METRIC_VERSION,
        quality: 'complete',
        dataThrough: dataThroughInstant(db),
        data: { detector: 'LOG_ZSCORE', threshold, anomalies: r.anomalies.slice(0, 50) },
      });
    } catch (err) {
      return fail(reply, req, err);
    }
  });

  // ── GET /api/v1/analytics/savings ─────────────────────────────────────
  app.get<{ Querystring: { months?: string } }>('/api/v1/analytics/savings', async (req, reply) => {
    try {
      const months = Number((req.query as { months?: string }).months ?? 6);
      const r = savingsEvolution(db, {
        months: Number.isFinite(months) ? months : 6,
      });
      reply.header('ETag', `W/"${SAVINGS_METRIC_VERSION}:${dataRevision(db)}"`);
      return buildEnvelope({
        period: {
          from: r.months[0]?.month ?? '',
          to: r.months[r.months.length - 1]?.month ?? '',
        },
        currencyCode: 'BRL',
        counts: { months: r.months.length },
        metricVersion: SAVINGS_METRIC_VERSION,
        quality: r.months.length >= 3 ? 'complete' : 'partial',
        dataThrough: dataThroughInstant(db),
        data: {
          months: r.months,
          medianResidual: r.medianResidual,
          goalMonthly: r.goalMonthly,
          streakMonths: r.streakMonths,
          estimatedYield: null, // gate docs/07: só após semântica da fonte confirmada
        },
      });
    } catch (err) {
      return fail(reply, req, err);
    }
  });

  // ── PUT /api/v1/transactions/:id/category-override ────────────────────
  app.put<{
    Params: { id: string };
    Body: { categoryId?: string | null };
    Headers: { 'if-match'?: string };
  }>('/api/v1/transactions/:id/category-override', async (req, reply) => {
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) {
      return reply.code(428).send(errorBody('IF_MATCH_REQUIRED', 'Header If-Match é obrigatório.', req));
    }
    const currentRev = dataRevision(db);
    if (!matchRevision(ifMatch, currentRev)) {
      return reply.code(412).send(errorBody('PRECONDITION_FAILED', 'Revisão desatualizada — recarregue.', req));
    }

    const tx = db.prepare('SELECT public_id FROM transactions WHERE public_id = ?').get(req.params.id);
    if (!tx) {
      return reply.code(404).send(errorBody('NOT_FOUND', 'Transação não encontrada.', req));
    }

    const categoryId = req.body?.categoryId ?? null;
    if (categoryId !== null) {
      const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
      if (!cat) {
        return reply.code(422).send(errorBody('CATEGORY_INVALID', 'Categoria fora da taxonomia.', req));
      }
    }

    const run = db.transaction(() => {
      db.prepare(
        `UPDATE transactions SET category_id = ?, category_override = 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_id = ?`
      ).run(categoryId, req.params.id);
      bumpDataRevision(db); // invalida ETag de todas as métricas dependentes
    });
    run();

    return { schemaVersion: '1.0', overridden: true, field: 'category', revision: dataRevision(db) };
  });

  // ── PUT /api/v1/transactions/:id/internal-transfer-override ───────────
  app.put<{
    Params: { id: string };
    Body: { isInternalTransfer?: boolean | null };
    Headers: { 'if-match'?: string };
  }>('/api/v1/transactions/:id/internal-transfer-override', async (req, reply) => {
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) {
      return reply.code(428).send(errorBody('IF_MATCH_REQUIRED', 'Header If-Match é obrigatório.', req));
    }
    const currentRev = dataRevision(db);
    if (!matchRevision(ifMatch, currentRev)) {
      return reply.code(412).send(errorBody('PRECONDITION_FAILED', 'Revisão desatualizada — recarregue.', req));
    }

    const tx = db.prepare('SELECT public_id FROM transactions WHERE public_id = ?').get(req.params.id);
    if (!tx) {
      return reply.code(404).send(errorBody('NOT_FOUND', 'Transação não encontrada.', req));
    }

    const value = req.body?.isInternalTransfer;
    if (value !== true && value !== false && value !== null) {
      return reply
        .code(422)
        .send(errorBody('VALUE_INVALID', 'isInternalTransfer aceita true, false ou null (remove override).', req));
    }

    const run = db.transaction(() => {
      if (value === null) {
        // null remove o override — volta a derivação automática
        db.prepare(
          `UPDATE transactions SET is_internal_transfer = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_id = ?`
        ).run(req.params.id);
      } else {
        db.prepare(
          `UPDATE transactions SET is_internal_transfer = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE public_id = ?`
        ).run(value ? 1 : 0, req.params.id);
      }
      bumpDataRevision(db);
    });
    run();

    return { schemaVersion: '1.0', overridden: true, field: 'internalTransfer', revision: dataRevision(db) };
  });
}

/** If-Match aceita a revisão exata ou W/"rev". */
function matchRevision(ifMatch: string, revision: number): boolean {
  const clean = ifMatch.replace(/^W\//, '').replace(/"/g, '');
  return clean === String(revision);
}

function fail(reply: FastifyReply, req: FastifyRequest, err: unknown) {
  if (err instanceof ValidationError) {
    return reply.code(400).send(errorBody('VALIDATION_ERROR', 'Parâmetros inválidos.', req));
  }
  if (err instanceof MetricNotAvailable) {
    return reply.code(422).send(errorBody('METRIC_NOT_AVAILABLE', err.message, req));
  }
  throw err;
}
