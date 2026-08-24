/**
 * E2E real da base: sobe o servidor em :3041 e bate nos endpoints.
 * Uso: npx tsx tests/e2e-manual.ts   (fora do vitest porque sobe listener real)
 */
process.env.PLUGGY_CLIENT_ID = 'e2e';
process.env.PLUGGY_CLIENT_SECRET = 'e2e';
process.env.DB_PATH = '/tmp/pulso-e2e.sqlite';

const { buildServer } = await import('../src/index.js');
const { app } = buildServer('/tmp/pulso-e2e.sqlite');
await app.listen({ port: 3041, host: '127.0.0.1' });

const base = 'http://127.0.0.1:3041';
const hit = async (path: string, opts?: RequestInit) => {
  const r = await fetch(base + path, opts);
  const ct = r.headers.get('content-type') ?? '';
  const body = ct.includes('json') ? await r.json() : (await r.text()).slice(0, 40);
  return { status: r.status, body };
};

console.log('health          :', JSON.stringify((await hit('/api/health')).body));
console.log('summary         :', JSON.stringify((await hit('/api/summary?period=2026-08')).body).slice(0, 120));
console.log('sync sem item   :', JSON.stringify((await hit('/api/sync/run', { method: 'POST' })).body));
const wh = await hit('/api/webhooks/pluggy', {
  method: 'POST',
  headers: { authorization: 'Bearer x' },
  body: JSON.stringify({ event: 'x' }),
});
console.log('webhook s/ auth :', wh.status);
const shell = await fetch(base + '/');
const html = await shell.text();
console.log('shell /         :', shell.status, '| contém Pulso:', html.includes('Pulso'));

await app.close();
process.exit(0);
export {};
