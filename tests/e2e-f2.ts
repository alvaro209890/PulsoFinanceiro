/**
 * E2E da F2 — sobe o servidor real com um banco sintético e confere que os
 * três contratos devolvem os MESMOS números (docs/12 §6).
 *
 * Uso:
 *   npx tsx tests/e2e-f2.ts            # verifica e encerra
 *   npx tsx tests/e2e-f2.ts --serve    # mantém no ar para inspeção visual
 *
 * Nenhum dado real, nenhum segredo: as credenciais são placeholders e o
 * cliente Pluggy nunca é chamado.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addSnapshot,
  addSyncRun,
  addTx,
  CARD,
  CAT_ALIMENTACAO,
  CAT_COMPRAS,
  CAT_TRANSFER,
  CAT_VESTUARIO,
  makeDb,
  seedMonthlySpend,
} from './fixtures/f2.js';
import { addMonths, monthOf, monthRange, today } from '../src/finance/time.js';

process.env.PLUGGY_CLIENT_ID ??= 'e2e-id';
process.env.PLUGGY_CLIENT_SECRET ??= 'e2e-secret';
delete process.env.PLUGGY_ITEM_ID;

const PORT = Number(process.env.E2E_PORT ?? 3041);
const SERVE = process.argv.includes('--serve');
const DB_PATH = join(tmpdir(), `pulso-e2e-f2-${Date.now()}.sqlite`);

const TODAY = today();
const MONTH = monthOf(TODAY);
const { from, to } = monthRange(MONTH);
const HISTORY = [addMonths(MONTH, -3), addMonths(MONTH, -2), addMonths(MONTH, -1)];

function seed(): void {
  const db = makeDb(DB_PATH);
  // Histórico comparável: 3 meses com o mesmo padrão de gasto.
  seedMonthlySpend(db, HISTORY, 3, 180, CAT_COMPRAS);
  seedMonthlySpend(db, HISTORY, 8, 95.4, CAT_ALIMENTACAO);
  seedMonthlySpend(db, HISTORY, 22, 260, CAT_VESTUARIO);

  // Mês corrente
  addTx(db, { date: `${MONTH}-02`, amount: 210.9, categoryId: CAT_VESTUARIO, order: 1 });
  addTx(db, { date: `${MONTH}-03`, amount: 64.3, categoryId: CAT_ALIMENTACAO, order: 2 });
  addTx(db, { date: `${MONTH}-03`, amount: 1200, categoryId: CAT_TRANSFER, order: 3 });
  addTx(db, { date: TODAY, amount: 38.5, categoryId: CAT_COMPRAS, status: 'PENDING', order: 4 });
  addTx(db, { date: TODAY, amount: 120, account: CARD, categoryId: CAT_COMPRAS, order: 5 });

  addSnapshot(db, {
    date: `${addMonths(MONTH, -1)}-28`,
    bankMinor: 900_000,
    billMinor: 100_000,
    billDueDate: `${MONTH}-10`,
  });
  addSnapshot(db, { date: TODAY, bankMinor: 977_065, billMinor: 132_040, billDueDate: `${addMonths(MONTH, 1)}-10` });
  addSyncRun(db, new Date().toISOString());
  db.close();
}

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (esperado ${JSON.stringify(expected)})`}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  seed();
  const { buildServer } = await import('../src/index.js');
  const server = buildServer(DB_PATH);
  await server.app.listen({ port: PORT, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${PORT}`;

  const overview = await (await fetch(`${base}/api/v1/dashboard/overview?from=${from}&to=${to}`)).json();
  const pace = await (await fetch(`${base}/api/v1/analytics/monthly-pace?month=${MONTH}`)).json();
  const categories = await (await fetch(`${base}/api/v1/analytics/categories?from=${from}&to=${to}`)).json();

  const posted = overview.data.monthSpend.posted;
  check('overview.monthSpend.posted == pace.confirmedSpend', posted, pace.data.confirmedSpend.amount);
  check('overview.monthSpend.posted == categories.total', posted, categories.data.total.postedAmount);
  check(
    'soma das raízes fecha com o total',
    Math.round(categories.data.categories.reduce((a: number, c: { postedAmount: number }) => a + c.postedAmount, 0) * 100) / 100,
    categories.data.total.postedAmount
  );
  check('transferência interna fora do rollup', categories.data.categories.some((c: { rootCode: string }) => c.rootCode === '04'), false);
  check('projeção coerente entre contratos', overview.data.forecast.amount, pace.data.forecast.amount);
  check('patrimônio observável', overview.data.netWorth.amount, 8450.25);
  check('variação com base no snapshot anterior', overview.data.netWorth.changeAmount, 450.25);

  console.log('\nresumo:');
  console.log(`  gasto confirmado : ${posted}`);
  console.log(`  provisório       : ${overview.data.monthSpend.pending}`);
  console.log(`  projeção         : ${overview.data.forecast.amount} (${overview.data.forecast.confidence})`);
  console.log(`  ritmo            : ${pace.data.paceRatio.value ?? 'null'} · qualidade ${pace.quality}`);
  console.log(`  patrimônio       : ${overview.data.netWorth.amount}`);

  if (SERVE) {
    console.log(`\nservindo em ${base} — Ctrl+C encerra (banco: ${DB_PATH})`);
    return;
  }
  await server.close();
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
