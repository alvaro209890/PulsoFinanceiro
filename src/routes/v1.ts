/**
 * Superfície humana `/api/v1` — docs/07-api-interna.md.
 *
 * Toda métrica exibida nasce aqui: o frontend formata data, moeda e cor e
 * NUNCA recomputa gasto, patrimônio, projeção ou severidade.
 *
 * Identidade humana é responsabilidade da borda (Cloudflare Access ou
 * proxy autenticador da tailnet, ADR-016/017). Enquanto o serviço só faz
 * bind em 127.0.0.1 e a publicação não ocorreu (docs/12 §2 regra 8), estas
 * rotas não criam token, cookie nem sessão própria — o dia da publicação
 * apenas acrescenta a validação de JWT na borda, sem mudar contrato.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import {
  DEFAULT_TIMEZONE,
  TIMEZONE_ALLOWLIST,
  daysBetween,
  isCivilDate,
  isMonth,
  monthOf,
  monthRange,
  today as todayCivil,
} from '../finance/time.js';
import { buildEnvelope, dataThroughInstant, etagFor } from '../finance/envelope.js';
import { computeOverview, OVERVIEW_METRIC_VERSION } from '../finance/overview.js';
import {
  computePace,
  DEFAULT_COMPARISON_MONTHS,
  MetricNotAvailable,
  PACE_METRIC_VERSION,
} from '../finance/pace.js';
import { CATEGORIES_METRIC_VERSION, computeCategories } from '../finance/categories.js';
import {
  CursorInvalid,
  listTransactions,
  TRANSACTIONS_DEFAULT_LIMIT,
  TRANSACTIONS_MAX_LIMIT,
} from '../finance/transactions.js';
import {
  BILLS_METRIC_VERSION,
  CardAccountNotFound,
  computeCreditCard,
  CREDIT_CARD_METRIC_VERSION,
  listBills,
} from '../finance/creditCard.js';
import {
  listRecurrences,
  RECURRENCES_METRIC_VERSION,
  type RecurrenceStatus,
} from '../finance/recurrences.js';
import { addDays } from '../finance/time.js';

const MAX_RANGE_DAYS = 366;

class ValidationError extends Error {
  constructor(public readonly details: Array<{ field: string; reason: string }>) {
    super('VALIDATION_ERROR');
  }
}

export function registerV1Routes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { from?: string; to?: string; timezone?: string } }>(
    '/api/v1/dashboard/overview',
    async (req, reply) => {
      try {
        const timezone = parseTimezone(req.query.timezone);
        const window = parseWindow(req.query.from, req.query.to, timezone);
        const result = computeOverview(db, { ...window, timezone });
        return send(db, reply, req, {
          metricVersion: OVERVIEW_METRIC_VERSION,
          filters: `${window.from}:${window.to}:${timezone}`,
          result,
        });
      } catch (err) {
        return fail(reply, req, err);
      }
    }
  );

  app.get<{ Querystring: { month?: string; comparisonMonths?: string; timezone?: string } }>(
    '/api/v1/analytics/monthly-pace',
    async (req, reply) => {
      try {
        const timezone = parseTimezone(req.query.timezone);
        const month = req.query.month ?? monthOf(todayCivil(timezone));
        if (!isMonth(month)) {
          throw new ValidationError([{ field: 'month', reason: 'Formato esperado: YYYY-MM' }]);
        }
        const comparisonMonths = parseComparisonMonths(req.query.comparisonMonths);
        const result = computePace(db, { month, comparisonMonths, timezone });
        return send(db, reply, req, {
          metricVersion: PACE_METRIC_VERSION,
          filters: `${month}:${comparisonMonths}:${timezone}`,
          result,
        });
      } catch (err) {
        return fail(reply, req, err);
      }
    }
  );

  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      rootCode?: string;
      includePending?: string;
      timezone?: string;
    };
  }>('/api/v1/analytics/categories', async (req, reply) => {
    try {
      const timezone = parseTimezone(req.query.timezone);
      const window = parseWindow(req.query.from, req.query.to, timezone);
      const rootCode = parseRootCode(req.query.rootCode);
      const includePending = parseBoolean(req.query.includePending, 'includePending');
      const result = computeCategories(db, {
        ...window,
        timezone,
        includePending,
        ...(rootCode ? { rootCode } : {}),
      });
      return send(db, reply, req, {
        metricVersion: CATEGORIES_METRIC_VERSION,
        filters: `${window.from}:${window.to}:${rootCode ?? 'all'}:${includePending}:${timezone}`,
        result,
      });
    } catch (err) {
      return fail(reply, req, err);
    }
  });

  app.get<{ Querystring: { billMonth?: string; timezone?: string } }>(
    '/api/v1/credit-card',
    async (req, reply) => {
      try {
        const timezone = parseTimezone(req.query.timezone);
        const billMonth = req.query.billMonth;
        if (billMonth !== undefined && !isMonth(billMonth)) {
          throw new ValidationError([{ field: 'billMonth', reason: 'Formato esperado: YYYY-MM' }]);
        }
        const result = computeCreditCard(db, { billMonth, timezone });
        return send(db, reply, req, {
          metricVersion: CREDIT_CARD_METRIC_VERSION,
          filters: `${billMonth ?? 'current'}:${timezone}`,
          result,
        });
      } catch (err) {
        return fail(reply, req, err);
      }
    }
  );

  app.get<{ Querystring: { accountId?: string; from?: string; to?: string; timezone?: string } }>(
    '/api/v1/bills',
    async (req, reply) => {
      try {
        const timezone = parseTimezone(req.query.timezone);
        const accountId = req.query.accountId;
        if (!accountId) {
          throw new ValidationError([{ field: 'accountId', reason: 'Obrigatório' }]);
        }
        // Padrão: últimos 12 meses de vencimento, `to` exclusivo.
        const defaultTo = addDays(todayCivil(timezone), 1);
        const defaultFrom = addDays(defaultTo, -366);
        const window = parseWindow(req.query.from ?? defaultFrom, req.query.to ?? defaultTo, timezone);
        const result = listBills(db, { accountId, ...window, timezone });
        return send(db, reply, req, {
          metricVersion: BILLS_METRIC_VERSION,
          filters: `${accountId}:${window.from}:${window.to}:${timezone}`,
          result: { ...result, data: result.data as unknown },
        });
      } catch (err) {
        return fail(reply, req, err);
      }
    }
  );

  app.get<{ Querystring: { status?: string; limit?: string; timezone?: string } }>(
    '/api/v1/analytics/recurrences',
    async (req, reply) => {
      try {
        const timezone = parseTimezone(req.query.timezone);
        const status =
          parseEnum(req.query.status, ['ACTIVE', 'DORMANT', 'RESUMED', 'ALL'] as const, 'status') ?? 'ALL';
        const limit = parseLimit(req.query.limit);
        const result = listRecurrences(db, {
          status: status as RecurrenceStatus | 'ALL',
          limit,
          timezone,
        });
        return send(db, reply, req, {
          metricVersion: RECURRENCES_METRIC_VERSION,
          filters: `${status}:${limit}:${timezone}`,
          result,
        });
      } catch (err) {
        return fail(reply, req, err);
      }
    }
  );

  // Contas em DTO local: sem número, titular, documento ou ID externo.
  app.get('/api/v1/accounts', async (_req, reply) => {
    const rows = db
      .prepare(
        `SELECT a.public_id, a.type, a.subtype, a.label, a.currency, a.balance, a.closing_balance,
                (SELECT captured_at FROM balance_snapshots s
                  WHERE s.account_public_id = a.public_id
                  ORDER BY s.snapshot_date DESC LIMIT 1) AS captured_at
           FROM accounts a ORDER BY a.label ASC, a.public_id ASC`
      )
      .all() as Array<{
        public_id: string;
        type: string;
        subtype: string | null;
        label: string;
        currency: string;
        balance: number | null;
        closing_balance: number | null;
        captured_at: string | null;
      }>;
    reply.header('Cache-Control', 'private, no-store');
    return {
      schemaVersion: '1.0',
      data: rows.map((r) => ({
        id: r.public_id,
        type: r.type,
        subtype: r.subtype,
        displayName: r.label,
        currencyCode: r.currency,
        snapshot: { capturedAt: r.captured_at, balance: r.closing_balance ?? r.balance },
      })),
    };
  });

  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      accountId?: string;
      categoryRoot?: string;
      status?: string;
      type?: string;
      eligibility?: string;
      cursor?: string;
      limit?: string;
      timezone?: string;
    };
  }>('/api/v1/transactions', async (req, reply) => {
    try {
      const timezone = parseTimezone(req.query.timezone);
      const window = parseWindow(req.query.from, req.query.to, timezone);
      const q = req.query;

      if (q.accountId) {
        const exists = db
          .prepare('SELECT 1 AS ok FROM accounts WHERE public_id = ?')
          .get(q.accountId) as { ok: number } | undefined;
        if (!exists) {
          return reply
            .code(404)
            .send(errorBody('RESOURCE_NOT_FOUND', 'Conta local inexistente.', req));
        }
      }

      const status = parseEnum(q.status, ['POSTED', 'PENDING', 'ALL'] as const, 'status') ?? 'ALL';
      const type = parseEnum(q.type, ['DEBIT', 'CREDIT', 'ALL'] as const, 'type') ?? 'ALL';
      const limit = parseLimit(q.limit);
      const categoryRoot = parseRootCode(q.categoryRoot);
      const eligibility =
        parseEnum(q.eligibility, ['SPEND', 'ALL'] as const, 'eligibility') ?? 'ALL';

      const page = listTransactions(db, {
        ...window,
        timezone,
        status,
        type,
        limit,
        eligibility,
        ...(q.accountId ? { accountId: q.accountId } : {}),
        ...(categoryRoot ? { categoryRoot } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      });

      reply.header('Cache-Control', 'private, no-store');
      return { schemaVersion: '1.0', data: page.data, nextCursor: page.nextCursor };
    } catch (err) {
      return fail(reply, req, err);
    }
  });
}

interface SendInput {
  metricVersion: string;
  filters: string;
  result: {
    period: { from: string; to: string; timezone: string };
    currencyCode: string;
    counts: Record<string, number>;
    quality: 'complete' | 'partial' | 'insufficient' | 'stale' | 'not_comparable' | 'unavailable';
    data: unknown;
  };
}

function send(db: Db, reply: FastifyReply, req: FastifyRequest, input: SendInput) {
  const etag = etagFor(db, input.metricVersion, input.filters);
  reply.header('Cache-Control', 'private, no-store');
  reply.header('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    return reply.code(304).send();
  }
  return buildEnvelope({
    period: input.result.period,
    currencyCode: input.result.currencyCode,
    counts: input.result.counts,
    metricVersion: input.metricVersion,
    quality: input.result.quality,
    dataThrough: dataThroughInstant(db),
    data: input.result.data,
  });
}

function fail(reply: FastifyReply, req: FastifyRequest, err: unknown) {
  if (err instanceof ValidationError) {
    return reply
      .code(400)
      .send(errorBody('VALIDATION_ERROR', 'Parâmetros inválidos.', req, err.details));
  }
  if (err instanceof MetricNotAvailable) {
    return reply
      .code(422)
      .send(errorBody('METRIC_NOT_AVAILABLE', 'Amostra insuficiente ou dado ausente.', req));
  }
  if (err instanceof CursorInvalid) {
    return reply
      .code(409)
      .send(errorBody('CURSOR_SNAPSHOT_EXPIRED', 'Cursor não pertence a uma visão válida.', req));
  }
  if (err instanceof CardAccountNotFound) {
    return reply
      .code(404)
      .send(errorBody('RESOURCE_NOT_FOUND', 'Conta de crédito local inexistente.', req));
  }
  throw err;
}

/** Erro nunca inclui stack, SQL, payload, header, segredo ou PII (docs/07). */
function errorBody(
  code: string,
  message: string,
  req: FastifyRequest,
  details?: Array<{ field: string; reason: string }>
) {
  return {
    error: {
      code,
      message,
      requestId: req.id,
      ...(details ? { details } : {}),
    },
  };
}

function parseTimezone(value: string | undefined): string {
  if (!value) return DEFAULT_TIMEZONE;
  if (!TIMEZONE_ALLOWLIST.includes(value)) {
    throw new ValidationError([{ field: 'timezone', reason: 'Timezone fora da allowlist' }]);
  }
  return value;
}

/** [from, to) com `to` exclusivo; ambos omitidos = mês corrente. */
function parseWindow(
  from: string | undefined,
  to: string | undefined,
  timezone: string
): { from: string; to: string } {
  const current = monthRange(monthOf(todayCivil(timezone)));
  const start = from ?? current.from;
  const end = to ?? current.to;
  const details: Array<{ field: string; reason: string }> = [];
  if (!isCivilDate(start)) details.push({ field: 'from', reason: 'Formato esperado: YYYY-MM-DD' });
  if (!isCivilDate(end)) details.push({ field: 'to', reason: 'Formato esperado: YYYY-MM-DD' });
  if (details.length > 0) throw new ValidationError(details);
  if (end <= start) {
    throw new ValidationError([{ field: 'to', reason: 'Fim exclusivo deve ser maior que o início' }]);
  }
  if (daysBetween(start, end) > MAX_RANGE_DAYS) {
    throw new ValidationError([{ field: 'to', reason: `Intervalo máximo de ${MAX_RANGE_DAYS} dias` }]);
  }
  return { from: start, to: end };
}

function parseComparisonMonths(value: string | undefined): number {
  if (value === undefined) return DEFAULT_COMPARISON_MONTHS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 3 || n > 12) {
    throw new ValidationError([{ field: 'comparisonMonths', reason: 'Inteiro entre 3 e 12' }]);
  }
  return n;
}

function parseRootCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{2}$/.test(value)) {
    throw new ValidationError([{ field: 'rootCode', reason: 'Dois dígitos' }]);
  }
  return value;
}

function parseBoolean(value: string | undefined, field: string): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError([{ field, reason: 'Use true ou false' }]);
}

function parseEnum<T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  field: string
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new ValidationError([{ field, reason: `Valores aceitos: ${allowed.join(', ')}` }]);
  }
  return value as T[number];
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return TRANSACTIONS_DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > TRANSACTIONS_MAX_LIMIT) {
    throw new ValidationError([{ field: 'limit', reason: `Inteiro entre 1 e ${TRANSACTIONS_MAX_LIMIT}` }]);
  }
  return n;
}
