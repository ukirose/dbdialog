import { describe, expect, it } from 'vitest';
import { parseSchema } from '../src/core/parser';
import { toView, type ViewTable } from '../src/core/view';
import { fkKey } from '../src/web/diagram/colors';
import { cycleClosers, elkLayout, routeKey } from '../src/web/diagram/elkLayout';
import { nodeSize, rowCenter } from '../src/web/diagram/geometry';
import { valueFlow } from '../src/web/valueFlow';
import { fixture } from './helpers';

const view = (name: string) => toView(parseSchema(fixture(name)), name, 1).tables;

// What the browser would measure, estimated (the tests have no page).
const estimate = (t: ViewTable) => ({
  ...nodeSize(t, true),
  rows: Object.fromEntries(t.columns.map((c) => [c.name, rowCenter(t, c.name)])),
});

describe('the automatic layout (ELK)', () => {
  it.each(['library.sql', 'marketplace.sql'])(
    'routes no line through a box, and overlaps no boxes (%s)',
    async (name) => {
      const tables = view(name);
      const { positions, routes } = await elkLayout(tables, estimate);
      const boxes = tables.map((t) => ({
        name: t.name,
        ...(positions[t.name] as { x: number; y: number }),
        ...estimate(t),
      }));
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          const apart =
            a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y;
          expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
        }
      }
      expect(Object.keys(routes).length).toBeGreaterThan(5);
      for (const [key, r] of Object.entries(routes)) {
        r.points.slice(1).forEach((q, k) => {
          const p = r.points[k] as [number, number];
          // Only right angles.
          expect(p[0] === q[0] || p[1] === q[1], `${key} has a slanted segment`).toBe(true);
          for (const b of boxes) {
            // The inside of the box (its border is where lines start and end).
            const [l, t, rr, bb] = [b.x + 2, b.y + 2, b.x + b.width - 2, b.y + b.height - 2];
            const [x1, x2] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])];
            const [y1, y2] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
            const crosses = x1 < rr && x2 > l && y1 < bb && y2 > t;
            expect(crosses, `${key} runs behind ${b.name}`).toBe(false);
          }
        });
      }
    },
  );

  it('puts referenced tables to the left and starts each line at its own row', async () => {
    const tables = view('library.sql');
    const { positions, routes } = await elkLayout(tables, estimate);
    const pos = (n: string) => positions[n] as { x: number; y: number };
    const size = (n: string) => estimate(tables.find((t) => t.name === n) as ViewTable);
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        if (fk.refTable === t.name) continue;
        expect(pos(fk.refTable).x + size(fk.refTable).width).toBeLessThanOrEqual(pos(t.name).x);
      }
    }
    // loan_files.loan_id → loans.ID: from the left of its row to the right of the other.
    const r = routes[routeKey('loan_files', 'loan_id', 'loans', 'ID')];
    const start = r?.points[0] as [number, number];
    const end = r?.points.at(-1) as [number, number];
    expect(Math.abs(start[0] - pos('loan_files').x)).toBeLessThan(3);
    expect(
      Math.abs(start[1] - (pos('loan_files').y + (size('loan_files').rows.loan_id ?? 0))),
    ).toBeLessThan(3);
    expect(Math.abs(end[0] - (pos('loans').x + size('loans').width))).toBeLessThan(3);
    expect(Math.abs(end[1] - (pos('loans').y + (size('loans').rows.ID ?? 0)))).toBeLessThan(3);
  });

  it('finds the foreign key that closes a cycle, the same one every time', () => {
    const tables = view('marketplace.sql');
    const fk = tables
      .find((t) => t.name === 'purchases')
      ?.foreignKeys.find((f) => f.name === 'fk_purchases_shipment');
    expect([...cycleClosers(tables)]).toEqual([fkKey('purchases', fk?.id ?? '')]);
    expect(cycleClosers(view('library.sql')).size).toBe(0);
  });

  it('runs that foreign key between its two tables, not around everything', async () => {
    const tables = view('marketplace.sql');
    const { positions, routes } = await elkLayout(tables, estimate);
    const purchases = positions.purchases as { x: number; y: number };
    const shipments = positions.shipments as { x: number; y: number };
    const right =
      purchases.x + estimate(tables.find((t) => t.name === 'purchases') as ViewTable).width;
    const r = routes[routeKey('purchases', 'current_shipment_id', 'shipments', 'id')];
    // From the right of purchases to the left of shipments, every corner in between.
    expect(r?.sides).toEqual(['r', 'l']);
    for (const [x] of r?.points ?? []) {
      expect(x).toBeGreaterThanOrEqual(right - 2);
      expect(x).toBeLessThanOrEqual(shipments.x + 2);
    }
  });
});

describe('the flow of a column’s values', () => {
  const tables = view('library.sql');

  it('follows the foreign keys up to the key the values come from', () => {
    const flow = valueFlow(tables, 'loan_files', 'tenant_id');
    expect(flow?.path.map((c) => `${c.table}.${c.column}`)).toEqual([
      'loan_files.tenant_id',
      'loans.tenant_id',
      'members.tenant_id',
      'tenants.ID',
    ]);
  });

  it('reaches every column carrying the same values, and no other', () => {
    const flow = valueFlow(tables, 'loan_files', 'tenant_id');
    const names = flow?.columns.map((c) => `${c.table}.${c.column}`);
    expect(names).toEqual([
      'tenants.ID',
      'members.tenant_id',
      'delivery_methods.tenant_id',
      'member_addresses.tenant_id',
      'loans.tenant_id',
      'loan_files.tenant_id',
    ]);
    // member_codes has tenant_id too, but no foreign key joins it: not the same values.
    expect(names).not.toContain('member_codes.tenant_id');
  });

  it('starts at the key itself when the chosen column is the key', () => {
    const flow = valueFlow(tables, 'loans', 'ID');
    expect(flow?.path.map((c) => c.column)).toEqual(['ID']);
    expect(flow?.columns.map((c) => `${c.table}.${c.column}`)).toEqual([
      'loans.ID',
      'loan_files.loan_id',
    ]);
  });

  it('has nothing to show for a column no foreign key uses', () => {
    expect(valueFlow(tables, 'member_codes', 'code')).toBeNull();
  });
});
