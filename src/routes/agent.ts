/**
 * Endpoints da API de Agentes (`/api/agent/v1/*`) — docs/14 e docs/07 §API para agentes.
 *
 * Contratos:
 * - GET /summary?period=YYYY-MM: Fechamento compacto para consumo do Hermes
 * - GET /projection?month=YYYY-MM: Projeção de ritmo e componentes
 * - GET /anomalies?since=&limit=: Anomalias e duplicidades recentes
 * - GET /events?cursor=&limit=: Snapshot read-only da outbox
 * - POST /events/claim: Adquire lease atômico (all-or-none) de eventos
 * - POST /events/:id/ack: Registra entrega operacional idempotente
 */
import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { authenticateAgent, AgentAuthError } from './agentAuth.js';
import { computeOverview } from '../finance/overview.js';
import { computePace } from '../finance/pace.js';
import { logZscoreAnomalies, findDuplicates } from '../finance/anomalies.js';
import { monthRange, monthOf, isMonth, today as todayCivil, DEFAULT_TIMEZONE } from '../finance/time.js';
import { dataThroughInstant } from '../finance/envelope.js';

export function registerAgentRoutes(app: FastifyInstance, db: Db): void {
  // GET /api/agent/v1/summary?period=YYYY-MM
  app.get<{ Querystring: { period?: string; timezone?: string } }>(
    '/api/agent/v1/summary',
    async (req, reply) => {
      try {
        await authenticateAgent(db, 'metrics:read')(req, reply);
        const tz = req.query.timezone ?? DEFAULT_TIMEZONE;
        const period = req.query.period ?? monthOf(todayCivil(tz));
        if (!isMonth(period)) {
          return reply.code(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Parâmetro period inválido. Use YYYY-MM.' },
          });
        }

        const range = monthRange(period);
        const overview = computeOverview(db, { from: range.from, to: range.to, timezone: tz });
        const pace = computePace(db, { month: period, timezone: tz });

        const metrics = [
          {
            metricId: overview.data.monthSpend.metricIds['posted'] ?? `month-spend:${period}`,
            name: 'monthSpend',
            value: overview.data.monthSpend.posted,
            currencyCode: overview.currencyCode,
          },
          {
            metricId: pace.data.forecast.metricIds?.amount ?? `month-forecast:${period}`,
            name: 'forecast',
            value: pace.data.forecast.amount,
            currencyCode: pace.currencyCode,
          },
        ];

        return {
          schemaVersion: '1.0',
          computedAt: new Date().toISOString(),
          dataThrough: dataThroughInstant(db),
          period: { from: range.from, to: range.to, timezone: tz },
          currencyCode: overview.currencyCode,
          counts: { metrics: metrics.length },
          metricVersion: 'agent-summary.v1',
          quality: 'complete',
          metrics,
          freshnessStatus: 'FRESH',
        };
      } catch (err) {
        if (err instanceof AgentAuthError) return;
        req.log.error(err, 'Erro em /api/agent/v1/summary');
        return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
      }
    }
  );

  // GET /api/agent/v1/projection?month=YYYY-MM
  app.get<{ Querystring: { month?: string; timezone?: string } }>(
    '/api/agent/v1/projection',
    async (req, reply) => {
      try {
        await authenticateAgent(db, 'metrics:read')(req, reply);
        const tz = req.query.timezone ?? DEFAULT_TIMEZONE;
        const month = req.query.month ?? monthOf(todayCivil(tz));
        if (!isMonth(month)) {
          return reply.code(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Parâmetro month inválido. Use YYYY-MM.' },
          });
        }

        const range = monthRange(month);
        const pace = computePace(db, { month, timezone: tz });

        const components = [
          {
            kind: 'CONFIRMED',
            amount: pace.data.forecast.components.confirmed,
            metricId: `month-forecast-confirmed:${month}`,
          },
          {
            kind: 'PENDING',
            amount: pace.data.forecast.components.eligiblePending,
            metricId: `month-forecast-pending:${month}`,
          },
          {
            kind: 'NON_RECURRING_PACE_FUTURE',
            amount: pace.data.forecast.components.nonRecurringPaceFuture,
            metricId: `month-forecast-pace-future:${month}`,
          },
          {
            kind: 'EXPECTED_RECURRENCES',
            amount: pace.data.forecast.components.expectedRecurrencesNotYetCharged,
            metricId: `month-forecast-recurrences:${month}`,
          },
        ];

        return {
          schemaVersion: '1.0',
          computedAt: new Date().toISOString(),
          dataThrough: dataThroughInstant(db),
          period: { from: range.from, to: range.to, timezone: tz },
          currencyCode: pace.currencyCode,
          counts: { components: components.length },
          metricVersion: 'month-forecast.v1',
          quality: 'complete',
          projection: {
            amount: pace.data.forecast.amount,
            rangeLow: pace.data.forecast.rangeLow,
            rangeHigh: pace.data.forecast.rangeHigh,
            currencyCode: pace.currencyCode,
            metricIds: pace.data.forecast.metricIds,
          },
          components,
          metricRefs: components.map((c) => c.metricId),
          freshnessStatus: 'FRESH',
        };
      } catch (err) {
        if (err instanceof AgentAuthError) return;
        req.log.error(err, 'Erro em /api/agent/v1/projection');
        return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
      }
    }
  );

  // GET /api/agent/v1/anomalies?since=&limit=
  app.get<{ Querystring: { since?: string; limit?: string; timezone?: string } }>(
    '/api/agent/v1/anomalies',
    async (req, reply) => {
      try {
        await authenticateAgent(db, 'metrics:read')(req, reply);
        const tz = req.query.timezone ?? DEFAULT_TIMEZONE;
        const currentMonth = monthOf(todayCivil(tz));
        const range = monthRange(currentMonth);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

        const anomalies = logZscoreAnomalies(db, { from: range.from, to: range.to });
        const duplicates = findDuplicates(db, { from: range.from, to: range.to });

        const items: Array<{
          id: string;
          kind: string;
          severity: string;
          summary: string;
          occurredAt: string;
          metricRefs: string[];
        }> = [];

        for (const a of anomalies.anomalies.slice(0, limit)) {
          items.push({
            id: a.transactionId,
            kind: 'LOG_ZSCORE',
            severity: 'WARNING',
            summary: `Gasto atípico de R$ ${a.amount.toFixed(2)} em ${a.categoryLabel ?? 'categoria'}.`,
            occurredAt: new Date().toISOString(),
            metricRefs: [`anomaly:${a.transactionId}`],
          });
        }

        for (const d of duplicates.duplicates.slice(0, limit - items.length)) {
          items.push({
            id: d.ids.join(':'),
            kind: 'DUPLICATE',
            severity: 'HIGH',
            summary: `Possível duplicidade de R$ ${d.amount.toFixed(2)} em intervalo de ${d.minutesApart} min.`,
            occurredAt: new Date().toISOString(),
            metricRefs: [`duplicate:${d.ids.join(':')}`],
          });
        }

        return {
          schemaVersion: '1.0',
          computedAt: new Date().toISOString(),
          dataThrough: dataThroughInstant(db),
          period: { from: range.from, to: range.to, timezone: tz },
          currencyCode: 'BRL',
          counts: { anomalies: items.length },
          metricVersion: 'agent-anomalies.v1',
          quality: 'complete',
          anomalies: items,
          freshnessStatus: 'FRESH',
        };
      } catch (err) {
        if (err instanceof AgentAuthError) return;
        req.log.error(err, 'Erro em /api/agent/v1/anomalies');
        return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
      }
    }
  );

  // GET /api/agent/v1/events?cursor=&limit=
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/api/agent/v1/events',
    async (req, reply) => {
      try {
        await authenticateAgent(db, 'events:read')(req, reply);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

        const rows = db
          .prepare(
            `SELECT id, event_type, severity, payload_json, status, occurred_at
               FROM outbox_events
              WHERE status IN ('PENDING', 'LEASED')
              ORDER BY occurred_at ASC, id ASC
              LIMIT ?`
          )
          .all(limit) as Array<{
          id: string;
          event_type: string;
          severity: string;
          payload_json: string;
          status: string;
          occurred_at: string;
        }>;

        const events = rows.map((r) => {
          let payload = {};
          try {
            payload = JSON.parse(r.payload_json);
          } catch {
            payload = {};
          }
          return {
            id: r.id,
            eventType: r.event_type,
            severity: r.severity,
            occurredAt: r.occurred_at,
            deliveryState: r.status,
            payload,
          };
        });

        return {
          schemaVersion: '1.0',
          events,
          nextCursor: events.length >= limit ? events[events.length - 1]?.id : null,
        };
      } catch (err) {
        if (err instanceof AgentAuthError) return;
        req.log.error(err, 'Erro em /api/agent/v1/events');
        return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
      }
    }
  );

  // POST /api/agent/v1/events/claim
  app.post<{ Body: { eventIds?: string[]; leaseSeconds?: number } }>(
    '/api/agent/v1/events/claim',
    async (req, reply) => {
      try {
        const principal = await authenticateAgent(db, 'events:claim')(req, reply);
        const body = req.body;
        const eventIds = Array.isArray(body?.eventIds) ? body.eventIds : [];
        if (eventIds.length === 0 || eventIds.length > 20) {
          return reply.code(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'eventIds deve conter de 1 a 20 IDs.' },
          });
        }

        const leaseSeconds = Math.min(300, Math.max(30, Number(body?.leaseSeconds) || 120));
        const now = Date.now();
        const leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();

        const claims: Array<{
          eventId: string;
          leaseToken: string;
          leaseUntil: string;
          event: unknown;
        }> = [];

        const tx = db.transaction(() => {
          for (const eventId of eventIds) {
            const ev = db
              .prepare(
                `SELECT id, event_type, severity, payload_json, status, occurred_at, lease_until
                   FROM outbox_events
                  WHERE id = ?`
              )
              .get(eventId) as
              | {
                  id: string;
                  event_type: string;
                  severity: string;
                  payload_json: string;
                  status: string;
                  occurred_at: string;
                  lease_until: string | null;
                }
              | undefined;

            if (!ev) {
              throw new Error(`RESOURCE_NOT_FOUND:${eventId}`);
            }

            // Valida se está livre para claim
            const isLeaseActive = ev.status === 'LEASED' && ev.lease_until && Date.parse(ev.lease_until) > now;
            if (ev.status !== 'PENDING' && isLeaseActive) {
              throw new Error(`EVENT_LEASE_CONFLICT:${eventId}`);
            }

            const rawToken = randomBytes(24).toString('hex');
            const tokenHash = createHash('sha256').update(rawToken).digest('hex');

            db.prepare(
              `UPDATE outbox_events
                  SET status = 'LEASED',
                      lease_owner = ?,
                      lease_until = ?,
                      lease_token_hash = ?,
                      attempts = attempts + 1
                WHERE id = ?`
            ).run(principal.id, leaseUntil, tokenHash, eventId);

            let payload = {};
            try {
              payload = JSON.parse(ev.payload_json);
            } catch {
              payload = {};
            }

            claims.push({
              eventId,
              leaseToken: rawToken,
              leaseUntil,
              event: {
                eventType: ev.event_type,
                severity: ev.severity,
                occurredAt: ev.occurred_at,
                payload,
              },
            });
          }
        });

        try {
          tx();
        } catch (txErr: any) {
          const msg = String(txErr?.message ?? '');
          if (msg.startsWith('RESOURCE_NOT_FOUND:')) {
            return reply.code(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: msg } });
          }
          if (msg.startsWith('EVENT_LEASE_CONFLICT:')) {
            return reply.code(409).send({ error: { code: 'EVENT_LEASE_CONFLICT', message: msg } });
          }
          throw txErr;
        }

        return {
          schemaVersion: '1.0',
          claims,
        };
      } catch (err) {
        if (err instanceof AgentAuthError) return;
        req.log.error(err, 'Erro em /api/agent/v1/events/claim');
        return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
      }
    }
  );

  // POST /api/agent/v1/events/:id/ack
  app.post<{
    Params: { id: string };
    Body: { leaseToken?: string; deliveryId?: string; outcome?: string; reasonCode?: string | null };
  }>('/api/agent/v1/events/:id/ack', async (req, reply) => {
    try {
      const principal = await authenticateAgent(db, 'events:ack')(req, reply);
      const eventId = req.params.id;
      const { leaseToken, deliveryId, outcome, reasonCode } = req.body ?? {};

      if (!leaseToken || !deliveryId || !outcome) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'leaseToken, deliveryId e outcome obrigatórios.' },
        });
      }

      if (!['DELIVERED', 'DISMISSED'].includes(outcome)) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: "outcome aceita apenas 'DELIVERED' ou 'DISMISSED'." },
        });
      }

      const ev = db
        .prepare(`SELECT id, status, lease_owner, lease_until, lease_token_hash FROM outbox_events WHERE id = ?`)
        .get(eventId) as
        | {
            id: string;
            status: string;
            lease_owner: string | null;
            lease_until: string | null;
            lease_token_hash: string | null;
          }
        | undefined;

      if (!ev) {
        return reply.code(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Evento inexistente.' } });
      }

      // Replay idempotente de entrega
      if (['DELIVERED', 'DISMISSED'].includes(ev.status)) {
        return {
          schemaVersion: '1.0',
          data: { eventId, status: ev.status, duplicateAck: true },
        };
      }

      const tokenHash = createHash('sha256').update(leaseToken).digest('hex');
      if (ev.lease_token_hash !== tokenHash || ev.lease_owner !== principal.id) {
        return reply.code(409).send({
          error: { code: 'EVENT_LEASE_CONFLICT', message: 'Lease token inválido ou pertencente a outro principal.' },
        });
      }

      db.prepare(
        `UPDATE outbox_events
            SET status = ?,
                lease_token_hash = NULL,
                lease_until = NULL,
                condition_closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).run(outcome, eventId);

      return {
        schemaVersion: '1.0',
        data: { eventId, status: outcome, duplicateAck: false },
      };
    } catch (err) {
      if (err instanceof AgentAuthError) return;
      req.log.error(err, 'Erro em /api/agent/v1/events/:id/ack');
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
    }
  });
}
