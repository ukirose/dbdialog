// Which foreign key a line drawn between two columns stands for. A line is
// written to the file at once, so this decides the direction and, for keys of
// several columns, the column pairs.

import type { FkSpec } from '../core/ops';
import type { ViewKey, ViewTable } from '../core/view';

export interface LineEnd {
  table: string;
  column: string;
}

export type Inferred =
  | { ok: true; table: string; fk: FkSpec }
  | { ok: false; reason: 'unknown' | 'same-column' | 'exists' };

const lower = (s: string) => s.toLowerCase();
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => lower(x) === lower(b[i] ?? ''));

/** The keys a foreign key may point at: the PRIMARY KEY, then UNIQUE keys in file order. */
function targetKeys(t: ViewTable): ViewKey[] {
  return [...(t.primaryKey ? [t.primaryKey] : []), ...t.keys.filter((k) => k.kind === 'unique')];
}

/**
 * The child's columns for key `k` of the parent, `childCol` standing for
 * `parentCol` and the others found by name; null when one is missing.
 */
function completeByName(
  k: ViewKey,
  parentCol: string,
  child: ViewTable,
  childCol: string,
): string[] | null {
  const mapped = k.columns.map((c) =>
    lower(c) === lower(parentCol)
      ? childCol
      : child.columns.find((x) => lower(x.name) === lower(c))?.name,
  );
  if (mapped.some((m) => m === undefined)) return null;
  const names = mapped as string[];
  return new Set(names.map(lower)).size === names.length ? names : null;
}

/** Whether `column` of `t` can be what a foreign key from `other` points at: a whole key. */
function referable(
  t: ViewTable,
  column: string,
  other: ViewTable,
  otherCol: string,
  single: boolean,
): boolean {
  return targetKeys(t).some(
    (k) =>
      k.columns.some((c) => lower(c) === lower(column)) &&
      (k.columns.length === 1 || (!single && completeByName(k, column, other, otherCol) !== null)),
  );
}

/**
 * - The referenced side is the one whose column can make up a whole PRIMARY
 *   KEY or UNIQUE key (alone, or completed by name as below). When both or
 *   neither can, it is the column the line was dropped on.
 * - Unless `single`, a key of several columns is completed by name: when the
 *   referenced column belongs to such a key, and the other table has a column
 *   of the same name for each of the key's other columns, the foreign key uses
 *   all of them. Of several such keys, the one with the most columns wins.
 */
export function inferForeignKey(
  tables: ViewTable[],
  from: LineEnd,
  to: LineEnd,
  single: boolean,
): Inferred {
  const a = tables.find((x) => x.name === from.table);
  const b = tables.find((x) => x.name === to.table);
  const colA = a?.columns.find((c) => lower(c.name) === lower(from.column))?.name;
  const colB = b?.columns.find((c) => lower(c.name) === lower(to.column))?.name;
  if (!a || !b || !colA || !colB) return { ok: false, reason: 'unknown' };
  if (a === b && lower(colA) === lower(colB)) return { ok: false, reason: 'same-column' };

  const flip = referable(a, colA, b, colB, single) && !referable(b, colB, a, colA, single);
  const [child, childCol, parent, parentCol] = flip
    ? ([b, colB, a, colA] as const)
    : ([a, colA, b, colB] as const);

  let columns = [childCol];
  let refColumns = [parentCol];
  if (!single) {
    let best = 1;
    for (const k of targetKeys(parent)) {
      if (k.columns.length <= best || !k.columns.some((c) => lower(c) === lower(parentCol)))
        continue;
      const names = completeByName(k, parentCol, child, childCol);
      if (!names) continue;
      best = k.columns.length;
      columns = names;
      refColumns = [...k.columns];
    }
  }

  const exists = child.foreignKeys.some(
    (f) =>
      f.origin === 'table' &&
      lower(f.refTable) === lower(parent.name) &&
      sameList(f.columns, columns) &&
      sameList(f.refColumns, refColumns),
  );
  if (exists) return { ok: false, reason: 'exists' };
  return {
    ok: true,
    table: child.name,
    fk: { name: null, columns, refTable: parent.name, refColumns, onDelete: null, onUpdate: null },
  };
}
