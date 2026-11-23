// How many rows a foreign key relates, read from the DDL alone.

import type { ForeignKeyDef, TableDef } from './model';

export interface Cardinality {
  /**
   * Parent rows per child row. Exactly one only when every FK column is NOT
   * NULL: MySQL checks a composite key only when all of its columns are set
   * (MATCH SIMPLE), so one NULL column means "no parent".
   */
  parent: 'one' | 'zeroOrOne';
  /** Child rows per parent row: at most one when a PRIMARY KEY or UNIQUE key of the child lies within the FK columns. */
  child: 'zeroOrOne' | 'zeroOrMany';
  /** Every FK column is part of the child's primary key (an identifying relationship). */
  identifying: boolean;
}

const lower = (s: string) => s.toLowerCase();

export function cardinality(t: TableDef, fk: ForeignKeyDef): Cardinality {
  const pk = new Set((t.primaryKey?.columns.parts ?? []).map((p) => lower(p.column ?? '')));
  const fkColumns = fk.columns.parts.map((p) => lower(p.column ?? ''));
  const inFk = new Set(fkColumns);
  const notNull = (name: string) => {
    const c = t.columns.find((x) => lower(x.name) === name);
    // Primary key columns are NOT NULL even when the definition does not say so.
    return pk.has(name) || c?.nullable?.value === false;
  };
  const uniqueKeys = [
    ...(t.primaryKey ? [t.primaryKey] : []),
    ...t.keys.filter((k) => k.kind === 'unique'),
  ];
  const atMostOne = uniqueKeys.some(
    (k) =>
      k.columns.parts.length > 0 &&
      k.columns.parts.every((p) => p.column !== null && inFk.has(lower(p.column))),
  );
  return {
    parent: fkColumns.every(notNull) ? 'one' : 'zeroOrOne',
    child: atMostOne ? 'zeroOrOne' : 'zeroOrMany',
    identifying: fkColumns.length > 0 && fkColumns.every((c) => pk.has(c)),
  };
}
