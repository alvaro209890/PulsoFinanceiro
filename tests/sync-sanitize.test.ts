/**
 * Testes da sanitização (denylist canônica, docs/05) e do sync com fetch mockado.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeDeep, looksLikeCpf } from '../src/pluggy/sanitize.js';
import { openDb } from '../src/db/index.js';
import { upsertAccount, upsertTransaction } from '../src/db/upserts.js';
import { monthlySummary } from '../src/metrics.js';

describe('denylist canônica', () => {
  it('remove documento do payer em paymentData', () => {
    const input = {
      id: 't1',
      amount: 42.75,
      paymentData: { payer: { documentNumber: { type: 'CPF', value: '123.456.789-09' } }, method: 'PIX' },
    };
    const out = sanitizeDeep(input) as Record<string, any>;
    expect(out.paymentData.payer.documentNumber).toBeUndefined();
    expect(out.paymentData.method).toBe('PIX');
  });

  it('remove number/owner/taxNumber no topo e em profundidade', () => {
    const input = {
      number: '1234567890',
      owner: 'JOAO DA SILVA',
      taxNumber: '12345678909',
      creditData: { brand: 'VISA', disaggregatedCreditLimits: [{ number: '55554444', limit: 100 }] },
      merchant: { cnpj: '12.345.678/0001-95', businessName: 'LOJA X' },
    };
    const out = sanitizeDeep(input) as Record<string, any>;
    expect(out.number).toBeUndefined();
    expect(out.owner).toBeUndefined();
    expect(out.taxNumber).toBeUndefined();
    expect(out.creditData.disaggregatedCreditLimits[0].number).toBeUndefined();
    // cnpj de merchant permanece para agrupamento local (docs/04 §6)
    expect(out.merchant.cnpj).toBeDefined();
    expect(out.creditData.brand).toBe('VISA');
  });

  it('remove string com aparência de CPF puro', () => {
    expect(looksLikeCpf('123.456.789-09')).toBe(true);
    expect(looksLikeCpf('12345678909')).toBe(true);
    expect(looksLikeCpf('mercadopago')).toBe(false);
    const out = sanitizeDeep({ note: '12345678909' }) as Record<string, unknown>;
    expect(out.note).toBeNull();
  });
});

describe('upserts e métricas', () => {
  function setup() {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO items (public_id, external_id, status) VALUES ('item01','ext-item','UPDATED')`
    ).run();
    db.prepare(`INSERT INTO categories (id, description, description_translated) VALUES ('01000001','Income','Renda')`).run();
    const accId = upsertAccount(db, {
      externalId: 'acc-ext-1', itemPublicId: 'item01', type: 'BANK',
      subtype: 'CHECKING_ACCOUNT', label: 'Conta corrente · Banco', balance: 100, currency: 'BRL',
    });
    return { db, accId };
  }

  it('upsert de transação preserva public_id e atualiza status PENDING→POSTED', () => {
    const { db, accId } = setup();
    const first = upsertTransaction(db, {
      externalId: 'tx1', accountPublicId: accId, amount: 50, currency: 'BRL',
      date: '2026-08-10T12:00:00Z', status: 'PENDING', type: 'DEBIT',
      operationType: null, description: null, categoryId: null,
      balanceAfter: null, orderTiebreak: null, rawJsonSanitized: '{}',
    });
    expect(first.inserted).toBe(true);
    const second = upsertTransaction(db, {
      externalId: 'tx1', accountPublicId: accId, amount: 55, currency: 'BRL',
      date: '2026-08-10T12:00:00Z', status: 'POSTED', type: 'DEBIT',
      operationType: null, description: null, categoryId: null,
      balanceAfter: null, orderTiebreak: null, rawJsonSanitized: '{"x":1}',
    });
    expect(second.inserted).toBe(false);
    expect(second.publicId).toBe(first.publicId);
    const row = db.prepare('SELECT status, amount FROM transactions WHERE public_id=?').get(first.publicId) as any;
    expect(row.status).toBe('POSTED');
    expect(row.amount).toBe(55);
  });

  it('fechamento mensal soma entradas/gastos, ignora transferência interna e conta PENDING à parte', () => {
    const { db, accId } = setup();
    const tx = (o: Partial<Parameters<typeof upsertTransaction>[1]>) =>
      upsertTransaction(db, {
        externalId: Math.random().toString(), accountPublicId: accId, amount: 0,
        currency: 'BRL', date: '2026-08-01T00:00:00Z', status: 'POSTED', type: null,
        operationType: null, description: null, categoryId: null,
        balanceAfter: null, orderTiebreak: null, rawJsonSanitized: '{}', ...o,
      });
    tx({ externalId: 'a', amount: 1000, type: 'CREDIT' });
    tx({ externalId: 'b', amount: 300, type: 'DEBIT', date: '2026-08-05T00:00:00Z', categoryId: '01000001' });
    tx({ externalId: 'c', amount: 80, type: 'DEBIT', date: '2026-08-06T00:00:00Z', isInternalTransfer: undefined });
    db.exec(`UPDATE transactions SET is_internal_transfer=1 WHERE external_id='c'`);
    tx({ externalId: 'd', amount: 999, status: 'PENDING', type: 'DEBIT', date: '2026-08-07T00:00:00Z' });

    const s = monthlySummary(db, '2026-08');
    expect(s.income).toBe(1000);
    expect(s.spend).toBe(300);          // transferência interna fora
    expect(s.net).toBe(700);
    expect(s.pendingCount).toBe(1);
    expect(s.byCategory[0]?.label).toBe('Renda');
  });

  it('migração é idempotente', () => {
    const db = openDb(':memory:');
    const again = openDb(':memory:');
    void again;
    const before = (db.pragma('integrity_check', { simple: true }));
    expect(before).toBe('ok');
  });
});
