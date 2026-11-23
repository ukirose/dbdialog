import { describe, expect, it } from 'vitest';
import { parseSchema } from '../src/core/parser';
import { fixture, table } from './helpers';

const cols = (parts: { column: string | null }[]) => parts.map((p) => p.column);

describe('parseSchema on library.sql', () => {
  const src = fixture('library.sql');
  const schema = parseSchema(src);

  it('reads all seven tables without diagnostics', () => {
    expect(schema.tables.map((t) => t.name)).toEqual([
      'tenants',
      'members',
      'delivery_methods',
      'member_addresses',
      'loans',
      'loan_files',
      'member_codes',
    ]);
    expect(schema.diagnostics).toEqual([]);
  });

  it('reads composite foreign keys, unique keys and checks of loans', () => {
    const t = table(src, 'loans');
    expect(t.columns.map((c) => c.name)).toHaveLength(9);
    expect(cols(t.primaryKey?.columns.parts ?? [])).toEqual(['ID']);
    expect(t.keys.map((k) => [k.kind, cols(k.columns.parts)])).toEqual([
      ['unique', ['tenant_id', 'number']],
      ['unique', ['tenant_id', 'ID']],
    ]);
    expect(
      t.foreignKeys.map((f) => [
        cols(f.columns.parts),
        f.ref.table.name,
        cols(f.ref.columns?.parts ?? []),
      ]),
    ).toEqual([
      [['tenant_id', 'member_id'], 'members', ['tenant_id', 'ID']],
      [
        ['tenant_id', 'delivery_method_id', 'delivery_kind'],
        'delivery_methods',
        ['tenant_id', 'ID', 'kind'],
      ],
      [
        ['tenant_id', 'member_id', 'address_id'],
        'member_addresses',
        ['tenant_id', 'member_id', 'ID'],
      ],
    ]);
    expect(t.checks.map((c) => c.expr)).toEqual([
      "status IN ('new', 'active', 'closed')",
      'fee > 0',
      '(delivery_method_id IS NULL) = (delivery_kind IS NULL)',
      "address_id IS NULL OR delivery_kind = 'mail'",
    ]);
    const status = t.columns.find((c) => c.name === 'status');
    expect(status?.default?.text).toBe("'new'");
    expect(status?.nullable?.value).toBe(false);
    expect(status?.type.text).toBe('VARCHAR(6)');
  });

  it('reads the ON DELETE action and the generated column', () => {
    const files = table(src, 'loan_files');
    expect(files.foreignKeys[0]?.ref.onDelete).toBe('CASCADE');
    const codes = table(src, 'member_codes');
    const alive = codes.columns.find((c) => c.name === 'alive');
    expect(alive?.generated).toMatchObject({
      expr: 'IF(deleted_at IS NULL, 1, NULL)',
      storage: 'STORED',
      always: false,
    });
    expect(alive?.type.text).toBe('TINYINT');
  });

  it('records spans that point back at the source', () => {
    const t = table(src, 'loans');
    const amount = t.columns.find((c) => c.name === 'fee');
    expect(amount && src.slice(amount.span.start, amount.span.end)).toBe(
      'fee                DECIMAL(15,0) NULL',
    );
    expect(src.slice(t.nameIdent.span.start, t.nameIdent.span.end)).toBe('loans');
    expect(src[t.open]).toBe('(');
    expect(src[t.close]).toBe(')');
  });
});

describe('parseSchema on marketplace.sql (with comments)', () => {
  const src = fixture('marketplace.sql');
  const schema = parseSchema(src);

  it('reads six tables and keeps SET statements as other statements', () => {
    expect(schema.tables).toHaveLength(6);
    expect(schema.statements.filter((s) => s.kind === 'other').map((s) => s.head)).toEqual([
      'SET FOREIGN_KEY_CHECKS = 0',
      'SET FOREIGN_KEY_CHECKS = 1',
    ]);
    expect(schema.diagnostics).toEqual([]);
  });

  it('reads table and column comments', () => {
    const t = table(src, 'purchase_files');
    expect(t.comment?.value).toBe('Files of a purchase (receipts, photos; several per purchase)');
    expect(t.columns.find((c) => c.name === 's3_key')?.comment?.value).toBe('S3 object key');
    expect(t.options.map((o) => o.name)).toEqual(['ENGINE', 'CHARSET', 'COMMENT']);
  });

  it('reads a self-reference and named constraints', () => {
    const t = table(src, 'categories');
    const parent = t.foreignKeys.find((f) => f.constraintName?.name === 'fk_categories_parent');
    expect(parent?.ref.table.name).toBe('categories');
    expect(cols(parent?.columns.parts ?? [])).toEqual(['tenant_id', 'parent_id']);
  });

  it('reads VIRTUAL generated columns and CHECK names', () => {
    const t = table(src, 'purchases');
    expect(t.columns.find((c) => c.name === 'amount_excl_tax')?.generated?.storage).toBe('VIRTUAL');
    expect(t.checks.map((c) => c.constraintName?.name ?? null)).toEqual([
      'chk_purchases_status',
      'chk_purchases_amount',
      null,
    ]);
  });
});

describe('parseSchema on edge-cases.sql', () => {
  const src = fixture('edge-cases.sql');
  const schema = parseSchema(src);

  it('models only the tables it can draw', () => {
    expect(schema.tables.map((t) => t.name)).toEqual(['my table', 'other', 'broken', 'parts']);
    expect(schema.statements.map((s) => s.kind)).toEqual([
      'delimiter',
      'other',
      'delimiter',
      'create_table',
      'create_table',
      'other',
      'other',
      'other',
      'create_table',
      'create_table',
    ]);
  });

  it('reads lowercase keywords, quoting and inline attributes', () => {
    const t = table(src, 'my table');
    expect(t.ifNotExists).toBe(true);
    expect(t.columns.map((c) => c.name)).toEqual([
      'id',
      'order',
      'note',
      'ref_id',
      'email',
      'kind',
      'updated_at',
      'amount',
    ]);
    const id = t.columns[0];
    expect(id?.comment?.value).toBe('it\'s a "key" \\ path');
    expect(t.primaryKey).toMatchObject({ origin: 'column', column: 'id' });
    expect(t.columns.find((c) => c.name === 'order')?.default?.text).toBe('-1');
    expect(t.columns.find((c) => c.name === 'email')?.type.text).toBe(
      'varchar(255) character set utf8mb4',
    );
    expect(t.columns.find((c) => c.name === 'updated_at')?.onUpdate?.text).toBe(
      'on update current_timestamp(3)',
    );
    expect(t.keys.map((k) => [k.kind, k.indexName?.name ?? null, k.origin])).toEqual([
      ['unique', null, 'column'],
      ['index', 'idx_note', 'table'],
      ['index', null, 'table'],
    ]);
    expect(t.keys[2]?.columns.parts[0]?.expr).toBe('lower(email)');
    expect(t.checks.map((c) => [c.origin, c.expr, c.enforced])).toEqual([
      ['column', 'amount >= 0', null],
      ['table', "kind in ('a', 'b')", false],
    ]);
    expect(t.comment?.value).toBe('double-quoted comment');
  });

  it('keeps an inline REFERENCES as a foreign key that came from a column', () => {
    const t = table(src, 'my table');
    expect(t.foreignKeys).toHaveLength(1);
    expect(t.foreignKeys[0]).toMatchObject({ origin: 'column', column: 'ref_id' });
    expect(t.foreignKeys[0]?.ref.onDelete).toBe('CASCADE');
  });

  it('reports what it could not read and keeps going', () => {
    const broken = table(src, 'broken');
    expect(broken.hasErrors).toBe(true);
    expect(broken.defs.map((d) => d.kind)).toEqual(['column', 'unknown', 'column']);
    expect(broken.columns.map((c) => c.name)).toEqual(['a', 'c']);
    const codes = schema.diagnostics.map((d) => `${d.severity}:${d.code}:${d.table}`);
    expect(codes).toEqual([
      'info:statement-not-modeled:other',
      'info:statement-not-modeled:other',
      'info:table-not-modeled:copy_of_other',
      'error:parse-error:broken',
    ]);
  });

  it('keeps PARTITION BY as text after the options', () => {
    const t = table(src, 'parts');
    expect(t.tail && src.slice(t.tail.start, t.tail.end)).toMatch(/^PARTITION BY RANGE/);
  });
});
