/**
 * Script de CLI para o Hermes consultar o briefing diário e eventos do PulsoFinanceiro.
 * docs/16 §I1 e docs/14 §Contratos para agentes.
 *
 * Uso:
 *   npx tsx scripts/agent-briefing.ts [--period YYYY-MM] [--api-url http://127.0.0.1:3040]
 */
import { getConfig } from '../src/config.js';

interface SummaryResponse {
  schemaVersion: string;
  computedAt: string;
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  metrics: Array<{ metricId: string; name: string; value: number; currencyCode: string }>;
  freshnessStatus: string;
}

interface ProjectionResponse {
  projection: { amount: number; rangeLow: number; rangeHigh: number };
  components: Array<{ kind: string; amount: number }>;
}

interface AnomaliesResponse {
  anomalies: Array<{ id: string; kind: string; severity: string; summary: string }>;
}

async function main() {
  const token = process.env.PULSO_HERMES_API_KEY;
  const baseUrl = process.env.PULSO_API_URL ?? 'http://127.0.0.1:3040';

  if (!token) {
    console.error('Erro: Variável PULSO_HERMES_API_KEY ausente no ambiente.');
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const period = new Date().toISOString().slice(0, 7);

  try {
    const [summaryRes, projRes, anomRes] = await Promise.all([
      fetch(`${baseUrl}/api/agent/v1/summary?period=${period}`, { headers }),
      fetch(`${baseUrl}/api/agent/v1/projection?month=${period}`, { headers }),
      fetch(`${baseUrl}/api/agent/v1/anomalies?limit=5`, { headers }),
    ]);

    if (!summaryRes.ok) {
      console.error(`Erro ao buscar resumo (${summaryRes.status}): ${await summaryRes.text()}`);
      process.exit(1);
    }

    const summary = (await summaryRes.json()) as SummaryResponse;
    const proj = projRes.ok ? ((await projRes.json()) as ProjectionResponse) : null;
    const anom = anomRes.ok ? ((await anomRes.json()) as AnomaliesResponse) : null;

    const spend = summary.metrics.find((m) => m.name === 'monthSpend')?.value ?? 0;
    const forecast = summary.metrics.find((m) => m.name === 'forecast')?.value ?? (proj?.projection.amount ?? 0);

    const brl = (v: number) =>
      new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

    console.log(`📊 **Briefing Financeiro — ${period}**`);
    console.log(`• Gasto realizado: **${brl(spend)}**`);
    console.log(`• Projeção do mês: **${brl(forecast)}**`);
    if (proj?.projection.rangeLow && proj.projection.rangeHigh) {
      console.log(`• Faixa estimada: ${brl(proj.projection.rangeLow)} a ${brl(proj.projection.rangeHigh)}`);
    }

    if (anom?.anomalies && anom.anomalies.length > 0) {
      console.log(`\n⚠️ **Pontos de Atenção / Anomalias:**`);
      for (const a of anom.anomalies) {
        console.log(`  - [${a.severity}] ${a.summary}`);
      }
    } else {
      console.log(`\n✅ Nenhum alerta crítico ou duplicidade detectada no período.`);
    }

    console.log(`\n_Status de sincronização: ${summary.freshnessStatus}_`);
  } catch (err: any) {
    console.error('Falha de conexão com a API do PulsoFinanceiro:', err?.message ?? err);
    process.exit(1);
  }
}

main();
