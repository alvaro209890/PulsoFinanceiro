import { openDb } from './src/db/index.js';
import { merchantsRanking } from './src/finance/merchants-pix.js';

const db = openDb(':memory:');
db.prepare(`INSERT INTO categories (id, description, description_translated) VALUES ('01000001','Income','Renda')`).run();
db.prepare(`INSERT INTO categories (id, description, description_translated) VALUES ('02000001','Mercado','Mercado')`).run();
db.prepare(`INSERT INTO items (public_id, external_id, status) VALUES ('ipub','ext-item','UPDATED')`).run();
db.prepare(
  `INSERT INTO accounts (public_id, external_id, item_public_id, type, subtype, label, balance, currency)
   VALUES ('acc1','a-ext','ipub','BANK','CHECKING_ACCOUNT','Conta',1000,'BRL')`
).run();

const ins = db.prepare(
  `INSERT INTO transactions (public_id, external_id, account_public_id, amount, currency, date,
    status, type, operation_type, description, category_id, merchant_cnpj, merchant_business_name,
    description_raw_normalized)
   VALUES (?,?,?,?,?,'BRL',?,?,?,?,?,?,?,?)`
);
ins.run('m1', 'e-m1', 'acc1', 150, '2026-08-03T10:00:00Z'.slice(0, 10), 'POSTED', 'DEBIT', null, null, '02000001', '12345678000195', 'Super Mercado', null);

const raw = db.prepare("SELECT public_id, substr(date,1,10) AS d FROM transactions").all();
console.log('raw:', JSON.stringify(raw));
const r = merchantsRanking(db, { from: '2026-08-01', to: '2026-09-01' });
console.log('ranking:', JSON.stringify(r));
