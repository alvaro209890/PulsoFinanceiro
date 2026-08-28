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
import { computeCategories } from '../finance/categories.js';
import { listRecurrences } from '../finance/recurrences.js';
import { logZscoreAnomalies, findDuplicates } from '../finance/anomalies.js';
import { monthRange, monthOf, isMonth, today as todayCivil, DEFAULT_TIMEZONE } from '../finance/time.js';
import { dataThroughInstant } from '../finance/envelope.js';
import { callAI } from '../ai/client.js';
import { sanitizeObjectForAI, sanitizeTextForAI } from '../ai/sanitize.js';

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

  // GET /api/agent/v1/clarifications/:id — docs/07 §H5/F8
  app.get<{ Params: { id: string } }>(
    '/api/agent/v1/clarifications/:id',
    async (req, reply) => {
      try {
        await authenticateAgent(db, 'clarifications:read_private')(req, reply);
        const id = req.params.id;

        const row = db
          .prepare(
            `SELECT c.id, c.version, c.transaction_public_id, c.status, c.context_json, c.suggestions_json,
                    c.matcher_kind, c.matcher_confidence,
                    t.amount, t.currency, t.date, t.type
               FROM transaction_clarifications c
               JOIN transactions t ON t.public_id = c.transaction_public_id
              WHERE c.id = ?`
          )
          .get(id) as
          | {
              id: string;
              version: string;
              transaction_public_id: string;
              status: string;
              context_json: string;
              suggestions_json: string;
              matcher_kind: string | null;
              matcher_confidence: string | null;
              amount: number;
              currency: string;
              date: string;
              type: string | null;
            }
          | undefined;

        if (!row) {
          return reply.code(404).send({
            error: { code: 'RESOURCE_NOT_FOUND', message: 'Clarificação não encontrada.' },
          });
        }

        if (row.status !== 'OPEN') {
          return reply.code(409).send({
            error: { code: 'STALE_CLARIFICATION_TARGET', message: 'Clarificação não está mais aberta.' },
          });
        }

        let suggestions = [];
        try {
          suggestions = JSON.parse(row.suggestions_json);
        } catch {
          suggestions = [];
        }

        reply.header('Cache-Control', 'private, no-store');
        return {
          schemaVersion: '1.0',
          data: {
            id: row.id,
            version: row.version,
            transactionId: row.transaction_public_id,
            context: {
              direction: row.type ?? 'DEBIT',
              occurredDate: row.date.slice(0, 10),
              amount: row.amount,
              currencyCode: row.currency,
            },
            categorySuggestions: suggestions,
            applyToSimilar: {
              available: Boolean(row.matcher_kind),
              matcherKind: row.matcher_kind ?? 'SOURCE_FINGERPRINT_V1',
              confidence: row.matcher_confidence ?? 'HIGH',
            },
          },
        };
      } catch (err) {
        if (err instanceof AgentAuthError) return;
        req.log.error(err, 'Erro em /api/agent/v1/clarifications/:id');
        return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
      }
    }
  );

  // POST /api/agent/v1/clarifications/:id/resolve — docs/07 §H5/F8
  app.post<{
    Params: { id: string };
    Headers: { 'if-match'?: string; 'idempotency-key'?: string };
    Body: {
      resolutionType?: string;
      suggestionRef?: string | null;
      normalizedAlias?: string | null;
      applyToSimilar?: boolean;
    };
  }>('/api/agent/v1/clarifications/:id/resolve', async (req, reply) => {
    try {
      await authenticateAgent(db, 'clarifications:write')(req, reply);
      const id = req.params.id;
      const ifMatch = req.headers['if-match'];
      const idempotencyKey = req.headers['idempotency-key'];

      if (!ifMatch) {
        return reply.code(428).send({
          error: { code: 'PRECONDITION_REQUIRED', message: 'Header If-Match obrigatório.' },
        });
      }

      if (!idempotencyKey) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Header Idempotency-Key obrigatório.' },
        });
      }

      const body = req.body ?? {};
      const { resolutionType, suggestionRef, normalizedAlias, applyToSimilar } = body;

      if (!['ACCEPT_CATEGORY_SUGGESTION', 'SET_NORMALIZED_ALIAS'].includes(resolutionType ?? '')) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: "resolutionType deve ser 'ACCEPT_CATEGORY_SUGGESTION' ou 'SET_NORMALIZED_ALIAS'.",
          },
        });
      }

      const row = db
        .prepare(
          `SELECT c.id, c.version, c.transaction_public_id, c.status, c.suggestions_json, c.matcher_kind,
                  c.idempotency_hash
             FROM transaction_clarifications c
            WHERE c.id = ?`
        )
        .get(id) as
        | {
            id: string;
            version: string;
            transaction_public_id: string;
            status: string;
            suggestions_json: string;
            matcher_kind: string | null;
            idempotency_hash: string | null;
          }
        | undefined;

      if (!row) {
        return reply.code(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Clarificação não encontrada.' },
        });
      }

      const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');

      // Idempotência
      if (row.status === 'RESOLVED') {
        if (row.idempotency_hash === keyHash) {
          return {
            schemaVersion: '1.0',
            data: {
              clarificationId: row.id,
              transactionId: row.transaction_public_id,
              status: 'RESOLVED',
              duplicateResolution: true,
            },
          };
        }
        return reply.code(409).send({
          error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Clarificação já resolvida com outra chave.' },
        });
      }

      if (row.version !== ifMatch) {
        return reply.code(409).send({
          error: { code: 'STALE_CLARIFICATION_TARGET', message: 'If-Match não confere com a versão atual.' },
        });
      }

      let targetCategoryId: string | null = null;
      let targetLabel: string = 'Outros';

      if (resolutionType === 'ACCEPT_CATEGORY_SUGGESTION') {
        let suggestions: Array<{ suggestionRef: string; categoryId: string; label: string }> = [];
        try {
          suggestions = JSON.parse(row.suggestions_json);
        } catch {
          suggestions = [];
        }
        const matchSug = suggestions.find((s) => s.suggestionRef === suggestionRef);
        if (!matchSug) {
          return reply.code(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'suggestionRef não encontrada nas sugestões da clarificação.' },
          });
        }
        targetCategoryId = matchSug.categoryId;
        targetLabel = matchSug.label;
      }

      const newVersion = `v_${Date.now()}`;

      db.transaction(() => {
        // Atualiza a transação com category override
        if (targetCategoryId) {
          db.prepare(
            `UPDATE transactions
                SET category_id = ?,
                    category_override = 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE public_id = ?`
          ).run(targetCategoryId, row.transaction_public_id);
        }

        // Se applyToSimilar for true e houver matcher
        let ruleCreated = false;
        if (applyToSimilar && row.matcher_kind) {
          const ruleId = `rule_${Date.now()}`;
          db.prepare(
            `INSERT INTO transaction_context_rules (id, matcher_kind, matcher_value, category_id, normalized_alias, source_clarification_id)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            ruleId,
            row.matcher_kind,
            row.transaction_public_id,
            targetCategoryId,
            normalizedAlias ?? null,
            row.id
          );
          ruleCreated = true;
        }

        // Marca a clarificação como resolvida
        db.prepare(
          `UPDATE transaction_clarifications
              SET status = 'RESOLVED',
                  resolution_type = ?,
                  resolved_category_id = ?,
                  normalized_alias = ?,
                  version = ?,
                  idempotency_hash = ?,
                  resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`
        ).run(resolutionType, targetCategoryId, normalizedAlias ?? null, newVersion, keyHash, row.id);
      })();

      return {
        schemaVersion: '1.0',
        data: {
          clarificationId: row.id,
          transactionId: row.transaction_public_id,
          status: 'RESOLVED',
          resolutionType,
          category: targetCategoryId ? { id: targetCategoryId, label: targetLabel } : null,
          normalizedAlias: normalizedAlias ?? null,
          rule: { status: applyToSimilar ? 'CREATED' : 'NOT_CREATED', applyToSimilar: Boolean(applyToSimilar) },
          version: newVersion,
        },
      };
    } catch (err) {
      if (err instanceof AgentAuthError) return;
      req.log.error(err, 'Erro em /api/agent/v1/clarifications/:id/resolve');
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
    }
  });

  // POST /api/agent/v1/query — docs/07 §H5/F8
  app.post<{
    Body: { question?: string; period?: string | null; timezone?: string };
  }>('/api/agent/v1/query', async (req, reply) => {
    try {
      await authenticateAgent(db, 'ai:query')(req, reply);
      const body = req.body ?? {};
      const question = (body.question ?? '').trim();

      if (!question || question.length > 500) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'question deve ter entre 1 e 500 caracteres.' },
        });
      }

      const tz = body.timezone ?? DEFAULT_TIMEZONE;
      const period = body.period ?? monthOf(todayCivil(tz));
      const range = monthRange(period);

      const overview = computeOverview(db, { from: range.from, to: range.to, timezone: tz });
      const pace = computePace(db, { month: period, timezone: tz });
      const categories = computeCategories(db, { from: range.from, to: range.to, timezone: tz });
      const recurrences = listRecurrences(db, { timezone: tz });

      const metrics: Record<string, unknown> = {};
      const metricRefs: string[] = [];

      if (overview.data.monthSpend.metricIds) {
        for (const [k, id] of Object.entries(overview.data.monthSpend.metricIds)) {
          metrics[id] = (overview.data.monthSpend as unknown as Record<string, unknown>)[k];
          metricRefs.push(id);
        }
      }

      if (pace.data.forecast.metricIds?.amount) {
        metrics[pace.data.forecast.metricIds.amount] = pace.data.forecast.amount;
        metricRefs.push(pace.data.forecast.metricIds.amount);
      }

      for (const c of categories.data.categories.slice(0, 5)) {
        if (c.metricIds?.posted) {
          metrics[c.metricIds.posted] = c.postedAmount;
          metricRefs.push(c.metricIds.posted);
        }
      }

      const contextData = sanitizeObjectForAI({
        period,
        monthSpend: overview.data.monthSpend,
        forecast: pace.data.forecast,
        topCategories: categories.data.categories.slice(0, 5).map((c) => ({
          label: c.label,
          amount: c.postedAmount,
          metricId: c.metricIds?.posted,
        })),
        recurrencesTotal: recurrences.data.annualizedTotal,
        metrics,
      });

      const prompt = `TAREFA: responda à pergunta do usuário sobre as finanças do período ${period} usando somente os números de CONTEXTO.
Cite os metricRefs das métricas citadas. Não invente números.
Retorne um JSON:
{
  "answer": "texto da resposta direto em português",
  "metricRefs": ["metricId1"]
}

PERGUNTA:
${sanitizeTextForAI(question)}

CONTEXTO:
${JSON.stringify(contextData, null, 2)}`;

      const aiRes = await callAI({
        messages: [
          {
            role: 'system',
            content:
              'Você é a camada de inteligência do PulsoFinanceiro para o Hermes. Responda factual e curto com base estrita no contexto.',
          },
          { role: 'user', content: prompt },
        ],
        responseFormatJson: true,
      });

      let parsed: { answer?: string; metricRefs?: string[] } = {};
      try {
        parsed = JSON.parse(aiRes.content);
      } catch {
        parsed = { answer: aiRes.content, metricRefs: [] };
      }

      return {
        schemaVersion: '1.0',
        computedAt: new Date().toISOString(),
        dataThrough: dataThroughInstant(db),
        period: { from: range.from, to: range.to, timezone: tz },
        currencyCode: 'BRL',
        counts: { metricRefs: parsed.metricRefs?.length ?? 0 },
        metricVersion: 'agent-query.v1',
        quality: 'complete',
        data: {
          question,
          answer: parsed.answer ?? '',
          metricRefs: parsed.metricRefs ?? [],
        },
        freshnessStatus: 'FRESH',
      };
    } catch (err) {
      if (err instanceof AgentAuthError) return;
      req.log.error(err, 'Erro em /api/agent/v1/query');
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
    }
  });
}
