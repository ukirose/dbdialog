// Signs of the SQL antipatterns (Bill Karwin, "SQL Antipatterns") that the
// DDL alone can show: a column named like a reference with no foreign key
// (Keyless Entry, Polymorphic Associations, Jaywalking), a foreign key that
// leaves out the column the others carry (a tenant_id in a multi-tenant
// schema), money in an approximate type (Rounding Errors), and numbered
// columns (Multicolumn Attributes). They read names and types only, so the
// lint and the agent view share them; a name can mislead, so lint reports
// most of them as notes.

/** A name that reads as a reference to a row of another table: seller_id, sellerId, or a non-ASCII name ending in ID. */
export function looksLikeReference(name: string): boolean {
  return /_id$/i.test(name) || /[a-z0-9]Id$/.test(name) || /\P{ASCII}id$/iu.test(name);
}

/**
 * A column named after its own table (tenants.tenant_id, purchase_files.purchase_file_id).
 * In the primary key it is the table's own key, not a reference.
 */
export function namedAfterOwnTable(table: string, column: string): boolean {
  const base = column.replace(/_?id$/i, '').toLowerCase();
  const name = table.toLowerCase();
  return [
    name,
    name.replace(/ies$/, 'y'),
    name.replace(/(s|x|z|ch|sh)es$/, '$1'),
    name.replace(/s$/, ''),
  ].includes(base);
}

/**
 * Columns that most foreign keys carry: in at least half of them, and as one
 * of several columns in at least two (a tenant_id that every composite key
 * starts with). Lower-cased names.
 */
export function sharedColumns(fks: { columns: string[] }[]): Set<string> {
  const all = new Map<string, number>();
  const composite = new Map<string, number>();
  for (const fk of fks) {
    for (const name of new Set(fk.columns.map((c) => c.toLowerCase()))) {
      all.set(name, (all.get(name) ?? 0) + 1);
      if (fk.columns.length > 1) composite.set(name, (composite.get(name) ?? 0) + 1);
    }
  }
  return new Set(
    [...all]
      .filter(([name, n]) => n * 2 >= fks.length && (composite.get(name) ?? 0) >= 2)
      .map(([name]) => name),
  );
}

const MONEY =
  /amount|price|cost|total|fee|tax|balance|salary|payment|charge|money|金額|価格|単価|税額|料金|残高|合計|手数料|給与|代金|支払額|請求額/i;

/** A name that reads as money, in a type that stores approximate values (FLOAT, DOUBLE, REAL). */
export function approximateMoney(name: string, type: string): boolean {
  return MONEY.test(name) && /^(float|double|real)\b/i.test(type.trim());
}

/** Columns that differ only by a number at the end (tag1, tag2…): groups of two or more. */
export function numberedColumns(names: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const m = /^(.*\D)\d+$/.exec(name);
    if (!m?.[1]) continue;
    const base = m[1].toLowerCase();
    groups.set(base, [...(groups.get(base) ?? []), name]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}
