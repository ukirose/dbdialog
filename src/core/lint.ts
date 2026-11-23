// Warnings about things MySQL 8.0 accepts but that are probably not what the
// author meant, references that point nowhere, and signs of SQL antipatterns.

import { isTrivia, lex } from './lexer';
import type { ColumnDef, Diagnostic, ForeignKeyDef, Schema, TableDef } from './model';
import {
  approximateMoney,
  looksLikeReference,
  namedAfterOwnTable,
  numberedColumns,
  sharedColumns,
} from './smells';
import { unquoteIdent } from './sqltext';
import { fkMismatch } from './types';

const lower = (s: string) => s.toLowerCase();
/** U+3000 IDEOGRAPHIC SPACE: MySQL accepts it inside unquoted names. */
const FULLWIDTH_SPACE = String.fromCharCode(0x3000);

export function lint(schema: Schema): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tables = new Map<string, TableDef>();

  for (const t of schema.tables) {
    if (tables.has(lower(t.name))) {
      out.push({
        severity: 'error',
        code: 'duplicate-table',
        params: { table: t.name },
        span: t.nameIdent.span,
        table: t.name,
      });
    } else {
      tables.set(lower(t.name), t);
    }
  }

  for (const t of schema.tables) {
    const columns = new Set<string>();
    if (t.name.includes(FULLWIDTH_SPACE)) {
      out.push({
        severity: 'warning',
        code: 'fullwidth-space-in-name',
        params: { name: t.name },
        span: t.nameIdent.span,
        table: t.name,
      });
    }
    for (const c of t.columns) {
      if (columns.has(lower(c.name))) {
        out.push({
          severity: 'error',
          code: 'duplicate-column',
          params: { table: t.name, column: c.name },
          span: c.nameIdent.span,
          table: t.name,
        });
      }
      columns.add(lower(c.name));
      // MySQL lets U+3000 (the ideographic space of CJK text) into unquoted names, so a
      // name, that space and a type silently become one name.
      if (c.name.includes(FULLWIDTH_SPACE)) {
        out.push({
          severity: 'warning',
          code: 'fullwidth-space-in-name',
          params: { name: c.name },
          span: c.nameIdent.span,
          table: t.name,
        });
      }
    }

    for (const k of [...(t.primaryKey ? [t.primaryKey] : []), ...t.keys]) {
      for (const p of k.columns.parts) {
        if (p.column && !columns.has(lower(p.column))) {
          out.push({
            severity: 'error',
            code: 'unknown-column',
            params: { table: t.name, column: p.column },
            span: p.span,
            table: t.name,
          });
        }
      }
    }

    for (const fk of t.foreignKeys) {
      if (fk.origin === 'column') {
        out.push({
          severity: 'warning',
          code: 'inline-references-ignored',
          params: { table: t.name, column: fk.column ?? '' },
          span: fk.ref.span,
          table: t.name,
        });
      }
      for (const p of fk.columns.parts) {
        if (p.column && !columns.has(lower(p.column))) {
          out.push({
            severity: 'error',
            code: 'unknown-column',
            params: { table: t.name, column: p.column },
            span: p.span,
            table: t.name,
          });
        }
      }
      const parent = fk.ref.qualifier ? null : tables.get(lower(fk.ref.table.name));
      // An inline REFERENCES creates no foreign key, so MySQL's rules do not apply to it.
      if (fk.origin === 'table') out.push(...fkColumnRules(schema, t, fk, parent ?? null));
      if (!parent) {
        if (!fk.ref.qualifier) {
          out.push({
            severity: 'warning',
            code: 'fk-unknown-table',
            params: { table: t.name, refTable: fk.ref.table.name },
            span: fk.ref.table.span,
            table: t.name,
          });
        }
        continue;
      }
      const refParts = fk.ref.columns?.parts ?? [];
      if (refParts.length !== fk.columns.parts.length) {
        out.push({
          severity: 'error',
          code: 'fk-column-count',
          params: { table: t.name, columns: fk.columns.parts.length, refColumns: refParts.length },
          span: fk.span,
          table: t.name,
        });
      }
      let unknown = false;
      for (const p of refParts) {
        if (p.column && !parent.columns.some((c) => lower(c.name) === lower(p.column as string))) {
          unknown = true;
          out.push({
            severity: 'error',
            code: 'fk-unknown-column',
            params: { table: t.name, refTable: parent.name, column: p.column },
            span: p.span,
            table: t.name,
          });
        }
      }
      // An inline REFERENCES creates nothing, and a missing column is reported above.
      if (fk.origin === 'table' && !unknown) out.push(...fkTargetIndex(t, fk, parent));
    }
  }
  out.push(...smells(schema, tables));
  return out;
}

const fkColumns = (fk: ForeignKeyDef): string[] =>
  fk.columns.parts.flatMap((p) => (p.column ? [p.column] : []));

/**
 * Signs of SQL antipatterns read from names and types (smells.ts). A name can
 * mislead (an external_id from another system, address1 and address2), so
 * those are notes; money in FLOAT and a foreign key that lets a row point
 * into another tenant are warnings.
 */
function smells(schema: Schema, tables: Map<string, TableDef>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const real = schema.tables.flatMap((t) =>
    t.foreignKeys.filter((fk) => fk.origin === 'table').map((fk) => ({ t, fk })),
  );
  for (const t of schema.tables) {
    const inFk = new Set(real.filter((r) => r.t === t).flatMap((r) => fkColumns(r.fk).map(lower)));
    // The table's own key (tenants.tenant_id) is named like a reference but is none.
    const ownKey = new Set(
      (t.primaryKey?.columns.parts ?? []).flatMap((p) =>
        p.column && namedAfterOwnTable(t.name, p.column) ? [lower(p.column)] : [],
      ),
    );
    for (const c of t.columns) {
      // A REFERENCES inside the column creates no foreign key either; it has its own warning.
      if (
        looksLikeReference(c.name) &&
        !inFk.has(lower(c.name)) &&
        !ownKey.has(lower(c.name)) &&
        !c.references
      ) {
        out.push({
          severity: 'info',
          code: 'id-column-without-fk',
          params: { table: t.name, column: c.name },
          span: c.nameIdent.span,
          table: t.name,
        });
      }
      if (approximateMoney(c.name, c.type.text)) {
        out.push({
          severity: 'warning',
          code: 'approximate-number-for-money',
          params: { table: t.name, column: c.name, type: c.type.text },
          span: c.type.span,
          table: t.name,
        });
      }
    }
    for (const group of numberedColumns(t.columns.map((c) => c.name))) {
      out.push({
        severity: 'info',
        code: 'numbered-columns',
        params: { table: t.name, columns: group.join(', ') },
        span: t.nameIdent.span,
        table: t.name,
      });
    }
  }
  // A foreign key between two tables that both have the column most keys carry,
  // which leaves it out: a row can point at a row with another value of it.
  const shared = sharedColumns(real.map((r) => ({ columns: fkColumns(r.fk) })));
  const named = (t: TableDef, name: string) => t.columns.find((c) => lower(c.name) === name);
  for (const { t, fk } of real) {
    const parent = fk.ref.qualifier ? null : tables.get(lower(fk.ref.table.name));
    if (!parent) continue;
    const own = new Set(fkColumns(fk).map(lower));
    for (const name of shared) {
      const column = named(t, name);
      if (own.has(name) || !column || !named(parent, name)) continue;
      out.push({
        severity: 'warning',
        code: 'fk-without-shared-column',
        params: { table: t.name, refTable: parent.name, column: column.name },
        span: fk.span,
        table: t.name,
      });
    }
  }
  return out;
}

/**
 * MySQL can create a foreign key only when the referenced table (`parent`)
 * has a suitable index on the referenced columns. Returns one
 * 'fk-target-not-indexed' warning when it has none, otherwise [].
 */
function fkTargetIndex(t: TableDef, fk: ForeignKeyDef, parent: TableDef): Diagnostic[] {
  const refColumns = (fk.ref.columns?.parts ?? []).map((p) => lower(p.column ?? ''));
  const keys = [...(parent.primaryKey ? [parent.primaryKey] : []), ...parent.keys];
  const warning: Diagnostic = {
    severity: 'warning',
    code: 'fk-target-not-indexed',
    params: { table: t.name, refTable: parent.name, columns: refColumns.join(', ') },
    span: fk.ref.span,
    table: t.name,
  };
  // An index whose first columns are the referenced ones, in the same order,
  // none of them with a prefix length. Unique or not, ascending or not; FULLTEXT
  // and SPATIAL do not count. Each case checked against MySQL 8.0.46 (error 1822).
  const usable = keys.some(
    (k) =>
      k.kind !== 'fulltext' &&
      k.kind !== 'spatial' &&
      refColumns.every((name, i) => {
        const part = k.columns.parts[i];
        return part?.column != null && part.length === null && lower(part.column) === name;
      }),
  );
  return usable ? [] : [warning];
}

const findColumn = (t: TableDef, name: string | null): ColumnDef | undefined =>
  name === null ? undefined : t.columns.find((c) => lower(c.name) === lower(name));

/** Whether a generated column's expression uses `column`. */
function usesColumn(schema: Schema, generated: ColumnDef, column: string): boolean {
  const g = generated.generated;
  if (!g) return false;
  const toks = lex(schema.source, g.exprSpan.start, g.exprSpan.end).filter((x) => !isTrivia(x));
  return toks.some(
    (x, i) =>
      (x.kind === 'ident' || x.kind === 'qident') &&
      lower(unquoteIdent(x.text)) === lower(column) &&
      toks[i + 1]?.text !== '(',
  );
}

/**
 * MySQL's own limits on the columns of a foreign key, each one checked
 * against MySQL 8.0.46 (scripts/verify-mysql.ts runs the same cases).
 */
function fkColumnRules(
  schema: Schema,
  t: TableDef,
  fk: ForeignKeyDef,
  parent: TableDef | null,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (code: string, params: Record<string, string>) =>
    out.push({
      severity: 'error',
      code,
      params: { table: t.name, ...params },
      span: fk.span,
      table: t.name,
    });
  const refParts = fk.ref.columns?.parts ?? [];
  const onDelete = fk.ref.onDelete;
  const onUpdate = fk.ref.onUpdate;

  fk.columns.parts.forEach((part, i) => {
    const col = findColumn(t, part.column);
    if (!col) return;
    const refCol = parent ? findColumn(parent, refParts[i]?.column ?? null) : undefined;
    // Error 3733: a VIRTUAL generated column cannot be part of a foreign key, on either side.
    for (const [c, owner] of [
      [col, t],
      [refCol, parent],
    ] as const) {
      if (c?.generated && c.generated.storage !== 'STORED') {
        push('fk-virtual-column', { column: `${owner?.name}.${c.name}` });
      }
    }
    // Error 3104: a STORED generated column cannot take actions that would rewrite it.
    if (col.generated?.storage === 'STORED') {
      const bad =
        onDelete === 'SET NULL' || onDelete === 'SET DEFAULT'
          ? `ON DELETE ${onDelete}`
          : onUpdate && onUpdate !== 'RESTRICT' && onUpdate !== 'NO ACTION'
            ? `ON UPDATE ${onUpdate}`
            : null;
      if (bad) push('fk-generated-action', { column: col.name, action: bad });
    }
    // Error 1215: a column that a STORED generated column is computed from cannot cascade either.
    const user = t.columns.find(
      (g) => g !== col && g.generated?.storage === 'STORED' && usesColumn(schema, g, col.name),
    );
    const cascading = [
      onDelete && onDelete !== 'RESTRICT' && onDelete !== 'NO ACTION'
        ? `ON DELETE ${onDelete}`
        : null,
      onUpdate && onUpdate !== 'RESTRICT' && onUpdate !== 'NO ACTION'
        ? `ON UPDATE ${onUpdate}`
        : null,
    ].find((x) => x !== null);
    if (user && cascading)
      push('fk-generated-base-action', {
        column: col.name,
        generated: user.name,
        action: cascading,
      });
    // Error 3780 (and 1170 for TEXT/BLOB): the two columns must be compatible.
    if (parent && refCol) {
      const m = fkMismatch(schema, { table: t, column: col }, { table: parent, column: refCol });
      if (m) {
        push(m.reason === 'blob' ? 'fk-blob-column' : 'fk-type-mismatch', {
          column: col.name,
          type: col.type.text,
          refTable: parent.name,
          refColumn: refCol.name,
          refType: refCol.type.text,
          reason: m.reason,
          detail: m.detail,
        });
      }
    }
  });
  return out;
}
