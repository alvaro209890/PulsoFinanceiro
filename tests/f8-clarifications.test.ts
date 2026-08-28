import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { hashToken } from '../src/routes/agentAuth.js';
import * as client from '../src/ai/client.js';

describe('Clarificação Privada e Query de IA F8 (docs/07 §H5/F8)', () => {
  let server: ReturnType<typeof buildServer>;
  const AGENT_TOKEN = 'secret-token-hermes-f8-full-scopes-12345';
  const AGENT_TOKEN_HASH = hashToken(AGENT_TOKEN);

  beforeAll(() => {
    process.env.PLUGGY_CLIENT_ID = 'test-id';
    process.env.PLUGGY_CLIENT_SECRET = 'test-secret';
    server = buildServer(':memory:');
    const db = server.db;

    // Cadastra o principal de teste com todos os escopos da F8
    db.prepare(
      `INSERT INTO service_principals (id, name, current_token_hash, scopes_json, active)
       VALUES ('sp_hermes_f8', 'hermes-f8', ?, ?, 1)`
    ).run(
      AGENT_TOKEN_HASH,
      JSON.stringify([
        'metrics:read',
        'events:read',
        'events:claim',
        'events:ack',
        'clarifications:read_private',
        'clarifications:write',
        'ai:query',
      ])
    );

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
       VALUES ('08000000','Compras','Compras','08'), ('01000000','Alimentacao','Alimentação','01')`
    ).run();
    db.prepare(
      `INSERT INTO transactions
         (public_id, external_id, account_public_id, amount, currency, date, status, type,
          category_id, is_internal_transfer, raw_json_sanitized)
       VALUES ('tx_unknown','ext_unknown','acc-bank',85.50,'BRL','2026-08-15','POSTED','DEBIT',NULL,0,'{}')`
    ).run();

    // Insere uma clarificação aberta
    db.prepare(
      `INSERT INTO transaction_clarifications
         (id, transaction_public_id, version, status, context_json, suggestions_json, matcher_kind, matcher_confidence)
       VALUES (
         'clarif_1',
         'tx_unknown',
         'v_initial_1',
         'OPEN',
         '{"direction":"DEBIT"}',
         '[{"suggestionRef":"sug_1","categoryId":"08000000","label":"Compras"},{"suggestionRef":"sug_2","categoryId":"01000000","label":"Alimentação"}]',
         'SOURCE_FINGERPRINT_V1',
         'HIGH'
       )`
    ).run();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/agent/v1/clarifications/:id devolve contexto e valor exato mínimo', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/agent/v1/clarifications/clarif_1',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.data.id).toBe('clarif_1');
    expect(json.data.transactionId).toBe('tx_unknown');
    expect(json.data.context.amount).toBe(85.5);
    expect(json.data.categorySuggestions.length).toBe(2);
    expect(json.data.applyToSimilar.available).toBe(true);
  });

  it('POST /api/agent/v1/clarifications/:id/resolve resolve clarificação e cria regra', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/agent/v1/clarifications/clarif_1/resolve',
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        'If-Match': 'v_initial_1',
        'Idempotency-Key': 'idemp_key_123',
      },
      payload: {
        resolutionType: 'ACCEPT_CATEGORY_SUGGESTION',
        suggestionRef: 'sug_1',
        applyToSimilar: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.data.status).toBe('RESOLVED');
    expect(json.data.category.id).toBe('08000000');
    expect(json.data.rule.status).toBe('CREATED');

    // Confere se a transação foi atualizada no banco
    const tx = server.db.prepare('SELECT category_id, category_override FROM transactions WHERE public_id = ?').get('tx_unknown') as any;
    expect(tx.category_id).toBe('08000000');
    expect(tx.category_override).toBe(1);
  });

  it('POST /api/agent/v1/query responde pergunta via IA sanitizada', async () => {
    const mockAIResponse = {
      content: JSON.stringify({
        answer: 'Você gastou um total de R$ 85,50 no período.',
        metricRefs: ['month-spend:2026-08'],
      }),
      model: 'ag/gemini-3.7-flash-high',
    };

    vi.spyOn(client, 'callAI').mockResolvedValueOnce(mockAIResponse);

    const res = await server.app.inject({
      method: 'POST',
      url: '/api/agent/v1/query',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        question: 'Quanto eu gastei este mês?',
        period: '2026-08',
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.schemaVersion).toBe('1.0');
    expect(json.data.answer).toContain('85,50');
    expect(json.data.metricRefs).toContain('month-spend:2026-08');
  });
});
