/**
 * Eventos determinísticos de ritmo — docs/12 §F2 (“criar eventos de outbox
 * para limite/ritmo/anomalia somente quando a regra determinística já
 * estiver testada, ainda sem entrega por canal”).
 *
 * A F2 entregou o ritmo; a F3 acrescenta limite de cartão, vencimento e
 * recorrências. Anomalia `LOG_ZSCORE` continua na F4 e nada é emitido para
 * essa família aqui. Nenhum evento é entregue por canal nesta fase.
 *
 * O episódio abre quando o ritmo cruza `PACE_OPEN_RATIO` e só fecha abaixo
 * de `PACE_CLOSE_RATIO` (histerese), evitando alerta piscando na fronteira.
 * O payload não carrega valor monetário, descrição nem ID externo.
 */
import type { Db } from '../db/index.js';
import { closeCondition, emitEvent, type OutboxSeverity } from '../db/outbox.js';
import { computePace, MetricNotAvailable } from './pace.js';
import { DEFAULT_TIMEZONE, daysBetween, monthOf, today as todayCivil } from './time.js';
import { findCardAccount, limitBand, type LimitBand } from './creditCard.js';

export const PACE_OPEN_RATIO = 1.25;
export const PACE_CLOSE_RATIO = 1.15;
export const PACE_EVENT_TYPE = 'MONTH_PACE_HIGH';

export interface PaceEventResult {
  month: string;
  ratio: number | null;
  emitted: boolean;
  closed: boolean;
  severity: OutboxSeverity | null;
}

export function severityForRatio(ratio: number): OutboxSeverity {
  if (ratio >= 2) return 'CRITICAL';
  if (ratio >= 1.5) return 'HIGH';
  return 'WARNING';
}

/**
 * Avalia o ritmo do mês corrente e mantém o episódio da outbox coerente.
 * Chamado no fim do harvest, no mesmo ponto em que a métrica é confirmada.
 */
export function evaluatePaceEvent(
  db: Db,
  options: { month?: string; timezone?: string; now?: Date } = {}
): PaceEventResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();
  const month = options.month ?? monthOf(todayCivil(timezone, now));
  const dedupKey = `${PACE_EVENT_TYPE}:${month}`;

  let ratio: number | null = null;
  let quality = 'insufficient';
  try {
    const pace = computePace(db, { month, timezone, now });
    ratio = pace.internals.paceRatio;
    quality = pace.quality;
  } catch (err) {
    if (!(err instanceof MetricNotAvailable)) throw err;
    return { month, ratio: null, emitted: false, closed: closeCondition(db, dedupKey), severity: null };
  }

  // Amostra insuficiente não gera alerta: ausência não é excesso.
  if (ratio === null || quality === 'insufficient' || quality === 'not_comparable') {
    return { month, ratio, emitted: false, closed: closeCondition(db, dedupKey), severity: null };
  }

  if (ratio >= PACE_OPEN_RATIO) {
    const severity = severityForRatio(ratio);
    emitEvent(db, {
      eventType: PACE_EVENT_TYPE,
      severity,
      dedupKey,
      payload: {
        month,
        paceRatio: ratio,
        quality,
        metricId: `month-pace-ratio:${month}:6`,
        policyVersion: 'PACE_POLICY_V1',
      },
    });
    return { month, ratio, emitted: true, closed: false, severity };
  }

  if (ratio < PACE_CLOSE_RATIO) {
    return { month, ratio, emitted: false, closed: closeCondition(db, dedupKey), severity: null };
  }

  // Zona de histerese: mantém o episódio como está.
  return { month, ratio, emitted: false, closed: false, severity: null };
}


// ---------------------------------------------------------------------------
// F3 — cartão e recorrências
// ---------------------------------------------------------------------------

export const CREDIT_LIMIT_EVENT_TYPE = 'CREDIT_LIMIT_BAND_CHANGED';
export const BILL_DUE_EVENT_TYPE = 'BILL_DUE_SOON';
export const RECURRENCE_PRICE_EVENT_TYPE = 'RECURRENCE_PRICE_INCREASE';
export const RECURRENCE_RESUMED_EVENT_TYPE = 'RECURRENCE_RESUMED_AFTER_GAP';

/** Janela do aviso de vencimento, em dias civis. */
export const BILL_DUE_SOON_DAYS = 5;

export const CARD_POLICY_VERSION = 'CARD_POLICY_V1';
export const RECURRENCE_POLICY_VERSION = 'RECURRENCE_POLICY_V1';

export interface CardAndRecurrenceEvents {
  limitBand: LimitBand | null;
  limitEmitted: boolean;
  billDueEmitted: boolean;
  priceIncreases: number;
  resumed: number;
}

/**
 * Avalia limite, vencimento e recorrências, mantendo um episódio por
 * condição. A chave de dedup inclui tipo, entidade, janela/ciclo e versão
 * da política, como exige o roadmap (docs/12 §7).
 *
 * Nenhum payload carrega descrição, merchant, número de cartão ou valor de
 * saldo: só identificadores locais, faixas e percentuais.
 */
export function evaluateCardAndRecurrenceEvents(
  db: Db,
  options: { timezone?: string; now?: Date } = {}
): CardAndRecurrenceEvents {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();
  const currentDay = todayCivil(timezone, now);
  const out: CardAndRecurrenceEvents = {
    limitBand: null,
    limitEmitted: false,
    billDueEmitted: false,
    priceIncreases: 0,
    resumed: 0,
  };

  const account = findCardAccount(db);
  if (account) {
    // --- Faixa do limite ---------------------------------------------------
    const total = account.creditLimit;
    const available = account.availableCreditLimit;
    const usedPercent =
      total !== null && available !== null && total > 0
        ? Math.round(((total - available) / total) * 10_000) / 100
        : null;
    const band = limitBand(usedPercent);
    out.limitBand = band;

    // Uma faixa nova encerra o episódio da faixa anterior: a condição
    // "está nesta faixa" deixou de ser verdadeira.
    for (const other of ['ATTENTION', 'HIGH', 'CRITICAL'] as const) {
      if (other !== band) {
        closeCondition(db, `${CREDIT_LIMIT_EVENT_TYPE}:${account.publicId}:${other}:${CARD_POLICY_VERSION}`);
      }
    }
    if (band === 'ATTENTION' || band === 'HIGH' || band === 'CRITICAL') {
      emitEvent(db, {
        eventType: CREDIT_LIMIT_EVENT_TYPE,
        severity: band === 'CRITICAL' ? 'CRITICAL' : band === 'HIGH' ? 'HIGH' : 'WARNING',
        dedupKey: `${CREDIT_LIMIT_EVENT_TYPE}:${account.publicId}:${band}:${CARD_POLICY_VERSION}`,
        payload: {
          accountId: account.publicId,
          band,
          usedPercent,
          policyVersion: CARD_POLICY_VERSION,
          metricId: `credit-limit-used-percent:${account.publicId}`,
        },
      });
      out.limitEmitted = true;
    }

    // --- Vencimento próximo ------------------------------------------------
    const bills = db
      .prepare(
        `SELECT due_date FROM credit_card_bills WHERE account_public_id = ? ORDER BY due_date DESC LIMIT 6`
      )
      .all(account.publicId) as Array<{ due_date: string }>;

    for (const bill of bills) {
      const days = daysBetween(currentDay, bill.due_date);
      const key = `${BILL_DUE_EVENT_TYPE}:${account.publicId}:${bill.due_date}:${CARD_POLICY_VERSION}`;
      if (days >= 0 && days <= BILL_DUE_SOON_DAYS) {
        emitEvent(db, {
          eventType: BILL_DUE_EVENT_TYPE,
          severity: days === 0 ? 'HIGH' : days <= 2 ? 'HIGH' : 'WARNING',
          dedupKey: key,
          payload: {
            accountId: account.publicId,
            dueDate: bill.due_date,
            daysUntilDue: days,
            // A fonte nao informa confirmacao de pagamento: o evento avisa
            // do vencimento e nunca afirma inadimplencia.
            paymentStatusKnown: false,
            policyVersion: CARD_POLICY_VERSION,
          },
        });
        out.billDueEmitted = true;
      } else {
        closeCondition(db, key);
      }
    }
  }

  // --- Recorrências --------------------------------------------------------
  const recurrences = db
    .prepare(
      `SELECT id, status, price_increase_detected, price_base_minor, price_current_minor,
              last_occurrence_date, last_gap_days, cadence
         FROM recurring_analysis`
    )
    .all() as Array<{
      id: string;
      status: string;
      price_increase_detected: number;
      price_base_minor: number | null;
      price_current_minor: number | null;
      last_occurrence_date: string | null;
      last_gap_days: number | null;
      cadence: string;
    }>;

  for (const r of recurrences) {
    const priceKey = `${RECURRENCE_PRICE_EVENT_TYPE}:${r.id}:${r.last_occurrence_date ?? 'none'}:${RECURRENCE_POLICY_VERSION}`;
    if (r.price_increase_detected === 1 && r.price_base_minor && r.price_current_minor) {
      emitEvent(db, {
        eventType: RECURRENCE_PRICE_EVENT_TYPE,
        severity: 'WARNING',
        dedupKey: priceKey,
        payload: {
          recurrenceId: r.id,
          cadence: r.cadence,
          increasePercent:
            Math.round(((r.price_current_minor - r.price_base_minor) / r.price_base_minor) * 10_000) / 100,
          policyVersion: RECURRENCE_POLICY_VERSION,
          metricId: `recurrence-price-percent:${r.id}`,
        },
      });
      out.priceIncreases += 1;
    } else {
      closeCondition(db, priceKey);
    }

    const resumedKey = `${RECURRENCE_RESUMED_EVENT_TYPE}:${r.id}:${r.last_occurrence_date ?? 'none'}:${RECURRENCE_POLICY_VERSION}`;
    if (r.status === 'RESUMED') {
      emitEvent(db, {
        eventType: RECURRENCE_RESUMED_EVENT_TYPE,
        severity: 'INFO',
        dedupKey: resumedKey,
        payload: {
          recurrenceId: r.id,
          cadence: r.cadence,
          lastGapDays: r.last_gap_days,
          // Prova apenas que a COBRANCA reapareceu no extrato. Nao existe
          // dado de uso, cancelamento ou contrato (docs/09 6.3).
          claim: 'CHARGE_REAPPEARED_AFTER_GAP',
          policyVersion: RECURRENCE_POLICY_VERSION,
        },
      });
      out.resumed += 1;
    } else {
      closeCondition(db, resumedKey);
    }
  }

  return out;
}
