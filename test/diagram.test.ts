import { describe, expect, it } from 'vitest';
import { parseSchema } from '../src/core/parser';
import { toView, type ViewTable } from '../src/core/view';
import { assignFkColors, fkKey } from '../src/web/diagram/colors';
import { type Box, buildEdges, type Emphasis } from '../src/web/diagram/edges';
import { searchSchema } from '../src/web/schemaSearch';
import { fixture } from './helpers';

const view = (name: string) => toView(parseSchema(fixture(name)), name, 1).tables;
const plain: Emphasis = {
  active: new Set(),
  raised: new Set(),
  spot: null,
  near: null,
  flow: null,
};
const box = (x: number): Box => ({ x, y: 0, width: 300, height: 200 });

/** Colors of every table-level foreign key that has `table` as its child or its parent. */
function colorsAround(tables: ViewTable[], colors: Map<string, number>, table: string) {
  return tables.flatMap((x) =>
    x.foreignKeys
      .filter((f) => f.origin === 'table' && (x.name === table || f.refTable === table))
      .map((f) => colors.get(fkKey(x.name, f.id))),
  );
}

describe('foreign key colors', () => {
  it.each(['library.sql', 'marketplace.sql'])(
    'differ between the foreign keys that meet at a table (%s)',
    (name) => {
      const tables = view(name);
      const colors = assignFkColors(tables);
      for (const t of tables) {
        const around = colorsAround(tables, colors, t.name);
        expect(new Set(around).size).toBe(around.length);
      }
    },
  );
});

describe('lines', () => {
  const tables = view('library.sql');
  const colors = assignFkColors(tables);
  // loans to the right of the tables it references.
  const boxes = {
    loans: box(800),
    delivery_methods: box(0),
    members: box(0),
    member_addresses: box(0),
  };
  const edges = buildEdges(tables, boxes, colors, plain);
  const between = (from: string, to: string) =>
    edges.filter((e) => e.source === from && e.target === to);

  it('run one per column pair, from the row of each column to the row it references', () => {
    expect(
      between('loans', 'delivery_methods').map((e) => [e.sourceHandle, e.targetHandle]),
    ).toEqual([
      ['l:tenant_id', 'r:tenant_id'],
      ['l:delivery_method_id', 'r:ID'],
      ['l:delivery_kind', 'r:kind'],
    ]);
  });

  it('share the color of their foreign key and run in separate lanes', () => {
    const lines = between('loans', 'delivery_methods');
    expect(new Set(lines.map((e) => e.data?.color)).size).toBe(1);
    expect(new Set(lines.map((e) => e.data?.shift)).size).toBe(lines.length);
  });

  it('leave from the side facing the other table', () => {
    const right = buildEdges(tables, { ...boxes, loans: box(-800) }, colors, plain);
    const line = right.find((e) => e.source === 'loans' && e.target === 'members');
    expect([line?.sourceHandle, line?.targetHandle]).toEqual(['r:tenant_id', 'l:tenant_id']);
  });

  it('draw a foreign key to its own table as a loop, and a column paired with itself as a small one', () => {
    const purchase = view('marketplace.sql');
    const loops = buildEdges(purchase, {}, assignFkColors(purchase), plain).filter(
      (e) => e.type === 'selfLoop',
    );
    // (tenant_id, parent_id) → categories (tenant_id, id): the parent is in the same tenant.
    expect(loops.map((e) => [e.sourceHandle, e.targetHandle, e.data?.selfPair])).toEqual([
      ['r:tenant_id', 'r:tenant_id', true],
      ['r:parent_id', 'r:id', false],
    ]);
    // Its label goes on the line that goes somewhere, not on the small loop.
    expect(loops.map((e) => e.data?.labeled)).toEqual([false, true]);
    // The big loop passes the tenant_id row, so it swings out around the small one.
    expect(loops[1]?.data?.outset).toBeGreaterThan(40);
  });

  it('carry one label per foreign key', () => {
    for (const fk of tables.flatMap((t) => t.foreignKeys.map((f) => fkKey(t.name, f.id)))) {
      const own = edges.filter((e) => e.id.startsWith(`${fk}\u0000`));
      expect(own.filter((e) => e.data?.labeled)).toHaveLength(1);
    }
  });

  it('leave and enter on the sides the layout gave a line that closes a cycle', () => {
    const purchase = view('marketplace.sql');
    const at: [[number, number], [number, number]] = [
      [0, 0],
      [600, 0],
    ];
    const routed = buildEdges(
      purchase,
      { purchases: box(0), shipments: box(600) },
      assignFkColors(purchase),
      plain,
      {
        'purchases.current_shipment_id -> shipments.id': {
          at,
          points: [
            [300, 100],
            [600, 100],
          ],
          sides: ['r', 'l'],
        },
      },
    );
    const line = routed.find((e) => e.sourceHandle === 'r:current_shipment_id');
    expect(line?.targetHandle).toBe('l:id');
    expect(line?.data?.route).not.toBeNull();
  });

  it('fade everything but the foreign keys in the spotlight', () => {
    const fk = tables.find((t) => t.name === 'loan_files')?.foreignKeys[0];
    const key = fkKey('loan_files', fk?.id ?? '');
    const lit = buildEdges(tables, boxes, colors, { ...plain, spot: new Set([key]) });
    const dim = lit.filter((e) => e.className?.includes('is-dim'));
    expect(lit.length - dim.length).toBe(2);
  });
});

describe('search', () => {
  const tables = view('library.sql');

  it('puts exact names first, then prefixes, then the rest, tables before columns', () => {
    const hits = (q: string) => searchSchema(tables, q).map((h) => [h.table, h.column]);
    // "address" is a column; "address_id" starts with it; "member_addresses" contains it.
    expect(hits('address')).toEqual([
      ['member_addresses', 'address'],
      ['loans', 'address_id'],
      ['member_addresses', null],
    ]);
    // Names that start with "loan": the tables before the column.
    expect(hits('loan').slice(0, 3)).toEqual([
      ['loans', null],
      ['loan_files', null],
      ['loan_files', 'loan_id'],
    ]);
  });

  it('finds nothing for an empty query', () => {
    expect(searchSchema(tables, '  ')).toEqual([]);
  });
});
