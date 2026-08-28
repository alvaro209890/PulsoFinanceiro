/**
 * Script de CLI para gerar Token e registrar Service Principal no PulsoFinanceiro.
 * docs/14 §Autenticação.
 *
 * Uso:
 *   npx tsx scripts/create-principal.ts --name hermes-server --scopes "metrics:read,events:read,events:claim,events:ack"
 */
import { randomBytes, createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { openDb } from '../src/db/index.js';
import { getConfig } from '../src/config.js';

function main() {
  const args = process.argv.slice(2);
  let name = 'hermes-server';
  let scopes = ['metrics:read', 'events:read', 'events:claim', 'events:ack'];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[i + 1]!;
      i++;
    } else if (args[i] === '--scopes' && args[i + 1]) {
      scopes = args[i + 1]!.split(',').map((s) => s.trim());
      i++;
    }
  }

  const cfg = getConfig();
  const db = openDb(cfg.dbPath);

  const rawToken = `pulso_${randomBytes(24).toString('hex')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const id = `sp_${ulid().toLowerCase()}`;

  const existing = db.prepare('SELECT id FROM service_principals WHERE name = ?').get(name) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE service_principals
          SET current_token_hash = ?,
              scopes_json = ?,
              active = 1,
              revoked_at = NULL
        WHERE id = ?`
    ).run(tokenHash, JSON.stringify(scopes), existing.id);
    console.log(`Principal '${name}' atualizado (ID: ${existing.id}).`);
  } else {
    db.prepare(
      `INSERT INTO service_principals (id, name, current_token_hash, scopes_json, active)
       VALUES (?, ?, ?, ?, 1)`
    ).run(id, name, tokenHash, JSON.stringify(scopes));
    console.log(`Principal '${name}' criado (ID: ${id}).`);
  }

  console.log(`\n================ ATENÇÃO: GUARDE ESTE TOKEN ================\n`);
  console.log(`PULSO_HERMES_API_KEY=${rawToken}`);
  console.log(`\n============================================================\n`);

  db.close();
}

main();
