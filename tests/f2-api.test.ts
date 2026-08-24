/**
 * Contrato da superfície `/api/v1` (F2) — envelope, validação, códigos de
 * erro e ETag. Sem rede e sem segredo real: fastify.inject sobre SQLite
 * em memória.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { ulid } from 'ulid';
import { today, monthOf, monthRange } from '../src/finance/time.js';

let server: ReturnType<typeof buildServer>;
const TODAY = today();
const MONTH = monthOf(TODAY);
const { from: MONTH_FROM, to: MONTH_TO } = monthRange(MONTH);

beforeAll(() => {
  process.env.PLUGGY_CLIENT_ID = 'test-id';
  process.env.PLUGGY_CLIENT_SECRET = 'test-secret';
  delete process.env.PLUGGY_ITEM_ID;
  server = buildServer(':memory:');

  const db = server.db;
  db.prepare('INSERT INTO items (public_id, external_id, status) VALUES (?,?,?)').run(
    'item-1',
    'ext-item-1',
    'UPDATED'
  );
  db.prepare(
    `INSERT INTO accounts (public_id, external_id, item_public_id, type, subtype, label, balance, currency)
     VALUES ('acc-bank','ext-acc-bank','item-1','BANK',NULL,'Conta corrente',1000,'BRL')`
  ).run();
  db.prepare(
    `INSERT INTO categories (id, description, description_translated, level1_prefix)
     VALUES ('08000000','Compras','Compras','08')`
  ).run();
  db.prepare(
    `INSERT INTO transactions
       (public_id, external_id, account_public_id, amount, currency, date, status, type,
        category_id, is_internal_transfer, raw_json_sanitized)
     VALUES (?,?,'acc-bank',120.5,'BRL',?,'POSTED','DEBIT','08000000',0,'{}')`
  ).run(ulid(), `ext-${ulid()}`, TODAY);
});

afterAll(async () => {
  await server.close();
});

const ENVELOPE_KEYS = [
  'schemaVersion',
  'computedAt',
  'dataThrough',
  'period',
  'currencyCode',
  'counts',
  'metricVersion',
  'quality',
  'data',
];

describe('envelope comum', () => {
  it('overview devolve todos os campos obrigatórios do envelope', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/v1/dashboard/overview?from=${MONTH_FROM}&to=${MONTH_TO}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const key of ENVELOPE_KEYS) expect(body).toHaveProperty(key);
    expect(body.metricVersion).toBe('dashboard-overview.v1');
    expect(body.period.timezone).toBe('America/Sao_Paulo');
    expect(body.data.monthSpend.posted).toBe(120.5);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('monthly-pace e categories seguem o mesmo envelope', async () => {
    const pace = await server.app.inject({
      method: 'GET',
      url: `/api/v1/analytics/monthly-pace?month=${MONTH}`,
    });
    expect(pace.statusCode).toBe(200);
    expect(pace.json().metricVersion).toBe('monthly-pace.v1');
    expect(pace.json().data.confirmedSpend.amount).toBe(120.5);

    const cats = await server.app.inject({
      method: 'GET',
      url: `/api/v1/analytics/categories?from=${MONTH_FROM}&to=${MONTH_TO}`,
    });
    expect(cats.statusCode).toBe(200);
    expect(cats.json().metricVersion).toBe('categories-rollup.v1');
    expect(cats.json().data.total.postedAmount).toBe(120.5);
  });

  it('ETag estável responde 304 com If-None-Match', async () => {
    const url = `/api/v1/dashboard/overview?from=${MONTH_FROM}&to=${MONTH_TO}`;
    const first = await server.app.inject({ method: 'GET', url });
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();

    const second = await server.app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });
});

describe('validação e erros', () => {
  it('período inválido, invertido ou acima de 366 dias → 400 VALIDATION_ERROR', async () => {
    const badFormat = await server.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview?from=marco&to=2026-04-01',
    });
    expect(badFormat.statusCode).toBe(400);
    expect(badFormat.json().error.code).toBe('VALIDATION_ERROR');
    expect(badFormat.json().error).toHaveProperty('requestId');

    const inverted = await server.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview?from=2026-04-01&to=2026-03-01',
    });
    expect(inverted.statusCode).toBe(400);

    const tooLong = await server.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview?from=2025-01-01&to=2026-06-01',
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('timezone fora da allowlist → 400', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview?timezone=Marte/Olympus',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].field).toBe('timezone');
  });

  it('comparisonMonths fora de 3..12 e includePending não booleano → 400', async () => {
    const comparison = await server.app.inject({
      method: 'GET',
      url: `/api/v1/analytics/monthly-pace?month=${MONTH}&comparisonMonths=2`,
    });
    expect(comparison.statusCode).toBe(400);

    const pending = await server.app.inject({
      method: 'GET',
      url: `/api/v1/analytics/categories?from=${MONTH_FROM}&to=${MONTH_TO}&includePending=sim`,
    });
    expect(pending.statusCode).toBe(400);
  });

  it('mês fora da cobertura local → 422 METRIC_NOT_AVAILABLE', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/analytics/monthly-pace?month=2019-01',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('METRIC_NOT_AVAILABLE');
  });

  it('conta local inexistente → 404 e cursor inválido → 409', async () => {
    const notFound = await server.app.inject({
      method: 'GET',
      url: '/api/v1/transactions?accountId=nao-existe',
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error.code).toBe('RESOURCE_NOT_FOUND');

    const badCursor = await server.app.inject({
      method: 'GET',
      url: '/api/v1/transactions?cursor=cursor-invalido',
    });
    expect(badCursor.statusCode).toBe(409);
    expect(badCursor.json().error.code).toBe('CURSOR_SNAPSHOT_EXPIRED');
  });

  it('erro nunca vaza stack, SQL ou payload', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview?from=xx',
    });
    const raw = res.body;
    expect(raw).not.toMatch(/SELECT|stack|sqlite|\.env/i);
  });
});

describe('evidências', () => {
  it('lista transações com DTO local, sem campo sensível', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/v1/transactions?from=${MONTH_FROM}&to=${MONTH_TO}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].amount).toBe(120.5);
    expect(body.data[0].category.rootCode).toBe('08');
    expect(body.data[0]).not.toHaveProperty('rawJsonSanitized');
    expect(body.data[0]).not.toHaveProperty('externalId');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
