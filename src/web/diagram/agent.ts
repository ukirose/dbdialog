// The view for coding agents (?view=agent) draws what a picture shows best:
// how the tables hang together, and where that pattern breaks. An agent reads
// what one statement says (types, NULL, constraints) from the SQL; the picture
// is the graph of the tables (which table references which, how deep the
// parents go, which tables many others reference, cycles, tables left on
// their own), with the column relations across tables that make or break the
// pattern: a column named like a reference with no foreign key, and a foreign
// key that leaves out the column most keys carry. These helpers are shared by
// the page and its tests.

import { looksLikeReference, namedAfterOwnTable, sharedColumns } from '../../core/smells';
import type { ViewTable } from '../../core/view';
import { fkKey } from './colors';
import { cycleClosers } from './elkLayout';

/** A table and the tables next to it: those it references and those referencing it. */
export function focusTables(tables: ViewTable[], name: string): ViewTable[] {
  const near = new Set([name]);
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (t.name === name) near.add(fk.refTable);
      if (fk.refTable === name) near.add(t.name);
    }
  }
  return tables.filter((t) => near.has(t.name));
}

/**
 * How many foreign keys each table has (to parents) and how many reference it
 * (from children), counted over the whole file, so a box in a focused picture
 * still tells how many lines it has outside it. Inline REFERENCES do not count:
 * MySQL creates no foreign key for them.
 */
export function degrees(tables: ViewTable[]): Map<string, { parents: number; children: number }> {
  const out = new Map(tables.map((t) => [t.name, { parents: 0, children: 0 }]));
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (fk.origin !== 'table') continue;
      const own = out.get(t.name);
      if (own) own.parents++;
      const parent = out.get(fk.refTable);
      if (parent) parent.children++;
    }
  }
  return out;
}

/**
 * Columns named like a reference that no foreign key MySQL creates uses:
 * drawn as a line to "?" (a missing foreign key, a polymorphic association, a
 * list of IDs). The same test as lint's id-column-without-fk, plus columns
 * whose REFERENCES MySQL ignores: they have no foreign key either. The table's
 * own key, named after the table (tenants.tenant_id), is no reference.
 */
export function danglingColumns(t: ViewTable): string[] {
  const used = new Set(
    t.foreignKeys
      .filter((fk) => fk.origin === 'table')
      .flatMap((fk) => fk.columns.map((c) => c.toLowerCase())),
  );
  return t.columns
    .filter(
      (c) =>
        looksLikeReference(c.name) &&
        !used.has(c.name.toLowerCase()) &&
        !(c.primaryKey && namedAfterOwnTable(t.name, c.name)),
    )
    .map((c) => c.name);
}

/**
 * The column most foreign keys carry (a tenant_id), as lint's
 * fk-without-shared-column finds it, with how many keys carry it, and the keys
 * (fkKey) that leave it out although both of their tables have it.
 */
export function sharedColumn(
  tables: ViewTable[],
): { column: string; carried: number; total: number; missing: Set<string> } | null {
  const real = tables.flatMap((t) =>
    t.foreignKeys.filter((fk) => fk.origin === 'table').map((fk) => ({ t, fk })),
  );
  const shared = sharedColumns(real.map((r) => ({ columns: r.fk.columns })));
  const count = (name: string) =>
    real.filter((r) => r.fk.columns.some((c) => c.toLowerCase() === name)).length;
  const name = [...shared].sort((a, b) => count(b) - count(a))[0];
  if (!name) return null;
  const has = (table: string) =>
    tables.find((t) => t.name === table)?.columns.some((c) => c.name.toLowerCase() === name) ??
    false;
  const missing = new Set(
    real
      .filter(
        (r) =>
          !r.fk.columns.some((c) => c.toLowerCase() === name) &&
          has(r.t.name) &&
          has(r.fk.refTable),
      )
      .map((r) => fkKey(r.t.name, r.fk.id)),
  );
  const declared = real.flatMap((r) => r.fk.columns).find((c) => c.toLowerCase() === name) ?? name;
  return { column: declared, carried: count(name), total: real.length, missing };
}

export interface StructureChecks {
  tables: number;
  /** Foreign keys MySQL creates: the lines. */
  relationships: number;
  /** Tables no foreign key joins to any other. */
  isolated: string[];
  /** Foreign keys that close a cycle of tables referencing each other: "child → parent". */
  cycles: string[];
  /** Columns named like a reference with no foreign key: "table.column". */
  dangling: string[];
  /** The column most foreign keys carry, and the keys leaving it out: "child (…) → parent (…)". */
  shared: { column: string; carried: number; total: number; missing: string[] } | null;
}

/** What the picture shows, as words: for the page's text and `dbdialog snapshot`. */
export function structureChecks(tables: ViewTable[]): StructureChecks {
  const joined = new Set<string>();
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (fk.origin !== 'table' || fk.refTable === t.name) continue;
      joined.add(t.name);
      joined.add(fk.refTable);
    }
  }
  const closers = cycleClosers(tables);
  const shared = sharedColumn(tables);
  return {
    tables: tables.length,
    relationships: tables.reduce(
      (n, t) => n + t.foreignKeys.filter((fk) => fk.origin === 'table').length,
      0,
    ),
    isolated: tables.filter((t) => !joined.has(t.name)).map((t) => t.name),
    cycles: tables.flatMap((t) =>
      t.foreignKeys
        .filter((fk) => closers.has(fkKey(t.name, fk.id)))
        .map((fk) => `${t.name} → ${fk.refTable}`),
    ),
    dangling: tables.flatMap((t) => danglingColumns(t).map((c) => `${t.name}.${c}`)),
    shared: shared && {
      column: shared.column,
      carried: shared.carried,
      total: shared.total,
      missing: tables.flatMap((t) =>
        t.foreignKeys
          .filter((fk) => shared.missing.has(fkKey(t.name, fk.id)))
          .map(
            (fk) =>
              `${t.name} (${fk.columns.join(', ')}) → ${fk.refTable} (${fk.refColumns.join(', ')})`,
          ),
      ),
    },
  };
}
