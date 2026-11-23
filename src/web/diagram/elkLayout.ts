// Automatic layout with ELK (the Eclipse Layout Kernel, elkjs, EPL-2.0).
// Tables go in layers, referenced tables to the left. Every row is a fixed
// connection point on each side of its box, so the layout knows which row a
// line leaves from: it orders the boxes to cross fewer lines, and routes the
// lines at right angles around the boxes instead of behind them.
// elkjs is large (1.6 MB); it is loaded only when a layout is computed.

import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { LayoutRoute, Position, ViewTable } from '../../core/view';
import { fkKey } from './colors';

/** A box as the browser drew it: its size and the center of each row, from its top. */
export interface Measured {
  width: number;
  height: number;
  rows: Record<string, number>;
}

const lower = (s: string) => s.toLowerCase();

/** The declared spelling of a column (MySQL column names ignore case). */
function columnName(t: ViewTable, name: string): string | null {
  return t.columns.find((c) => lower(c.name) === lower(name))?.name ?? null;
}

/** Names one column pair of a foreign key, the way the layout file stores its line. */
export const routeKey = (child: string, column: string, parent: string, refColumn: string) =>
  `${child}.${column} -> ${parent}.${refColumn}`;

/**
 * Foreign keys (fkKey) that close a cycle of tables referencing each other
 * (purchases → shipments → purchases), found by a depth-first search from parent
 * to child in the order of the file, so the same schema gives the same answer.
 */
export function cycleClosers(tables: ViewTable[]): Set<string> {
  const names = new Set(tables.map((t) => t.name));
  const children = new Map<string, { child: string; fk: string }[]>();
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (fk.origin !== 'table' || fk.refTable === t.name || !names.has(fk.refTable)) continue;
      children.set(fk.refTable, [
        ...(children.get(fk.refTable) ?? []),
        { child: t.name, fk: fk.id },
      ]);
    }
  }
  const state = new Map<string, 'open' | 'done'>();
  const out = new Set<string>();
  const visit = (table: string) => {
    state.set(table, 'open');
    for (const e of children.get(table) ?? []) {
      const s = state.get(e.child);
      if (s === 'open') out.add(fkKey(e.child, e.fk));
      else if (s === undefined) visit(e.child);
    }
    state.set(table, 'done');
  };
  for (const t of tables) if (!state.has(t.name)) visit(t.name);
  return out;
}

const OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  // Ties go to the order of the file, so the same schema gives the same picture.
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.mergeEdges': 'false',
  'elk.spacing.nodeNode': '48',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.edgeNode': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.spacing.edgeEdge': '8',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
  'elk.spacing.componentComponent': '72',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
};

export async function elkLayout(
  tables: ViewTable[],
  measure: (t: ViewTable) => Measured,
): Promise<{ positions: Record<string, Position>; routes: Record<string, LayoutRoute> }> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const byName = new Map(tables.map((t) => [t.name, t]));
  // ELK gets plain ids; names may hold any character.
  const tableOf = new Map<string, string>();
  const portOf = new Map<string, string>();
  const children: ElkNode[] = tables.map((t, i) => {
    const m = measure(t);
    const id = `n${i}`;
    tableOf.set(id, t.name);
    const ports: ElkPort[] = t.columns.flatMap((c, k) => {
      const y = (m.rows[c.name] ?? 0) - 1;
      const west = `${id}w${k}`;
      const east = `${id}e${k}`;
      portOf.set(`${t.name}\u0000${c.name}\u0000W`, west);
      portOf.set(`${t.name}\u0000${c.name}\u0000E`, east);
      return [
        { id: west, x: -1, y, width: 2, height: 2, layoutOptions: { 'elk.port.side': 'WEST' } },
        {
          id: east,
          x: m.width - 1,
          y,
          width: 2,
          height: 2,
          layoutOptions: { 'elk.port.side': 'EAST' },
        },
      ];
    });
    return {
      id,
      width: m.width,
      height: m.height,
      ports,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    };
  });

  // A key that closes a cycle cannot go from its parent's right to its child's
  // left like the others: one of the two tables has to be on the right, and
  // the line would run back around everything. It leaves the child on the
  // right and enters the parent on the left instead, so it stays between them.
  const closers = cycleClosers(tables);
  const edges: ElkExtendedEdge[] = [];
  const pairs = new Map<string, { key: string; child: string; parent: string; closes: boolean }>();
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const parent = byName.get(fk.refTable);
      // Inline REFERENCES are ignored by MySQL; a key to its own table is drawn as a loop.
      if (fk.origin !== 'table' || !parent || parent === t) continue;
      const closes = closers.has(fkKey(t.name, fk.id));
      fk.columns.forEach((name, i) => {
        const col = columnName(t, name);
        const refCol = columnName(parent, fk.refColumns[i] ?? '');
        if (!col || !refCol) return;
        // From the parent to the child: the referenced table comes first, on the
        // left. A key closing a cycle runs from the child's right to the parent's left.
        const source = closes
          ? portOf.get(`${t.name}\u0000${col}\u0000E`)
          : portOf.get(`${parent.name}\u0000${refCol}\u0000E`);
        const target = closes
          ? portOf.get(`${parent.name}\u0000${refCol}\u0000W`)
          : portOf.get(`${t.name}\u0000${col}\u0000W`);
        if (!source || !target) return;
        const id = `x${edges.length}`;
        edges.push({ id, sources: [source], targets: [target] });
        pairs.set(id, {
          key: routeKey(t.name, col, parent.name, refCol),
          child: t.name,
          parent: parent.name,
          closes,
        });
      });
    }
  }

  const graph = await new ELK().layout({ id: 'root', layoutOptions: OPTIONS, children, edges });

  const positions: Record<string, Position> = {};
  for (const c of graph.children ?? []) {
    const name = tableOf.get(c.id);
    if (name) positions[name] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
  }
  const routes: Record<string, LayoutRoute> = {};
  for (const e of graph.edges ?? []) {
    const pair = pairs.get(e.id);
    const s = e.sections?.[0];
    const child = pair && positions[pair.child];
    const parent = pair && positions[pair.parent];
    if (!pair || !s || !child || !parent) continue;
    const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(
      (q) => [Math.round(q.x), Math.round(q.y)] as [number, number],
    );
    // Drawn from the child to the parent, like every foreign key line.
    if (!pair.closes) points.reverse();
    routes[pair.key] = {
      at: [
        [child.x, child.y],
        [parent.x, parent.y],
      ],
      points,
      ...(pair.closes ? { sides: ['r', 'l'] as ['r', 'l'] } : {}),
    };
  }
  return { positions, routes };
}
