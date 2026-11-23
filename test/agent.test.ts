import { describe, expect, it } from 'vitest';
import { parseSchema } from '../src/core/parser';
import { toView, type ViewTable } from '../src/core/view';
import { findChrome } from '../src/server/snapshot';
import {
  danglingColumns,
  degrees,
  focusTables,
  sharedColumn,
  structureChecks,
} from '../src/web/diagram/agent';
import {
  type AgentScene,
  agentLayout,
  pictureChecks,
  type Size,
} from '../src/web/diagram/agentLayout';
import { AGENT_PALETTE, assignFkColors, fkKey } from '../src/web/diagram/colors';
import { FIXTURES, fixture } from './helpers';

const view = (src: string) => toView(parseSchema(src), 'schema.sql', 1).tables;
const names = (tables: ViewTable[]) => tables.map((t) => t.name);
// Boxes about as wide as their names, as the browser would measure them.
const measure = (tables: ViewTable[]): Record<string, Size> =>
  Object.fromEntries(tables.map((t) => [t.name, { width: 48 + t.name.length * 9, height: 46 }]));

describe('the agent view: what it says about the schema', () => {
  it('counts the foreign keys of each table and those referencing it', () => {
    const d = degrees(view(fixture('marketplace.sql')));
    expect(d.get('purchases')).toEqual({ parents: 2, children: 2 });
    expect(d.get('tenants')).toEqual({ parents: 0, children: 2 });
    // A key to its own table counts on both sides.
    expect(d.get('categories')).toEqual({ parents: 2, children: 1 });
  });

  it('names the keys closing a cycle, and the tables on their own', () => {
    expect(structureChecks(view(fixture('marketplace.sql'))).cycles).toEqual([
      'purchases → shipments',
    ]);
    expect(structureChecks(view(fixture('orders.sql'))).isolated).toEqual(['logs']);
  });

  it('leaves out a REFERENCES written on a column: MySQL creates no foreign key for it', () => {
    const tables = view(`
      CREATE TABLE a (id INT PRIMARY KEY);
      CREATE TABLE b (id INT PRIMARY KEY, a_id INT REFERENCES a (id));
    `);
    expect(structureChecks(tables)).toMatchObject({ relationships: 0, isolated: ['a', 'b'] });
    expect(degrees(tables).get('a')).toEqual({ parents: 0, children: 0 });
  });

  it('keeps a table and the tables next to it when focused', () => {
    const tables = view(fixture('marketplace.sql'));
    expect(names(focusTables(tables, 'shipments'))).toEqual(['purchases', 'shipments']);
    expect(names(focusTables(tables, 'purchases'))).toEqual([
      'sellers',
      'purchases',
      'shipments',
      'purchase_files',
    ]);
  });

  it('colors the lines without reds, which mean a cycle', () => {
    expect(AGENT_PALETTE).not.toContain('coral');
    expect(AGENT_PALETTE).not.toContain('auburn');
    const colors = assignFkColors(view(fixture('library.sql')), AGENT_PALETTE.length);
    for (const c of colors.values()) expect(c).toBeLessThan(AGENT_PALETTE.length);
  });
});

describe('the agent view: signs of antipatterns it draws', () => {
  const planted = view(fixture('antipatterns.sql'));
  const get = (name: string) => planted.find((t) => t.name === name) as ViewTable;

  it('finds columns named like a reference that no foreign key uses', () => {
    expect(danglingColumns(get('comments'))).toEqual(['commentable_id']);
    expect(danglingColumns(get('orders'))).toEqual(['customer_id']);
    expect(danglingColumns(get('purchases'))).toEqual([]);
    // The table's own key, named after the table, is no reference; one named after another table is.
    const own = view(`
      CREATE TABLE tenants (tenant_id INT PRIMARY KEY);
      CREATE TABLE purchase_details (purchase_id INT PRIMARY KEY);`);
    expect(own.map(danglingColumns)).toEqual([[], ['purchase_id']]);
    // A REFERENCES inside the column creates no foreign key: it points at "?" too.
    const edge = view(fixture('edge-cases.sql')).find((t) => t.name === 'my table') as ViewTable;
    expect(danglingColumns(edge)).toContain('ref_id');
  });

  it('finds the column most keys carry, and the key that leaves it out', () => {
    const shared = sharedColumn(planted);
    expect(shared).toMatchObject({ column: 'tenant_id', carried: 7, total: 8 });
    const refunds = get('refunds');
    const leaving = refunds.foreignKeys.find((fk) => fk.refTable === 'purchases');
    expect([...(shared?.missing ?? [])]).toEqual([fkKey('refunds', leaving?.id ?? '')]);
    expect(structureChecks(planted)).toMatchObject({
      dangling: ['comments.commentable_id', 'orders.customer_id'],
      shared: { missing: ['refunds (purchase_id) → purchases (id)'] },
    });
    // No key of several columns: no column is shared, whatever repeats (order_id).
    expect(sharedColumn(view(fixture('orders.sql')))).toBeNull();
  });

  it('lays out the "?" boxes and the reasons with the rest, on nothing', async () => {
    const shared = sharedColumn(planted);
    const key = [...(shared?.missing ?? [])][0] as string;
    const scene = await agentLayout(planted, measure(planted), {
      stubs: structureChecks(planted).dangling.map((d) => {
        const [table, column] = d.split('.') as [string, string];
        return { table, column, size: { width: 9 * d.length, height: 24 } };
      }),
      labels: { [key]: { text: 'no tenant_id', width: 100, height: 22 } },
    });
    expect(pictureChecks(scene)).toEqual({ overlaps: 0, behind: 0 });
    expect(scene.lines.find((l) => l.key === key)?.label).not.toBeNull();
    expect(scene.lines.filter((l) => l.label !== null)).toHaveLength(1);
    // A "?" stands on the parents' side of its table, and its line runs to it.
    expect(scene.stubs.map((st) => `${st.table}.${st.column}`)).toEqual([
      'comments.commentable_id',
      'orders.customer_id',
    ]);
    for (const st of scene.stubs) {
      const table = scene.boxes[st.table] as { x: number };
      expect(st.box.x + st.box.width).toBeLessThan(table.x);
      const [x] = st.points[st.points.length - 1] as [number, number];
      expect(Math.abs(x - (st.box.x + st.box.width))).toBeLessThanOrEqual(2);
    }
  });
});

describe('the agent view: its picture', () => {
  for (const name of FIXTURES) {
    it(`puts nothing on anything, and draws a line for every foreign key (${name})`, async () => {
      const tables = view(fixture(name));
      const scene = await agentLayout(tables, measure(tables));
      expect(pictureChecks(scene)).toEqual({ overlaps: 0, behind: 0 });
      expect(scene.lines).toHaveLength(structureChecks(tables).relationships);
    });
  }

  it('draws parents left of their children, and a key closing a cycle the other way', async () => {
    const tables = view(fixture('marketplace.sql'));
    const scene = await agentLayout(tables, measure(tables));
    for (const l of scene.lines) {
      const [child, parent] = [scene.boxes[l.child], scene.boxes[l.parent]];
      if (!child || !parent || l.child === l.parent) continue;
      if (l.closesCycle) expect(parent.x).toBeGreaterThan(child.x);
      else expect(parent.x).toBeLessThan(child.x);
    }
    const closing = scene.lines.filter((l) => l.closesCycle);
    expect(closing.map((l) => `${l.child} → ${l.parent}`)).toEqual(['purchases → shipments']);
  });

  it('gives every line two ends of its own, and the parent end last', async () => {
    const tables = view(fixture('library.sql'));
    const scene = await agentLayout(tables, measure(tables));
    const ends = scene.lines.flatMap((l) => [l.points[0], l.points[l.points.length - 1]]);
    expect(new Set(ends.map((p) => p?.join(','))).size).toBe(ends.length);
    for (const l of scene.lines) {
      const [x] = l.points[l.points.length - 1] as [number, number];
      const parent = scene.boxes[l.parent] as { x: number; width: number };
      // On the parent's right side: the line comes from a child further right.
      expect(Math.abs(x - (parent.x + parent.width))).toBeLessThanOrEqual(2);
    }
  });

  it('makes a box taller when many lines end on it', async () => {
    const children = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const tables = view(
      [
        'CREATE TABLE hub (id INT PRIMARY KEY);',
        ...children.map(
          (c) =>
            `CREATE TABLE ${c} (id INT PRIMARY KEY, h INT, FOREIGN KEY (h) REFERENCES hub (id));`,
        ),
      ].join('\n'),
    );
    const scene = await agentLayout(tables, measure(tables));
    expect(scene.boxes.hub?.height).toBeGreaterThan(46);
    expect(pictureChecks(scene)).toEqual({ overlaps: 0, behind: 0 });
  });

  it('checks catch boxes on top of each other and lines behind a box', () => {
    const scene: AgentScene = {
      boxes: {
        a: { x: 0, y: 0, width: 100, height: 40 },
        b: { x: 50, y: 20, width: 100, height: 40 },
        c: { x: 300, y: 0, width: 100, height: 40 },
      },
      lines: [
        // From c, straight through a and b.
        {
          key: 'k',
          child: 'c',
          parent: 'a',
          points: [
            [298, 30],
            [-10, 30],
          ],
          closesCycle: false,
          label: null,
        },
      ],
      stubs: [],
      width: 400,
      height: 60,
    };
    expect(pictureChecks(scene)).toEqual({ overlaps: 1, behind: 1 });
  });
});

describe('dbdialog snapshot', () => {
  it('finds Chrome where CHROME_PATH says, and nothing when it points at nothing', () => {
    expect(findChrome({ CHROME_PATH: process.execPath }, 'linux')).toBe(process.execPath);
    expect(findChrome({ CHROME_PATH: '/no/such/chrome' }, 'linux')).toBeNull();
    expect(findChrome({ PATH: '' }, 'linux')).toBeNull();
  });
});
