import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSchema } from '../src/core/parser';
import { toView } from '../src/core/view';
import { LayoutStore } from '../src/server/layout';
import { labelPoint, pathMidpoint, visiblePoint } from '../src/web/diagram/pathMid';
import { inferForeignKey } from '../src/web/fkInference';
import { highlightSql } from '../src/web/sqlHighlight';
import { fixture } from './helpers';

const view = (sql: string) => toView(parseSchema(sql), 'schema.sql', 1).tables;

describe('a line drawn between two columns', () => {
  const memo = `
CREATE TABLE loan_notes (
  ID         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  loan_id   BIGINT UNSIGNED NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (ID)
);
CREATE TABLE cats (id INT PRIMARY KEY, tenant_id INT NOT NULL, parent_id INT, UNIQUE KEY (tenant_id, id));
`;
  const tables = view(fixture('library.sql') + memo);
  const infer = (from: string, to: string, single = false) => {
    const [ft, fc] = from.split('.') as [string, string];
    const [tt, tc] = to.split('.') as [string, string];
    return inferForeignKey(tables, { table: ft, column: fc }, { table: tt, column: tc }, single);
  };

  it('completes a key of several columns from columns of the same names', () => {
    expect(infer('loan_notes.loan_id', 'loans.ID')).toEqual({
      ok: true,
      table: 'loan_notes',
      fk: {
        name: null,
        columns: ['tenant_id', 'loan_id'],
        refTable: 'loans',
        refColumns: ['tenant_id', 'ID'],
        onDelete: null,
        onUpdate: null,
      },
    });
  });

  it('uses the one column only when asked (Alt)', () => {
    const r = infer('loan_notes.loan_id', 'loans.ID', true);
    expect(r.ok && [r.fk.columns, r.fk.refColumns]).toEqual([['loan_id'], ['ID']]);
  });

  it('points from the column that is not a key to the one that is, whichever way it is drawn', () => {
    const forward = infer('loan_notes.loan_id', 'loans.ID');
    const backward = infer('loans.ID', 'loan_notes.loan_id');
    expect(backward).toEqual(forward);
  });

  it('does not take a column of a larger key for a key of its own', () => {
    // tenant_id of member_codes is only part of UNIQUE (tenant_id, code, alive).
    const r = infer('tenants.ID', 'member_codes.tenant_id');
    expect(r.ok && [r.table, r.fk.refTable, r.fk.refColumns]).toEqual([
      'member_codes',
      'tenants',
      ['ID'],
    ]);
  });

  it('works within one table (a key to its own table)', () => {
    const r = infer('cats.parent_id', 'cats.id');
    expect(r.ok && [r.table, r.fk.columns, r.fk.refColumns]).toEqual([
      'cats',
      ['tenant_id', 'parent_id'],
      ['tenant_id', 'id'],
    ]);
  });

  it('says so when the foreign key is already there', () => {
    expect(infer('loan_files.loan_id', 'loans.ID')).toEqual({ ok: false, reason: 'exists' });
  });

  it('ignores a line from a column to itself', () => {
    expect(infer('cats.id', 'cats.id')).toEqual({ ok: false, reason: 'same-column' });
  });
});

describe('CHECK constraints', () => {
  it('know which columns they mention, in the order of the table', () => {
    const purchase = view(fixture('library.sql')).find((x) => x.name === 'loans');
    expect(purchase?.checks.map((c) => c.columns)).toEqual([
      ['status'],
      ['fee'],
      ['delivery_method_id', 'delivery_kind'],
      ['delivery_kind', 'address_id'],
    ]);
  });
});

describe('SQL colors', () => {
  it('cut the text into runs that join back to it exactly', () => {
    const sql = fixture('library.sql');
    expect(
      highlightSql(sql)
        .map((r) => r.text)
        .join(''),
    ).toBe(sql);
  });

  it('tell keywords, types, strings and comments apart', () => {
    const runs = highlightSql("-- note\nCREATE TABLE t (s VARCHAR(3) DEFAULT 'new')");
    const cls = (text: string) => runs.find((r) => r.text.includes(text))?.cls;
    expect([cls('-- note'), cls('CREATE'), cls('VARCHAR'), cls("'new'")]).toEqual([
      'comment',
      'keyword',
      'type',
      'string',
    ]);
  });
});

describe('the arrow on a line', () => {
  it('sits halfway along it, pointing the way it runs', () => {
    expect(pathMidpoint('M 0,0 L 100,0')).toEqual({ x: 50, y: 0, angle: 0 });
    const down = pathMidpoint('M 0,0L 0,40Q 0,50 10,50L 100,50');
    expect(down?.angle).toBe(0);
    const up = pathMidpoint('M 0 100 L 0 0');
    expect(up).toEqual({ x: 0, y: 50, angle: -90 });
  });

  it('moves to the nearest part of the line no box covers', () => {
    expect(visiblePoint('M 0,0 L 100,0', [])).toEqual({ x: 50, y: 0, angle: 0 });
    // A box over the middle (30–70, with 6 px kept clear): the nearest free point is x = 22.
    const box = { x: 30, y: -10, width: 40, height: 20 };
    expect(visiblePoint('M 0,0 L 100,0', [box])).toEqual({ x: 22, y: 0, angle: 0 });
  });
});

describe('the label of a line', () => {
  const half = { x: 40, y: 10 };

  it('goes where all of it is clear of the boxes, nearest the middle', () => {
    const box = { x: 100, y: -10, width: 50, height: 20 };
    // 80 wide: its center at x ≤ 60 or x ≥ 190; from the middle (150), 190 comes first.
    expect(labelPoint('M 0,0 L 300,0', [box], half)?.x).toBe(190);
  });

  it('covers as little of the boxes as it can when it cannot be clear', () => {
    // A gap of 60 between two boxes is too narrow for 80: at 170 it overlaps the left box by 20 only.
    const left = { x: 0, y: -10, width: 150, height: 20 };
    const right = { x: 210, y: -10, width: 90, height: 20 };
    expect(labelPoint('M 0,0 L 300,0', [left, right], half)?.x).toBe(170);
  });
});

describe('box widths in the layout file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbdialog-layout-'));
  const path = join(dir, 'schema.sql.layout.json');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('are kept when a box moves, and removed with 0', () => {
    const store = new LayoutStore(path);
    store.update({ t: { x: 1, y: 2, w: 333.4 } }, null);
    store.update({ t: { x: 5, y: 6 } }, null);
    expect(store.get().tables.t).toEqual({ x: 5, y: 6, w: 333 });
    store.update({ t: { x: 5, y: 6, w: 0 } }, null);
    expect(JSON.parse(readFileSync(path, 'utf8')).tables.t).toEqual({ x: 5, y: 6 });
  });

  it('keep the notation across moves and restarts', () => {
    const store = new LayoutStore(path);
    store.update({}, null, undefined, 'idef1x');
    store.update({ t: { x: 7, y: 8 } }, null);
    expect(new LayoutStore(path).get().notation).toBe('idef1x');
  });
});
