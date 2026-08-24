/**
 * Testes E2E do servidor com fastify.inject — sem rede e sem segredo real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';

let server: ReturnType<typeof buildServer>;

beforeAll(() => {
  process.env.PLUGGY_CLIENT_ID = 'test-id';
  process.env.PLUGGY_CLIENT_SECRET = 'test-secret';
  process.env.DB_PATH = ':memory:';
  delete process.env.PLUGGY_ITEM_ID;
  server = buildServer(':memory:');
});

afterAll(async () => {
  await server.app.close();
  server.db.close();
});

describe('API base', () => {
  it('GET /api/health responde ok', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
  });

  it('GET /api/summary valida período', async () => {
    const bad = await server.app.inject({ method: 'GET', url: '/api/summary?period=agosto' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('PERIOD_INVALID');

    const good = await server.app.inject({ method: 'GET', url: '/api/summary?period=2026-08' });
    expect(good.statusCode).toBe(200);
    const body = good.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.period).toBe('2026-08');
    expect(Array.isArray(body.byCategory)).toBe(true);
  });

  it('POST /api/sync/run sem item configurado → 409', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/api/sync/run' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NO_ITEM_CONFIGURED');
  });

  it('webhook sem Bearer configurado → 401', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/webhooks/pluggy',
      headers: { authorization: 'Bearer qualquer' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('rota desconhecida em /api → 404 JSON; raiz cai no shell web', async () => {
    const apiMiss = await server.app.inject({ method: 'GET', url: '/api/nada' });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json().error).toBe('NOT_FOUND');

    const shell = await server.app.inject({ method: 'GET', url: '/' });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('Pulso');
  });
});
