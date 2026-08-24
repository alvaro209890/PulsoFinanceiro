/**
 * E2E F1: webhook → inbox → worker, staleness no health.
 */
process.env.PLUGGY_CLIENT_ID = 'e2e';
process.env.PLUGGY_CLIENT_SECRET = 'e2e';
process.env.PLUGGY_ITEM_ID = 'item-teste';
process.env.PLUGGY_WEBHOOK_BEARER_TOKEN = 'tok-e2e';

const { buildServer } = await import('../src/index.js');
const { app } = buildServer('/tmp/pulso-f1.sqlite');
await app.listen({ port: 3042, host: '127.0.0.1' });

const base = 'http://127.0.0.1:3042';
const hit = async (path: string, opts?: RequestInit) => {
  const r = await fetch(base + path, opts);
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : (await r.text()).slice(0, 40) };
};

// 1. Webhook com Bearer correto — envelope válido item/updated
const wh1 = await hit('/api/webhooks/pluggy', {
  method: 'POST',
  headers: { authorization: 'Bearer tok-e2e', 'content-type': 'application/json' },
  body: JSON.stringify({ eventId: 'evt-001', event: 'item/updated', itemId: 'item-teste', triggeredBy: 'SYNC' }),
});
console.log('webhook válido      :', wh1.status, JSON.stringify(wh1.body));

// 2. Mesmo eventId de novo (reentrega Pluggy) — ainda 202
const wh2 = await hit('/api/webhooks/pluggy', {
  method: 'POST',
  headers: { authorization: 'Bearer tok-e2e' },
  body: JSON.stringify({ eventId: 'evt-001', event: 'item/updated', itemId: 'item-teste' }),
});
console.log('reentrega eventId   :', wh2.status);

// 3. Envelope inválido (transactions sem accountId) → 422
const wh3 = await hit('/api/webhooks/pluggy', {
  method: 'POST',
  headers: { authorization: 'Bearer tok-e2e' },
  body: JSON.stringify({ eventId: 'evt-002', event: 'transactions/created', itemId: 'item-teste' }),
});
console.log('sem accountId (422) :', wh3.status, JSON.stringify(wh3.body));

// 4. Health expõe staleness
const h = await hit('/api/health');
console.log('health.sync         :', JSON.stringify(h.body.sync), '| lastRun:', (h.body as any).lastSyncRun?.id ?? null);

await app.close();
process.exit(0);
export {};
