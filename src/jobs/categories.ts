/**
 * Taxonomia de categorias — docs/05 §`categories` e `category_overrides`.
 *
 * `categories` é espelho de `GET /categories` e a sincronização acontece
 * ANTES das transações. Se uma transação trouxer categoria ausente, o
 * catálogo é ressincronizado uma vez; se ainda assim continuar desconhecida,
 * a transação é persistida com `category_id = NULL`, o valor original
 * permanece no JSON sanitizado e o drift de contrato é contado.
 */
import type { Db } from '../db/index.js';
import type { PluggyClient } from '../pluggy/client.js';

export interface CategorySyncState {
  known: Set<string>;
  /** O catálogo já foi ressincronizado neste ciclo? */
  refreshed: boolean;
  /** Quantas transações citaram categoria que não existe no catálogo. */
  drift: number;
}

export function loadKnownCategoryIds(db: Db): Set<string> {
  const rows = db.prepare('SELECT id FROM categories').all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Espelha o catálogo; pais primeiro por causa da FK para a própria tabela. */
export async function syncCategories(db: Db, client: PluggyClient): Promise<number> {
  const categories = await client.getCategories();
  const upsert = db.prepare(
    `INSERT INTO categories (id, description, description_translated, parent_id, level1_prefix)
     VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET description=excluded.description,
       description_translated=excluded.description_translated,
       parent_id=excluded.parent_id, level1_prefix=excluded.level1_prefix,
       synced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );
  const run = db.transaction(() => {
    for (const c of categories.filter((c) => !c.parentId)) {
      upsert.run(c.id, c.description, c.descriptionTranslated, null, c.id.slice(0, 2));
    }
    for (const c of categories.filter((c) => c.parentId)) {
      upsert.run(c.id, c.description, c.descriptionTranslated, c.parentId, c.id.slice(0, 2));
    }
  });
  run();
  return categories.length;
}

export function newCategoryState(db: Db): CategorySyncState {
  return { known: loadKnownCategoryIds(db), refreshed: false, drift: 0 };
}

/**
 * Antes de persistir uma página, garante que as categorias citadas existem.
 * Ressincroniza no máximo uma vez por ciclo — categoria nova da Pluggy é
 * evento raro e não pode virar uma chamada por transação.
 */
export async function ensureCategoriesFor(
  db: Db,
  client: PluggyClient,
  rows: readonly unknown[],
  state: CategorySyncState
): Promise<void> {
  if (state.refreshed) return;
  const missing = rows.some((raw) => {
    const id = (raw as Record<string, unknown>)['categoryId'];
    return typeof id === 'string' && id.length > 0 && !state.known.has(id);
  });
  if (!missing) return;
  await syncCategories(db, client);
  state.known = loadKnownCategoryIds(db);
  state.refreshed = true;
}

/** Categoria efetiva: a conhecida, ou `null` com drift contado. */
export function resolveCategory(categoryId: string | null, state: CategorySyncState): string | null {
  if (categoryId === null) return null;
  if (state.known.has(categoryId)) return categoryId;
  state.drift += 1;
  return null;
}
