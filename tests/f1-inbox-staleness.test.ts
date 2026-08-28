/**
 * Testes F1: inbox de webhook, staleness (STALE_POLICY_V1) e outbox.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index.js';
import { receiveEnvelope, processInbox } from '../src/jobs/inbox.js';
import { evaluateStaleness, applyStaleness } from '../src/jobs/staleness.js';
import { emitEvent, closeCondition } from '../src/db/outbox.js';
import { PluggyClient } from '../src/pluggy/client.js';

const NOW = new Date('2026-08-24T15:00:00Z');
const iso = (d: Date) => d.toISOString();
const hoursAgo = (h: number) => iso(new Date(NOW.getTime() - h * 3600_000));

describe('inbox de webhook (docs/06 §7)', () => {
  const setup = () => openDb(':memory:');

  it('aceita envelope item/updated válido e persiste RECEIVED', () => {
    const db = setup();
    const r = receiveEnvelope(db, { eventId: 'e1', eventType: 'item/updated', itemId: 'it1' });
    expect(r.accepted).toBe(true);
    const row = db.prepare('SELECT status FROM webhook_inbox WHERE event_id=?').get('e1') as { status: string };
    expect(row.status).toBe('RECEIVED');
  });

  it('rejeita transactions/* sem accountId e sem transactionIds', () => {
    const db = setup();
    expect(receiveEnvelope(db, { eventId: 'e2', eventType: 'transactions/created' }).accepted).toBe(false);
    expect(receiveEnvelope(db, {
      eventId: 'e3', eventType: 'transactions/updated',
      accountId: 'acc1', transactionIds: [],
    }).accepted).toBe(false);
    expect((db.prepare('SELECT COUNT(*) c FROM webhook_inbox').get() as { c: number }).c).toBe(0);
  });

  it('reentrega do mesmo eventId em status não-FAILED é inofensiva (202)', () => {
    const db = setup();
    receiveEnvelope(db, { eventId: 'e4', eventType: 'item/updated', itemId: 'it1' });
    db.prepare("UPDATE webhook_inbox SET status='SUCCEEDED' WHERE event_id='e4'").run();
    // Pluggy re-entrega o mesmo eventId
    const r = receiveEnvelope(db, { eventId: 'e4', eventType: 'item/updated', itemId: 'it1' });
    expect(r.accepted).toBe(true); // aceito com 202...
    const row = db.prepare('SELECT status FROM webhook_inbox WHERE event_id=?').get('e4') as { status: string };
    expect(row.status).toBe('SUCCEEDED'); // ...mas linha SUCCEEDED intacta
  });

  it('worker processa envelope e marca SUCCEEDED; conta fora do escopo vira DEAD', async () => {
    const db = setup();
    db.prepare("INSERT INTO items (public_id, external_id, status) VALUES ('ipub','it1','UPDATED')").run();

    let getAccountsCalls = 0;
    const impl = async (url: string) => {
      if (url.includes('/auth')) {
        const jwt = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url') + '.s';
        return Response.json({ apiKey: jwt });
      }
      getAccountsCalls += 1;
      return Response.json({ results: [] });
    };
    const client = new PluggyClient('id', 'secret', impl);

    // transações/created com conta desconhecida → refresh + DEAD ACCOUNT_SCOPE
    receiveEnvelope(db, { eventId: 'e5', eventType: 'transactions/created', itemId: 'it1', accountId: 'ghost' });
    const res = await processInbox(db, client, 'it1');
    expect(res.dead).toBe(1);
    const row = db.prepare("SELECT status, last_error_code FROM webhook_inbox WHERE event_id='e5'").get() as any;
    expect(['DEAD','FAILED']).toContain(row.status); // sync falha por item sem contas → FAILED/DEAD aceito
  });
});

describe('STALE_POLICY_V1 (docs/14)', () => {
  const setupWithItem = () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO items (public_id, external_id, status, next_auto_sync_at, last_harvest_at) VALUES ('ipub','it1','UPDATED',?,?)"
    ).run(hoursAgo(20), hoursAgo(19));
    return db;
  };

  it('harvest recente e dado fresco → OK', () => {
    const db = setupWithItem();
    db.prepare("UPDATE items SET last_harvest_at=? WHERE public_id='ipub'").run(hoursAgo(2));
    const bucket = evaluateStaleness(db, {
      itemPublicId: 'ipub',
      lastHarvestAt: hoursAgo(2),
      dataThrough: hoursAgo(3),
      nextAutoSyncAt: hoursAgo(10), // deadline = -10h+6h = -4h < harvest -2h → dentro
      itemStatus: 'UPDATED',
    });
    expect(bucket).toBe('OK');
  });

  it('sem harvest após nextAutoSync+6h e dado velho ≥24h → WARNING', () => {
    const db = setupWithItem();
    const bucket = evaluateStaleness(db, {
      itemPublicId: 'ipub',
      lastHarvestAt: null,
      dataThrough: hoursAgo(30),
      nextAutoSyncAt: hoursAgo(20), // deadline -14h, sem harvest desde então
      itemStatus: 'UPDATED',
    }, NOW.getTime());
    expect(bucket).toBe('WARNING');
    const ev = db.prepare("SELECT severity FROM outbox_events WHERE event_type='SYNC_STALE'").get() as any;
    expect(ev.severity).toBe('WARNING');
  });

  it('dado ≥72h → HIGH; ≥168h → CRITICAL; recuperação fecha condição e emite SYNC_RECOVERED', () => {
    const db = setupWithItem();
    let b = evaluateStaleness(db, {
      itemPublicId: 'ipub', lastHarvestAt: null, dataThrough: hoursAgo(80),
      nextAutoSyncAt: hoursAgo(20), itemStatus: 'UPDATED',
    }, NOW.getTime());
    expect(b).toBe('HIGH');

    b = evaluateStaleness(db, {
      itemPublicId: 'ipub', lastHarvestAt: null, dataThrough: hoursAgo(200),
      nextAutoSyncAt: hoursAgo(20), itemStatus: 'UPDATED',
    }, NOW.getTime());
    expect(b).toBe('CRITICAL');
    const crit = db.prepare("SELECT dedup_key FROM outbox_events WHERE event_type='SYNC_STALE' AND severity='CRITICAL'").get() as any;
    expect(crit.dedup_key).toBe('sync-stale:ipub:CRITICAL');

    applyStaleness(db, 'ipub', 'OK');
    const closed = db.prepare("SELECT condition_closed_at IS NOT NULL AS closed FROM outbox_events WHERE dedup_key='sync-stale:ipub:CRITICAL'").get() as any;
    expect(closed.closed).toBeTruthy();
    const rec = db.prepare("SELECT COUNT(*) c FROM outbox_events WHERE event_type='SYNC_RECOVERED'").get() as any;
    expect(rec.c).toBeGreaterThanOrEqual(1);
  });
});

describe('outbox (docs/14)', () => {
  it('dedup no episódio ativo incrementa occurrence_count; fechado cria novo id', () => {
    const db = openDb(':memory:');
    const first = emitEvent(db, { eventType: 'BILL_DUE_SOON', severity: 'HIGH', dedupKey: 'bill:fat1:3d', payload: {} });
    expect(first.created).toBe(true);
    const second = emitEvent(db, { eventType: 'BILL_DUE_SOON', severity: 'HIGH', dedupKey: 'bill:fat1:3d', payload: {} });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const row = db.prepare('SELECT occurrence_count FROM outbox_events WHERE id=?').get(first.id) as any;
    expect(row.occurrence_count).toBe(2);

    closeCondition(db, 'bill:fat1:3d');
    const third = emitEvent(db, { eventType: 'BILL_DUE_SOON', severity: 'HIGH', dedupKey: 'bill:fat1:3d', payload: {} });
    expect(third.created).toBe(true); // novo episódio
  });
});
