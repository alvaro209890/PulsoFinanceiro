import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { hashToken } from '../src/routes/agentAuth.js';

describe('API de Agentes Hermes F7 (docs/14 e docs/07 §API para agentes)', () => {
  let server: ReturnType<typeof buildServer>;
  const AGENT_TOKEN = 'secret-token-hermes-server-32bytes-12345';
  const AGENT_TOKEN_HASH = hashToken(AGENT_TOKEN);

  beforeAll(() => {
    process.env.PLUGGY_CLIENT_ID = 'test-id';
    process.env.PLUGGY_CLIENT_SECRET = 'test-secret';
    server = buildServer(':memory:');
    const db = server.db;

    // Cadastra o principal de teste com todos os escopos
    db.prepare(
      `INSERT INTO service_principals (id, name, current_token_hash, scopes_json, active)
       VALUES ('sp_hermes_server', 'hermes-server', ?, ?, 1)`
    ).run(AGENT_TOKEN_HASH, JSON.stringify(['metrics:read', 'events:read', 'events:claim', 'events:ack']));

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
       VALUES ('tx_1','ext_1','acc-bank',120.5,'BRL','2026-08-10','POSTED','DEBIT','08000000',0,'{}')`
    ).run();

    // Cria um evento na outbox para teste de claim/ack
    db.prepare(
      `INSERT INTO outbox_events (id, event_type, severity, payload_json, status, dedup_key, occurred_at, last_occurred_at)
       VALUES ('ev_1', 'SYNC_STALE', 'WARNING', '{"itemPublicId":"item-1"}', 'PENDING', 'dedup-test-ev1', '2026-08-24T10:00:00Z', '2026-08-24T10:00:00Z')`
    ).run();
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejeita chamadas sem Authorization Bearer com 401', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/agent/v1/summary?period=2026-08',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejeita token inválido com 401', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/agent/v1/summary?period=2026-08',
      headers: { Authorization: 'Bearer token-invalido' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/agent/v1/summary devolve métricas agregadas compactas', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/agent/v1/summary?period=2026-08',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.schemaVersion).toBe('1.0');
    expect(json.metricVersion).toBe('agent-summary.v1');
    expect(json.metrics.length).toBe(2);
    expect(json.metrics[0].name).toBe('monthSpend');
  });

  it('GET /api/agent/v1/projection devolve projeção do mês', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/agent/v1/projection?month=2026-08',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.metricVersion).toBe('month-forecast.v1');
    expect(json.components.length).toBeGreaterThan(0);
  });

  it('GET /api/agent/v1/events lista eventos pendentes', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/agent/v1/events',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.events.length).toBeGreaterThan(0);
    expect(json.events[0].id).toBe('ev_1');
  });

  it('POST /api/agent/v1/events/claim adquire lease e devolve leaseToken', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/agent/v1/events/claim',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { eventIds: ['ev_1'], leaseSeconds: 60 },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.claims.length).toBe(1);
    expect(json.claims[0].eventId).toBe('ev_1');
    expect(json.claims[0].leaseToken).toBeDefined();

    // Segundo claim imediato no mesmo evento falha com 409 conflito de lease
    const res2 = await server.app.inject({
      method: 'POST',
      url: '/api/agent/v1/events/claim',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { eventIds: ['ev_1'], leaseSeconds: 60 },
    });
    expect(res2.statusCode).toBe(409);

    // POST /api/agent/v1/events/:id/ack confirma entrega com sucesso
    const ackRes = await server.app.inject({
      method: 'POST',
      url: '/api/agent/v1/events/ev_1/ack',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        leaseToken: json.claims[0].leaseToken,
        deliveryId: 'delivery-123',
        outcome: 'DELIVERED',
      },
    });
    expect(ackRes.statusCode).toBe(200);
    expect(ackRes.json().data.status).toBe('DELIVERED');
  });
});
