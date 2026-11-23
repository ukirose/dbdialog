import { describe, expect, it } from 'vitest';
import type { Span } from '../src/core/model';
import { applyOp, applyOps, itemText, type Op, OpError } from '../src/core/ops';
import { parseSchema } from '../src/core/parser';
import { fixture, table } from './helpers';

/** The single region where two texts differ (common prefix and suffix removed). */
function changed(before: string, after: string): { before: string; after: string; at: number } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  )
    s++;
  return {
    before: before.slice(p, before.length - s),
    after: after.slice(p, after.length - s),
    at: p,
  };
}

/** Every CREATE TABLE not in `touched` must be byte-identical. */
function expectOthersUntouched(before: string, after: string, touched: string[]): void {
  const b = parseSchema(before);
  const a = parseSchema(after);
  for (const t of b.tables) {
    if (touched.includes(t.name)) continue;
    const u = a.tables.find((x) => x.name === t.name);
    expect(u, `table ${t.name} is gone`).toBeDefined();
    if (!u) continue;
    expect(after.slice(u.stmt.start, u.stmt.end)).toBe(before.slice(t.stmt.start, t.stmt.end));
  }
  expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
}

const ref = (
  src: string,
  tableName: string,
  kind: 'keys' | 'foreignKeys' | 'checks',
  i: number,
) => {
  const item = table(src, tableName)[kind][i];
  if (!item) throw new Error(`no ${kind}[${i}] in ${tableName}`);
  return { id: item.id, text: itemText(src, item) };
};

describe('minimal rewrites on library.sql (golden)', () => {
  const src = fixture('library.sql');

  it('adds a COMMENT to a column and changes nothing else', () => {
    const out = applyOp(src, {
      op: 'column.update',
      table: 'loans',
      column: 'status',
      set: { comment: 'How far it has gone' },
      expect: { comment: null },
    });
    expect(changed(src, out)).toMatchObject({
      before: '',
      after: " COMMENT 'How far it has gone'",
    });
    expect(out).toContain(
      "status             VARCHAR(6) NOT NULL DEFAULT 'new' COMMENT 'How far it has gone',",
    );
    expectOthersUntouched(src, out, ['loans']);
  });

  it('adds a column aligned like its neighbors (East Asian characters count two)', () => {
    const jp = fixture('japanese.sql');
    const out = applyOp(jp, {
      op: 'column.add',
      table: '作品',
      after: '題名',
      column: { name: '副題', type: 'VARCHAR(200)', nullable: true, comment: '副題' },
    });
    // The whole file equals the original with exactly one line inserted: 副題 is
    // four columns wide, so three spaces line its type up with 作家ID (six) + one.
    expect(out).toBe(
      jp.replace(
        '  題名   VARCHAR(200) NOT NULL,\n',
        "  題名   VARCHAR(200) NOT NULL,\n  副題   VARCHAR(200) NULL COMMENT '副題',\n",
      ),
    );
    expectOthersUntouched(jp, out, ['作品']);
  });

  it('renames a column everywhere it is used, keeping the alignment', () => {
    const out = applyOp(src, {
      op: 'column.update',
      table: 'members',
      column: 'ID',
      set: { name: 'member_number' },
    });
    const t = table(out, 'members');
    expect(t.columns.map((c) => c.name)).toEqual(['member_number', 'tenant_id', 'name']);
    expect(out).toContain('  member_number BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,');
    expect(out).toContain('  PRIMARY KEY (member_number),');
    expect(out).toContain('  UNIQUE KEY (tenant_id, member_number),');
    // Foreign keys in other tables follow the new name; nothing else in them changes.
    expect(out).toContain(
      'FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, member_number)',
    );
    expect(out).toContain(
      'FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, member_number)\n);',
    );
    expectOthersUntouched(src, out, ['members', 'member_addresses', 'loans']);
  });

  it('adds a composite foreign key as one new line', () => {
    const out = applyOp(src, {
      op: 'fk.add',
      table: 'loan_files',
      fk: {
        columns: ['tenant_id'],
        refTable: 'tenants',
        refColumns: ['ID'],
        onDelete: 'RESTRICT',
      },
    });
    expect(changed(src, out)).toMatchObject({
      before: '',
      after: ',\n  FOREIGN KEY (tenant_id) REFERENCES tenants (ID) ON DELETE RESTRICT',
    });
    expectOthersUntouched(src, out, ['loan_files']);
  });

  it('removes a CHECK with its line and comma only', () => {
    const out = applyOp(src, {
      op: 'check.delete',
      table: 'loans',
      target: ref(src, 'loans', 'checks', 1),
    });
    expect(out).toBe(src.replace('  CHECK (fee > 0),\n', ''));
    expectOthersUntouched(src, out, ['loans']);
  });

  it('edits a CHECK expression inside its parentheses', () => {
    const out = applyOp(src, {
      op: 'check.update',
      table: 'loans',
      target: ref(src, 'loans', 'checks', 1),
      expr: 'fee >= 1',
    });
    expect(out).toBe(src.replace('CHECK (fee > 0)', 'CHECK (fee >= 1)'));
  });

  it('changes a generated column from STORED to VIRTUAL by one word', () => {
    const out = applyOp(src, {
      op: 'column.update',
      table: 'member_codes',
      column: 'alive',
      set: { generated: { expr: 'IF(deleted_at IS NULL, 1, NULL)', storage: 'VIRTUAL' } },
    });
    expect(changed(src, out)).toMatchObject({ before: 'STORED', after: 'VIRTUAL' });
  });

  it('removes the last definition and the comma before it', () => {
    const out = applyOp(src, {
      op: 'key.delete',
      table: 'member_codes',
      target: ref(src, 'member_codes', 'keys', 0),
    });
    expect(out).toContain('  PRIMARY KEY (ID)\n);\n');
    expectOthersUntouched(src, out, ['member_codes']);
  });
});

describe('edits come back to the original text when undone', () => {
  const sources = { part3: fixture('library.sql'), purchase: fixture('marketplace.sql') };

  const pairs: [keyof typeof sources, (s: string) => Op, (s: string, after: string) => Op][] = [
    [
      'purchase',
      () => ({
        op: 'column.update',
        table: 'purchases',
        column: 'status',
        set: { comment: 'status' },
      }),
      () => ({
        op: 'column.update',
        table: 'purchases',
        column: 'status',
        set: { comment: 'Status' },
      }),
    ],
    [
      'purchase',
      () => ({
        op: 'column.update',
        table: 'purchases',
        column: 'amount',
        set: { nullable: false, default: '0' },
      }),
      () => ({
        op: 'column.update',
        table: 'purchases',
        column: 'amount',
        set: { nullable: true, default: null },
      }),
    ],
    [
      'purchase',
      () => ({
        op: 'column.add',
        table: 'sellers',
        after: 'name',
        column: { name: 'kana', type: 'VARCHAR(100)', nullable: true },
      }),
      () => ({ op: 'column.delete', table: 'sellers', column: 'kana' }),
    ],
    [
      'purchase',
      () => ({
        op: 'fk.add',
        table: 'purchase_files',
        fk: { name: 'fk_x', columns: ['tenant_id'], refTable: 'tenants', refColumns: ['id'] },
      }),
      (_s, after) => ({
        op: 'fk.delete',
        table: 'purchase_files',
        target: ref(after, 'purchase_files', 'foreignKeys', 1),
      }),
    ],
    [
      'purchase',
      () => ({
        op: 'fk.update',
        table: 'purchases',
        target: ref(sources.purchase, 'purchases', 'foreignKeys', 0),
        fk: { onDelete: 'CASCADE' },
      }),
      (_s, after) => ({
        op: 'fk.update',
        table: 'purchases',
        target: ref(after, 'purchases', 'foreignKeys', 0),
        fk: { onDelete: null },
      }),
    ],
    [
      'purchase',
      () => ({
        op: 'check.add',
        table: 'purchase_files',
        expr: 'sort_order >= 1',
        name: 'chk_sort',
      }),
      (_s, after) => ({
        op: 'check.delete',
        table: 'purchase_files',
        target: ref(after, 'purchase_files', 'checks', 0),
      }),
    ],
    [
      'purchase',
      () => ({
        op: 'key.add',
        table: 'tenants',
        kind: 'unique',
        columns: ['name'],
        name: 'uq_tenants_name',
      }),
      (_s, after) => ({
        op: 'key.delete',
        table: 'tenants',
        target: ref(after, 'tenants', 'keys', 0),
      }),
    ],
    [
      'purchase',
      () => ({
        op: 'table.add',
        name: 'refunds',
        comment: 'fines',
        columns: [{ name: 'id', type: 'BIGINT UNSIGNED', nullable: false, autoIncrement: true }],
        primaryKey: ['id'],
      }),
      () => ({ op: 'table.delete', table: 'refunds' }),
    ],
    [
      'purchase',
      () => ({ op: 'table.rename', table: 'sellers', to: 'suppliers' }),
      () => ({ op: 'table.rename', table: 'suppliers', to: 'sellers' }),
    ],
    [
      'purchase',
      () => ({ op: 'table.setComment', table: 'shipments', comment: null }),
      () => ({ op: 'table.setComment', table: 'shipments', comment: 'Shipments' }),
    ],
    [
      'part3',
      () => ({
        op: 'column.update',
        table: 'loans',
        column: 'delivery_kind',
        set: { name: 'kind' },
      }),
      () => ({
        op: 'column.update',
        table: 'loans',
        column: 'kind',
        set: { name: 'delivery_kind' },
      }),
    ],
    [
      'part3',
      () => ({
        op: 'column.update',
        table: 'loans',
        column: 'number',
        set: { type: 'BIGINT UNSIGNED' },
      }),
      () => ({
        op: 'column.update',
        table: 'loans',
        column: 'number',
        set: { type: 'INT UNSIGNED' },
      }),
    ],
  ];

  it.each(pairs.map((p, i) => [i, ...p] as const))('pair %i on %s', (_i, name, doOp, undoOp) => {
    const src = sources[name];
    const after = applyOp(src, doOp(src));
    expect(after).not.toBe(src);
    expect(parseSchema(after).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(applyOp(after, undoOp(src, after))).toBe(src);
  });
});

describe('converting what MySQL 8.0 would ignore', () => {
  it('turns an inline REFERENCES into a table-level FOREIGN KEY with the same clause', () => {
    const src =
      'CREATE TABLE p (id INT PRIMARY KEY);\nCREATE TABLE c (\n  id INT,\n  p_id INT REFERENCES p (id) ON DELETE CASCADE,\n  PRIMARY KEY (id)\n);\n';
    const t = table(src, 'c');
    const out = applyOp(src, {
      op: 'fk.makeTableLevel',
      table: 'c',
      target: { id: t.foreignKeys[0]?.id ?? '', text: itemText(src, t.foreignKeys[0] as never) },
    });
    expect(out).toBe(
      'CREATE TABLE p (id INT PRIMARY KEY);\nCREATE TABLE c (\n  id INT,\n  p_id INT,\n  PRIMARY KEY (id),\n  FOREIGN KEY (p_id) REFERENCES p (id) ON DELETE CASCADE\n);\n',
    );
    expect(table(out, 'c').foreignKeys[0]?.origin).toBe('table');
  });

  it('turns an inline UNIQUE into a table-level key when its columns change', () => {
    const src = 'CREATE TABLE t (\n  a INT UNIQUE,\n  b INT\n);\n';
    const k = table(src, 't').keys[0];
    const out = applyOp(src, {
      op: 'key.update',
      table: 't',
      target: { id: k?.id ?? '', text: itemText(src, k as never) },
      columns: ['a', 'b'],
    });
    expect(out).toBe('CREATE TABLE t (\n  a INT,\n  b INT,\n  UNIQUE KEY (a, b)\n);\n');
  });
});

describe('a session of edits on marketplace.sql touches only the edited tables', () => {
  it('keeps every other CREATE TABLE byte for byte after each step', () => {
    let src = fixture('marketplace.sql');
    const steps: [Op, string[]][] = [
      [{ op: 'table.setComment', table: 'tenants', comment: 'tenants' }, ['tenants']],
      [
        {
          op: 'column.update',
          table: 'sellers',
          column: 'code',
          set: { type: 'VARCHAR(32)', comment: 'Seller code (internal)' },
        },
        ['sellers'],
      ],
      [
        {
          op: 'column.add',
          table: 'purchases',
          column: { name: 'due_date', type: 'DATE', nullable: true, comment: 'Due date' },
        },
        ['purchases'],
      ],
      [
        { op: 'check.add', table: 'purchases', expr: "status <> 'closed' OR amount IS NOT NULL" },
        ['purchases'],
      ],
      [
        {
          op: 'column.update',
          table: 'categories',
          column: 'parent_id',
          set: { name: 'parent_category_id' },
        },
        ['categories'],
      ],
      [
        {
          op: 'fk.add',
          table: 'purchase_files',
          fk: { columns: ['tenant_id'], refTable: 'tenants', refColumns: ['id'] },
        },
        ['purchase_files'],
      ],
      [
        {
          op: 'column.update',
          table: 'purchases',
          column: 'amount_excl_tax',
          set: { generated: { expr: 'amount - IFNULL(tax_amount, 0)', storage: 'STORED' } },
        },
        ['purchases'],
      ],
      [{ op: 'key.setPrimary', table: 'shipments', columns: ['id'] }, []],
    ];
    for (const [op, touched] of steps) {
      const next = applyOp(src, op);
      expectOthersUntouched(src, next, touched);
      src = next;
    }
    const p = table(src, 'purchases');
    expect(p.columns.find((c) => c.name === 'due_date')?.comment?.value).toBe('Due date');
    expect(p.columns.find((c) => c.name === 'amount_excl_tax')?.generated).toMatchObject({
      storage: 'STORED',
    });
    const cat = table(src, 'categories');
    expect(cat.foreignKeys[0]?.columns.parts.map((p) => p.column)).toEqual([
      'tenant_id',
      'parent_category_id',
    ]);
  });
});

describe('refusals', () => {
  const src = fixture('marketplace.sql');

  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof OpError) return e.code;
      throw e;
    }
    return null;
  };

  it('reports a conflict when the file changed after the diagram showed it', () => {
    expect(
      code(() =>
        applyOp(src, {
          op: 'column.update',
          table: 'purchases',
          column: 'status',
          set: { comment: 'x' },
          expect: { comment: 'Old value' },
        }),
      ),
    ).toBe('conflict');
    expect(
      code(() =>
        applyOp(src, {
          op: 'check.delete',
          table: 'purchases',
          target: { id: 'check:0', text: 'CHECK (gone)' },
        }),
      ),
    ).toBe('conflict');
  });

  it('refuses to delete what others still reference, unless asked to cascade', () => {
    expect(code(() => applyOp(src, { op: 'table.delete', table: 'sellers' }))).toBe('referenced');
    const out = applyOp(src, { op: 'table.delete', table: 'sellers', cascade: true });
    expect(parseSchema(out).tables.map((t) => t.name)).not.toContain('sellers');
    expect(out).not.toContain('fk_purchases_seller');
    expectOthersUntouched(src, out, ['sellers', 'purchases']);
    expect(
      code(() => applyOp(src, { op: 'column.delete', table: 'sellers', column: 'deleted_at' })),
    ).toBe('referenced');
  });

  it('rejects SQL fragments that would leak out of their clause', () => {
    expect(
      code(() =>
        applyOp(src, {
          op: 'column.update',
          table: 'tenants',
          column: 'name',
          set: { type: 'TEXT); DROP TABLE x; --' },
        }),
      ),
    ).toBe('invalid');
    expect(
      code(() => applyOp(src, { op: 'check.add', table: 'tenants', expr: "name <> ''' " })),
    ).toBe('invalid');
    expect(
      code(() =>
        applyOp(src, {
          op: 'column.update',
          table: 'tenants',
          column: 'name',
          set: { default: "'a', b INT" },
        }),
      ),
    ).toBe('invalid');
  });

  it('quotes names that need it and escapes comments', () => {
    const out = applyOps(src, [
      {
        op: 'column.add',
        table: 'tenants',
        column: { name: 'order', type: 'INT', comment: "it's \\ ok" },
      },
      { op: 'column.add', table: 'tenants', column: { name: 'my note', type: 'VARCHAR(10)' } },
    ]);
    expect(out).toContain("`order`    INT COMMENT 'it''s \\\\ ok'");
    // Two spaces: the types of this table start at the same column.
    expect(out).toContain('`my note`  VARCHAR(10)');
    const t = table(out, 'tenants');
    expect(t.columns.find((c) => c.name === 'order')?.comment?.value).toBe("it's \\ ok");
  });

  it('reports unknown tables and columns', () => {
    expect(code(() => applyOp(src, { op: 'column.delete', table: 'nope', column: 'x' }))).toBe(
      'not-found',
    );
    expect(
      code(() =>
        applyOp(src, {
          op: 'fk.add',
          table: 'purchases',
          fk: { columns: ['seller_id'], refTable: 'sellers', refColumns: ['nope'] },
        }),
      ),
    ).toBe('not-found');
  });
});

it('changes only the span of the edited item (span check on every column comment)', () => {
  const src = fixture('marketplace.sql');
  for (const t of parseSchema(src).tables) {
    for (const c of t.columns) {
      const out = applyOp(src, {
        op: 'column.update',
        table: t.name,
        column: c.name,
        set: { comment: `${c.comment?.value ?? ''}!` },
      });
      const d = changed(src, out);
      const s: Span = c.span;
      expect(d.at).toBeGreaterThanOrEqual(s.start);
      expect(d.at + d.before.length).toBeLessThanOrEqual(s.end);
    }
  }
});
