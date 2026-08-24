/**
 * Testes do cliente Pluggy contra contrato medido (docs/04).
 * Nenhum teste toca a API real — fetch é mockado.
 */
import { describe, it, expect, vi } from 'vitest';
import { PluggyClient, readJwtExpMs, PluggyError } from '../src/pluggy/client.js';

function jwtWithExp(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSec })}.sig`;
}

function makeFetch(responses: Array<{ status: number; body?: unknown }>) {
  let call = 0;
  const calls: string[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { impl, calls };
}

const NOW = 1_700_000_000_000;

describe('autenticação', () => {
  it('faz /auth e usa a apiKey em seguida', async () => {
    const key = jwtWithExp(NOW / 1000 + 7200);
    const f = makeFetch([
      { status: 200, body: { apiKey: key } },
      { status: 200, body: { results: [] } },
    ]);
    const c = new PluggyClient('id', 'secret', f.impl, () => NOW);
    await c.getAccounts('item1');
    expect(f.calls[0]).toContain('/auth');
    expect(f.calls[1]).toContain('/accounts?itemId=item1');
  });

  it('renova uma vez diante de 401 e repete a chamada original', async () => {
    const oldKey = jwtWithExp(NOW / 1000 + 7200);
    const newKey = jwtWithExp(NOW / 1000 + 99999);
    let authCalls = 0;
    let dataCalls = 0;
    const impl = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth')) {
        authCalls += 1;
        return Response.json({ apiKey: authCalls === 1 ? oldKey : newKey });
      }
      dataCalls += 1;
      // primeira chamada de dados usa a chave velha → 401; depois OK
      return dataCalls === 1 ? new Response('{}', { status: 401 }) : Response.json({ results: [] });
    };
    const c = new PluggyClient('id', 'secret', impl, () => NOW);
    const accs = await c.getAccounts('i');
    expect(accs).toEqual([]);
    expect(authCalls).toBe(2);
  });

  it('segundo 401 encerra sem loop', async () => {
    const key = jwtWithExp(NOW / 1000 + 7200);
    const impl = async (url: string) => {
      if (url.endsWith('/auth')) return Response.json({ apiKey: key });
      return new Response('{}', { status: 401 });
    };
    const c = new PluggyClient('id', 'secret', impl, () => NOW);
    await expect(c.getItem('i')).rejects.toMatchObject({ errorCode: 'CREDENTIAL_INVALID' });
  });
});

describe('paginação por cursor (docs/04 §6)', () => {
  it('rejeita next que não começa com "?"', async () => {
    const c = new PluggyClient('id', 'secret', async () => new Response('{}'), () => NOW);
    await expect(c.nextTransactionPage('https://evil.example/v2/transactions?a=1'))
      .rejects.toBeInstanceOf(PluggyError);
  });

  it('segue response.next exatamente como veio', async () => {
    const key = jwtWithExp(NOW / 1000 + 7200);
    const nextQuery = '?accountId=abc&after=CUR';
    const seenUrls: string[] = [];
    let page = 0;
    const impl = async (url: string) => {
      if (url.endsWith('/auth')) return Response.json({ apiKey: key });
      seenUrls.push(url);
      page += 1;
      return page === 1
        ? Response.json({ results: [{ id: 't1', amount: 10, date: '2026-08-01T00:00:00Z', status: 'POSTED' }], next: nextQuery })
        : Response.json({ results: [], next: null });
    };
    const c = new PluggyClient('id', 'secret', impl, () => NOW);
    const p1 = await c.firstTransactionPage('abc');
    expect(p1.next).toBe(nextQuery);
    await c.nextTransactionPage(p1.next!);
    expect(seenUrls[1]).toBe(`https://api.pluggy.ai/v2/transactions${nextQuery}`);
  });

  it('next null encerra paginação', async () => {
    const key = jwtWithExp(NOW / 1000 + 7200);
    const impl = async (url: string) =>
      url.endsWith('/auth') ? Response.json({ apiKey: key }) : Response.json({ results: [], next: null });
    const c = new PluggyClient('id', 'secret', impl, () => NOW);
    const p = await c.firstTransactionPage('a');
    expect(p.next).toBeNull();
  });
});

describe('readJwtExpMs', () => {
  it('lê exp do payload', () => {
    const expSec = NOW / 1000 + 3600;
    expect(readJwtExpMs(jwtWithExp(expSec), NOW)).toBe(expSec * 1000);
  });
  it('token malformado vence imediatamente', () => {
    expect(readJwtExpMs('garbage', NOW)).toBe(NOW);
  });
});
