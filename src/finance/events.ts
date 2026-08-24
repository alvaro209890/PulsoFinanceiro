/**
 * Eventos determinísticos de ritmo — docs/12 §F2 (“criar eventos de outbox
 * para limite/ritmo/anomalia somente quando a regra determinística já
 * estiver testada, ainda sem entrega por canal”).
 *
 * A F2 entrega apenas o ritmo: limite de cartão pertence à F3 e anomalia
 * `LOG_ZSCORE` à F4, então nada é emitido para essas famílias aqui.
 *
 * O episódio abre quando o ritmo cruza `PACE_OPEN_RATIO` e só fecha abaixo
 * de `PACE_CLOSE_RATIO` (histerese), evitando alerta piscando na fronteira.
 * O payload não carrega valor monetário, descrição nem ID externo.
 */
import type { Db } from '../db/index.js';
import { closeCondition, emitEvent, type OutboxSeverity } from '../db/outbox.js';
import { computePace, MetricNotAvailable } from './pace.js';
import { DEFAULT_TIMEZONE, monthOf, today as todayCivil } from './time.js';

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
