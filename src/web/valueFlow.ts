// Where the values of a column come from and where else they go. A foreign
// key is an inclusion dependency: the child's values are among the values of
// the parent's key. Those chain (A ⊆ B and B ⊆ C give A ⊆ C), so following
// the column pairs of foreign keys finds every column that carries the same
// values, up to a key that references nothing: tenant IDs, seller IDs…

import type { ViewTable } from '../core/view';
import { fkKey } from './diagram/colors';

export interface FlowColumn {
  table: string;
  column: string;
}

export interface Flow {
  /** Every column joined to the chosen one through foreign key column pairs. */
  columns: FlowColumn[];
  /** The lines of those pairs, by the ids the diagram gives them. */
  edges: Set<string>;
  /** From the chosen column up to the key its values come from. */
  path: FlowColumn[];
}

const lower = (s: string) => s.toLowerCase();
const node = (table: string, column: string) => `${table}\u0000${lower(column)}`;

/** Null when the column is in no foreign key, as child or as parent. */
export function valueFlow(tables: ViewTable[], table: string, column: string): Flow | null {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const declared = new Map<string, FlowColumn>();
  const near = new Map<string, Set<string>>(); // both ways
  const up = new Map<string, string[]>(); // child column → the columns it references
  const pairs: { id: string; a: string; b: string }[] = [];
  const link = (a: string, b: string) => {
    near.set(a, (near.get(a) ?? new Set()).add(b));
    near.set(b, (near.get(b) ?? new Set()).add(a));
  };
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const parent = byName.get(fk.refTable);
      if (fk.origin !== 'table' || !parent) continue; // MySQL ignores inline REFERENCES
      fk.columns.forEach((name, i) => {
        const col = t.columns.find((c) => lower(c.name) === lower(name));
        const ref = parent.columns.find((c) => lower(c.name) === lower(fk.refColumns[i] ?? ''));
        if (!col || !ref) return;
        const a = node(t.name, col.name);
        const b = node(parent.name, ref.name);
        declared.set(a, { table: t.name, column: col.name });
        declared.set(b, { table: parent.name, column: ref.name });
        link(a, b);
        up.set(a, [...(up.get(a) ?? []), b]);
        pairs.push({ id: `${fkKey(t.name, fk.id)}\u0000${i}`, a, b });
      });
    }
  }
  const start = node(table, column);
  if (!near.has(start)) return null;

  const seen = new Set([start]);
  const queue = [start];
  for (let k = 0; k < queue.length; k++) {
    for (const n of near.get(queue[k] as string) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }

  // The nearest key that references nothing, by breadth-first search upwards.
  const from = new Map<string, string>();
  const visited = new Set([start]);
  const climb = [start];
  let root = start;
  for (let k = 0; k < climb.length; k++) {
    const n = climb[k] as string;
    const parents = up.get(n) ?? [];
    if (parents.length === 0) {
      root = n;
      break;
    }
    for (const p of parents) {
      if (visited.has(p)) continue;
      visited.add(p);
      from.set(p, n);
      climb.push(p);
    }
  }
  const path: FlowColumn[] = [];
  for (let n: string | undefined = root; n !== undefined; n = from.get(n)) {
    const c = declared.get(n);
    if (c) path.unshift(c);
  }

  return {
    columns: tables.flatMap((t) =>
      t.columns
        .filter((c) => seen.has(node(t.name, c.name)))
        .map((c) => ({ table: t.name, column: c.name })),
    ),
    edges: new Set(pairs.filter((p) => seen.has(p.a) && seen.has(p.b)).map((p) => p.id)),
    path,
  };
}
