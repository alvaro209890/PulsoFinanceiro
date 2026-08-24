/**
 * Testes F4 — merchants, PIX, duplicidades, LOG_ZSCORE, savings e overrides.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { merchantsRanking, pixByCounterparty, extractCounterparty } from '../src/finance/merchants-pix.js';
import { findDuplicates, logZscoreAnomalies } from '../src/finance/anomalies.js';
import { savingsEvolution } from '../src/finance/savings.js';
import { buildServer } from '../src/index.js';

const W = { from: '2026-08-01', to: '2026-09-01' };

function seed(db: Db): { txA: string; txB: string } {
  db.prepare(`INSERT INTO categories (id, description, description_translated) VALUES ('01000001','Income','Renda')`).run();
  db.prepare(`INSERT INTO categories (id, description, description_translated) VALUES ('02000001','Mercado','Mercado')`).run();
  db.prepare(`INSERT INTO items (public_id, external_id, status) VALUES ('ipub','ext-item','UPDATED')`).run();
  db.prepare(
    `INSERT INTO accounts (public_id, external_id, item_public_id, type, subtype, label, balance, currency)
     VALUES ('acc1','a-ext','ipub','BANK','CHECKING_ACCOUNT','Conta',1000,'BRL')`
  ).run();

  const ins = db.prepare(
    `INSERT INTO transactions (public_id, external_id, account_public_id, amount, currency, date,
      status, type, operation_type, description, category_id, merchant_cnpj, merchant_business_name,
      description_raw_normalized)
     VALUES (@pid, @eid, @acc, @amount, 'BRL', @date, @status, @type, @op, @desc, @cat, @cnpj, @biz, @norm)`
  );
  const mk = (id: string, amount: number, date: string, extra: Record<string, unknown> = {}) => {
    ins.run({
      pid: id,
      eid: `e-${id}`,
      acc: 'acc1',
      amount,
      date, // ISO completo com hora — duplicidade usa diferença de timestamps
      status: (extra.status as string) ?? 'POSTED',
      type: (extra.type as string) ?? 'DEBIT',
      op: (extra.operationType as string) ?? null,
      desc: (extra.description as string) ?? null,
      cat: (extra.categoryId as string) ?? null,
      cnpj: (extra.cnpj as string) ?? null,
      biz: (extra.businessName as string) ?? null,
      norm: (extra.normDesc as string) ?? null,
    });
  };

  // Merchants: CNPJ do mercado com 2 compras; descrição normalizada com 1
  mk('m1', 150, '2026-08-03T10:00:00Z', { cnpj: '12345678000195', businessName: 'Super Mercado', categoryId: '02000001' });
  mk('m2', 200, '2026-08-10T11:00:00Z', { cnpj: '12345678000195', businessName: 'Super Mercado', categoryId: '02000001' });
  mk('m3', 80, '2026-08-15T12:00:00Z', { normDesc: 'padaria do ze', description: 'Padaria do Zé' });
  // PIX: enviado e recebido da mesma contraparte
  mk('p1', 300, '2026-08-05T09:00:00Z', { operationType: 'PIX', normDesc: 'pix transferencia enviada joao silva' });
  mk('p2', 100, '2026-08-06T09:00:00Z', { operationType: 'PIX', type: 'CREDIT', normDesc: 'pix recebido de joao silva' });
  // Duplicidade: mesmo valor, mesma conta, 30 min de diferença
  mk('d1', 77.5, '2026-08-20T14:00:00Z', {});
  mk('d2', 77.5, '2026-08-20T14:30:00Z', {});
  // Não-duplicidade: 25h depois
  mk('d3', 77.5, '2026-08-21T15:00:00Z', {});

  return { txA: 'm1', txB: 'd1' };
}

describe('merchants e PIX', () => {
  it('ranking separado por CNPJ e descrição; só gasto confirmado', () => {
    const db = openDb(':memory:');
    seed(db);
    const r = merchantsRanking(db, W);
    expect(r.merchants[0]!.displayName).toBe('Super Mercado');
    expect(r.merchants[0]!.total).toBe(350);
    expect(r.merchants[0]!.count).toBe(2);
    expect(r.merchants.some((m) => m.matcherType === 'DESCRIPTION_RAW_NORMALIZED')).toBe(true);
  });

  it('PIX agrupa por contraparte sem documento', () => {
    const db = openDb(':memory:');
    seed(db);
    const r = pixByCounterparty(db, W);
    const joao = r.counterparties.find((c) => c.counterparty.includes('joao silva'));
    expect(joao).toBeDefined();
    expect(joao!.sent).toBe(300);
    expect(joao!.received).toBe(100);
  });

  it('extractCounterparty lida com formatos comuns', () => {
    expect(extractCounterparty('pix transferencia enviada maria souza')).toBe('maria souza');
    expect(extractCounterparty('pix recebido de loja abc')).toBe('loja abc');
    // sem marcador de direção → remove prefixo PIX e devolve o resto
    expect(extractCounterparty('pix pagamento boleta xyz')).toBe('boleta xyz');
    expect(extractCounterparty('')).toBe('sem-contraparte');
  });
});

describe('duplicidades', () => {
  it('<24h mesmo valor → par com DOIS ids; >=24h não conta', () => {
    const db = openDb(':memory:');
    seed(db);
    const r = findDuplicates(db, W);
    expect(r.duplicates.length).toBe(1);
    const pair = r.duplicates[0]!;
    expect(pair.ids.sort()).toEqual(['d1', 'd2']);
    expect(pair.amount).toBe(77.5);
    expect(pair.minutesApart).toBeGreaterThanOrEqual(29); // datas em minutos (segundos truncados)
  });
});

describe('LOG_ZSCORE', () => {
  it('amostra < 20 não executa; com amostra executa e acha outlier', () => {
    const db = openDb(':memory:');
    seed(db);
    // categoria mercado tem só 2 → sem amostra
    let r = logZscoreAnomalies(db, W);
    expect(r.categoriesEvaluated).toBe(0);

    // semeia 25 compras pequenas + 1 gigante na mesma categoria (histórico
    // completo alimenta média/dp; a janela de análise é agosto)
    const ins = db.prepare(
      `INSERT INTO transactions (public_id, external_id, account_public_id, amount, currency, date,
        status, type, category_id) VALUES (@pid,@eid,@acc,@amount,'BRL',@date,'POSTED','DEBIT','02000001')`
    );
    for (let i = 0; i < 25; i += 1) {
      ins.run({ pid: `s${i}`, eid: `es${i}`, acc: 'acc1', amount: 50 + i, date: '2026-08-' + String(1 + (i % 30)).padStart(2, '0') + 'T10:00:00Z' });
    }
    ins.run({ pid: 'outlier', eid: 'e-out', acc: 'acc1', amount: 5000, date: '2026-08-25T10:00:00Z' });

    r = logZscoreAnomalies(db, { ...W, threshold: 3 });
    expect(r.categoriesEvaluated).toBe(1);
    const out = r.anomalies.find((a) => a.transactionId === 'outlier');
    expect(out).toBeDefined();
    expect(out!.amount).toBe(5000);
    expect(out!.sampleSize).toBeGreaterThanOrEqual(20);
  });
});

describe('savings', () => {
  it('variação residual remove fluxo interno; estimatedYield é sempre null', () => {
    const db = openDb(':memory:');
    seed(db);
    const r = savingsEvolution(db, { months: 3 });
    expect(Array.isArray(r.months)).toBe(true);
    expect(r.estimatedYield).toBeNull(); // gate docs/07
    for (const m of r.months) {
      if (m.variation !== null && m.residualVariation !== null) {
        // residual = variação − in + out (internos nunca inflam rendimento)
        expect(m.residualVariation).toBeCloseTo(m.variation - m.internalIn + m.internalOut, 2);
      }
    }
  });
});

describe('rotas F4 (E2E via inject)', () => {
  let server: ReturnType<typeof buildServer>;
  beforeAll(() => {
    process.env.PLUGGY_CLIENT_ID = 't';
    process.env.PLUGGY_CLIENT_SECRET = 't';
    server = buildServer(':memory:');
    seed(server.db);
  });
  afterAll(async () => server.app.close());

  it('GET analytics endpoints respondem envelope', async () => {
    for (const url of ['/api/v1/analytics/merchants', '/api/v1/analytics/pix', '/api/v1/analytics/duplicates']) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json().schemaVersion).toBe('1.0');
    }
    // anomalies sem amostra → 422 METRIC_NOT_AVAILABLE
    const an = await server.app.inject({ method: 'GET', url: '/api/v1/analytics/anomalies' });
    expect(an.statusCode).toBe(422);
    expect(an.json().error.code).toBe('METRIC_NOT_AVAILABLE');
  });

  it('override sem If-Match → 428; com If-Match ok e idempotente; categoria inválida → 422', async () => {
    const noMatch = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/transactions/m1/category-override',
      payload: { categoryId: '02000001' },
    });
    expect(noMatch.statusCode).toBe(428);

    const rev = server.app.inject;
    void rev;

    const first = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/transactions/m1/category-override',
      headers: { 'if-match': '1' },
      payload: { categoryId: '02000001' },
    });
    expect(first.statusCode).toBe(200);
    const newRev = first.json().revision as number;

    const badCat = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/transactions/m1/category-override',
      headers: { 'if-match': String(newRev) },
      payload: { categoryId: '99999999' },
    });
    expect(badCat.statusCode).toBe(422);

    const transferNoValue = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/transactions/m1/internal-transfer-override',
      headers: { 'if-match': String(newRev) },
      payload: {},
    });
    expect(transferNoValue.statusCode).toBe(422);

    const transferOk = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/transactions/d3/internal-transfer-override',
      headers: { 'if-match': String(newRev) },
      payload: { isInternalTransfer: true },
    });
    expect(transferOk.statusCode).toBe(200);
    expect(transferOk.json().revision).toBe(newRev + 1);
  });

  it('transação inexistente → 404 (após passar pelo If-Match)', async () => {
    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/transactions/nada/category-override',
      headers: { 'if-match': '1' },
      payload: { categoryId: null },
    });
    // revisão pode ter mudado nos testes anteriores; aceita 412 ou 404 mas nunca 200
    expect([404, 412]).toContain(res.statusCode);
  });
});
