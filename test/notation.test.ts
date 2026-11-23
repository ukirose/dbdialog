import { describe, expect, it } from 'vitest';
import { parseSchema } from '../src/core/parser';
import { toView, type ViewKey, type ViewTable } from '../src/core/view';
import { boxRows, listedKeys, nodeSize, ROW_H, rowCenter } from '../src/web/diagram/geometry';
import { alternateKeys, columnAlternateKeys, isDependent } from '../src/web/diagram/notation';
import { fixture } from './helpers';

const view = (name: string) => toView(parseSchema(fixture(name)), name, 1).tables;
const orders = view('orders.sql');
const purchase = view('marketplace.sql');
const get = (tables: ViewTable[], name: string) => tables.find((t) => t.name === name) as ViewTable;

describe('the rows of a box', () => {
  it('put the primary key first, in the order of the key, above the other columns', () => {
    // line_no comes first in the table, but the key is (order_id, line_no).
    const { key, rest } = boxRows(get(orders, 'order_items'));
    expect(key.map((c) => c.name)).toEqual(['order_id', 'line_no']);
    expect(rest.map((c) => c.name)).toEqual(['quantity']);
  });

  it('place the lines where the rows are shown', () => {
    const items = get(orders, 'order_items');
    expect(rowCenter(items, 'order_id')).toBeLessThan(rowCenter(items, 'line_no'));
    expect(rowCenter(items, 'quantity') - rowCenter(items, 'line_no')).toBe(ROW_H);
  });

  it('keep a row for "No primary key" when the table has none', () => {
    const logs = get(orders, 'logs');
    expect(boxRows(logs).key).toEqual([]);
    // The first column is the second row.
    expect(rowCenter(logs, 'message')).toBe(rowCenter(get(orders, 'customers'), 'name'));
    const pk = get(orders, 'customers').primaryKey as ViewKey;
    const withKey = { ...logs, primaryKey: { ...pk, columns: ['message'] } };
    expect(nodeSize(logs, true).height - nodeSize(withKey, true).height).toBe(ROW_H);
  });

  it('do not list the primary key again under the columns', () => {
    expect(listedKeys(get(orders, 'order_items'))).toEqual([]);
    expect(listedKeys(get(purchase, 'purchases')).map((k) => k.name)).toEqual([
      'uq_purchases_number',
      'uq_purchases_tenant_id',
    ]);
  });
});

describe('IE and IDEF1X', () => {
  it('know a dependent entity by a foreign key inside its primary key', () => {
    const dependent = orders.filter(isDependent).map((t) => t.name);
    expect(dependent).toEqual(['order_items', 'order_notes']);
    // Every table there has a surrogate key of its own: no identifying relationship.
    expect(purchase.filter(isDependent)).toEqual([]);
  });

  it('read the cardinality the line ends show from the DDL', () => {
    const fk = (table: string) => get(orders, table).foreignKeys[0]?.cardinality;
    // Identifying, many items per order.
    expect(fk('order_items')).toEqual({ parent: 'one', child: 'zeroOrMany', identifying: true });
    // Identifying, one note per order at most: IDEF1X writes "Z".
    expect(fk('order_notes')).toEqual({ parent: 'one', child: 'zeroOrOne', identifying: true });
    // Non-identifying and NULL allowed: IDEF1X puts a diamond at the parent.
    expect(fk('orders')).toEqual({ parent: 'zeroOrOne', child: 'zeroOrMany', identifying: false });
  });

  it('number the alternate keys in the order of the table', () => {
    const sellers = get(purchase, 'sellers');
    expect([...alternateKeys(sellers).values()]).toEqual([1, 2]);
    expect(Object.fromEntries(columnAlternateKeys(sellers))).toEqual({
      tenant_id: [1, 2],
      id: [1],
      code: [2],
      alive: [2],
    });
  });
});
