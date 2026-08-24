/**
 * Harvest manual — operação, não interface.
 *
 * Roda um ciclo completo contra a Pluggy com as credenciais do ambiente e
 * imprime apenas CONTAGENS: nenhum valor monetário, descrição, titular ou
 * identificador externo aparece na saída (docs/07 §observabilidade).
 *
 *   npx tsx --env-file=.env scripts/harvest.ts
 */
import { getConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { PluggyClient } from '../src/pluggy/client.js';
import { syncItem } from '../src/jobs/sync.js';

async function main(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.pluggyItemId) {
    console.error('PLUGGY_ITEM_ID ausente: nada a sincronizar.');
    process.exit(2);
  }
  const db = openDb(cfg.dbPath);
  const client = new PluggyClient(cfg.pluggyClientId, cfg.pluggyClientSecret);

  const started = Date.now();
  const result = await syncItem(db, client, cfg.pluggyItemId, 'daily');
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  console.log(`harvest ${result.ok ? 'ok' : `FALHOU (${result.errorCode})`} em ${seconds}s`);
  console.log(`  páginas: ${result.pagesFetched} | transações upsertadas: ${result.txsUpserted}`);
  console.log(`  faturas: ${result.billsUpserted} | matches de pagamento: ${result.billMatches}`);
  console.log(`  recorrências persistidas: ${result.recurrences}`);
  console.log(`  categorias sincronizadas: ${result.categoriesSynced} | drift de categoria: ${result.categoryDrift}`);
  console.log('--- estado local (contagens) ---');
  console.log(`  categorias: ${count('SELECT COUNT(*) AS n FROM categories')}`);
  console.log(`  contas: ${count('SELECT COUNT(*) AS n FROM accounts')}`);
  console.log(`  transações: ${count('SELECT COUNT(*) AS n FROM transactions')}`);
  console.log(`  pendentes: ${count("SELECT COUNT(*) AS n FROM transactions WHERE status='PENDING'")}`);
  console.log(`  transferência interna: ${count('SELECT COUNT(*) AS n FROM transactions WHERE is_internal_transfer=1')}`);
  console.log(`  raiz 04: ${count("SELECT COUNT(*) AS n FROM transactions WHERE substr(category_id,1,2)='04'")}`);
  console.log(`  faturas: ${count('SELECT COUNT(*) AS n FROM credit_card_bills')}`);
  console.log(`  encargos: ${count('SELECT COUNT(*) AS n FROM bill_finance_charges')}`);
  console.log(`  pagamentos de fatura: ${count('SELECT COUNT(*) AS n FROM bill_payments')}`);
  console.log(`  matches: ${count('SELECT COUNT(*) AS n FROM transaction_bill_payment_matches')}`);
  console.log(`  snapshots: ${count('SELECT COUNT(*) AS n FROM balance_snapshots')}`);
  console.log(`  recorrências: ${count('SELECT COUNT(*) AS n FROM recurring_analysis')}`);
  console.log(`  eventos na outbox: ${count('SELECT COUNT(*) AS n FROM outbox_events')}`);

  db.close();
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('erro:', err instanceof Error ? err.message : err);
  process.exit(1);
});
