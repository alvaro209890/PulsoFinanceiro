import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrate.js';

export type Db = Database.Database;

/**
 * Abre o banco em modo WAL com foreign_keys ON (docs/03: SQLite com WAL,
 * foreign_keys=ON, UPSERT e JSON1). Cria o diretório se necessário.
 */
export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
