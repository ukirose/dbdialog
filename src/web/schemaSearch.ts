// Finding a table or column by its name or comment (the search box, ⌘K).

import type { ViewTable } from '../core/view';

export interface Hit {
  table: string;
  /** null when the hit is the table itself. */
  column: string | null;
  /** The comment, or the type of a column without one. */
  detail: string;
}

/**
 * Exact names first, then names that start with the query, then names that
 * contain it, then comments that contain it; a table before its columns, and
 * otherwise in file order.
 */
export function searchSchema(tables: ViewTable[], query: string, limit = 30): Hit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const rank = (name: string, comment: string | null): number => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (comment?.toLowerCase().includes(q)) return 3;
    return -1;
  };
  const found: { score: number; hit: Hit }[] = [];
  for (const t of tables) {
    const r = rank(t.name, t.comment);
    if (r >= 0)
      found.push({ score: r * 2, hit: { table: t.name, column: null, detail: t.comment ?? '' } });
    for (const c of t.columns) {
      const rc = rank(c.name, c.comment);
      if (rc >= 0)
        found.push({
          score: rc * 2 + 1,
          hit: { table: t.name, column: c.name, detail: c.comment ?? c.type },
        });
    }
  }
  // Array.prototype.sort is stable, so equal scores keep the file order.
  return found
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((f) => f.hit);
}
