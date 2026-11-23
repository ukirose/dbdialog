// What IE and IDEF1X diagrams read from the DDL besides the columns: which
// tables are dependent entities, and the numbers of the alternate keys.
// IDEF1X as in FIPS PUB 184 (1993); IE as erwin draws it, with the solid and
// dashed lines and the rounded corners it takes from IDEF1X.

import type { ViewTable } from '../../core/view';

/**
 * A dependent entity: the child of an identifying relationship, i.e. its
 * primary key holds every column of one of its foreign keys, so a row cannot
 * be told apart without its parent. Drawn with rounded corners (FIPS 184 3.1.2).
 * Inline REFERENCES do not count: MySQL creates no foreign key for them.
 */
export const isDependent = (t: ViewTable): boolean =>
  t.foreignKeys.some((fk) => fk.origin === 'table' && fk.cardinality.identifying);

/**
 * IDEF1X alternate keys: every UNIQUE key, numbered from 1 in the order of the
 * table (FIPS 184 3.8.2). Key id → number.
 */
export function alternateKeys(t: ViewTable): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of t.keys) if (k.kind === 'unique') out.set(k.id, out.size + 1);
  return out;
}

/** Lower-cased column name → the numbers of the alternate keys it belongs to. */
export function columnAlternateKeys(t: ViewTable): Map<string, number[]> {
  const numbers = alternateKeys(t);
  const out = new Map<string, number[]>();
  for (const k of t.keys) {
    const n = numbers.get(k.id);
    if (n === undefined) continue;
    for (const c of k.columns) {
      const name = c.toLowerCase();
      out.set(name, [...(out.get(name) ?? []), n]);
    }
  }
  return out;
}
