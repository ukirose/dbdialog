// Box sizes and automatic placement (dagre) for tables without a saved position.
// The sizes follow styles.css (.thead, .trow); the browser measures the real
// boxes, so these only need to be close enough for placing them.

import dagre from '@dagrejs/dagre';
import type { Position, ViewColumn, ViewKey, ViewTable } from '../../core/view';

export const HEADER_H = 35;
export const COMMENT_H = 16;
export const ROW_H = 26;
const KEY_H = 23;

/**
 * The rows of a box, top to bottom: the primary key columns in the order of
 * the PRIMARY KEY, then the other columns in the order of the table. A line
 * between the two groups is how IE and IDEF1X diagrams show the primary key.
 * A table without one shows "No primary key" above the line instead.
 */
export function boxRows(t: ViewTable): { key: ViewColumn[]; rest: ViewColumn[] } {
  const byName = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]));
  const key: ViewColumn[] = [];
  for (const name of t.primaryKey?.columns ?? []) {
    const c = byName.get(name.toLowerCase());
    if (c && !key.includes(c)) key.push(c);
  }
  return { key, rest: t.columns.filter((c) => !key.includes(c)) };
}

/**
 * Keys listed under the columns: UNIQUE keys of several columns and every
 * plain index. The primary key is not listed: it is the rows above the line.
 */
export function listedKeys(t: ViewTable): ViewKey[] {
  return t.keys.filter((k) => k.kind !== 'unique' || k.columns.length > 1);
}

/** Text width in "half-width" units: CJK characters count twice. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return w;
}

/** Vertical center of a column's row, from the top of its box. */
export function rowCenter(t: ViewTable, column: string): number {
  const { key, rest } = boxRows(t);
  const i = Math.max(
    [...key, ...rest].findIndex((c) => c.name === column),
    0,
  );
  // With no primary key, the "No primary key" row comes first.
  const above = key.length === 0 ? 1 : 0;
  return 1 + HEADER_H + (t.comment ? COMMENT_H : 0) + (i + above) * ROW_H + ROW_H / 2;
}

/** Rough box size; good enough for placement (the real size is measured by the browser). */
export function nodeSize(t: ViewTable, showComments: boolean): { width: number; height: number } {
  const checked = new Set(t.checks.flatMap((c) => c.columns));
  let name = 0;
  let marks = 0;
  let comment = 0;
  let type = 0;
  let nul = 0;
  for (const c of t.columns) {
    name = Math.max(name, width(c.name) * 7 + 10);
    // The marks of IE, or the (FK) (AK1) notes of IDEF1X: about as wide.
    const m =
      (c.foreignKey ? 52 : 0) +
      (c.unique || c.primaryKey ? 40 : 0) +
      (c.generated ? 38 : 0) +
      (checked.has(c.name) ? 64 : 0);
    marks = Math.max(marks, m ? m + 8 : 0);
    if (showComments && c.comment)
      comment = Math.max(comment, Math.min(width(c.comment) * 6 + 8, 250));
    type = Math.max(type, width(c.type) * 6.6 + 12);
    if (c.nullable !== false && !c.primaryKey) nul = 58;
  }
  const keys = listedKeys(t);
  const keysWidth = Math.max(0, ...keys.map((k) => width(k.columns.join(', ')) * 6.6 + 80));
  const w = Math.min(
    Math.max(name + marks + comment + type + nul + 32, width(t.name) * 7.5 + 70, keysWidth, 180),
    900,
  );
  const commentLines = t.comment ? Math.ceil((width(t.comment) * 6) / (w - 24)) : 0;
  const noKey = boxRows(t).key.length === 0 ? 1 : 0;
  return {
    width: w,
    height:
      2 +
      HEADER_H +
      commentLines * COMMENT_H +
      (t.columns.length + noKey) * ROW_H +
      (keys.length ? 10 + keys.length * KEY_H : 0),
  };
}

/** Lays out every table: referenced tables to the left, the tables that point at them to the right. */
export function autoLayout(tables: ViewTable[], showComments: boolean): Record<string, Position> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 110, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const t of tables) g.setNode(t.name, nodeSize(t, showComments));
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (fk.refTable !== t.name && g.hasNode(fk.refTable)) g.setEdge(fk.refTable, t.name);
    }
  }
  dagre.layout(g);
  const out: Record<string, Position> = {};
  for (const t of tables) {
    const n = g.node(t.name);
    const s = nodeSize(t, showComments);
    out[t.name] = { x: Math.round(n.x - s.width / 2), y: Math.round(n.y - s.height / 2) };
  }
  return out;
}

/**
 * Places new tables without moving the others: next to a table they
 * reference when there is one, otherwise to the right of everything.
 */
export function placeNew(
  tables: ViewTable[],
  placed: Record<string, Position>,
  showComments: boolean,
): Record<string, Position> {
  const out = { ...placed };
  const boxes = () =>
    Object.entries(out).map(([name, p]) => {
      const t = tables.find((x) => x.name === name);
      const s = t ? nodeSize(t, showComments) : { width: 240, height: 120 };
      return { x: p.x, y: p.y, w: s.width, h: s.height };
    });
  const overlaps = (x: number, y: number, w: number, h: number) =>
    boxes().some(
      (b) => x < b.x + b.w + 30 && b.x < x + w + 30 && y < b.y + b.h + 30 && b.y < y + h + 30,
    );
  for (const t of tables) {
    if (out[t.name]) continue;
    const s = nodeSize(t, showComments);
    const all = boxes();
    const maxX = all.length ? Math.max(...all.map((b) => b.x + b.w)) : 0;
    const minY = all.length ? Math.min(...all.map((b) => b.y)) : 0;
    const parent = t.foreignKeys.map((f) => f.refTable).find((n) => n !== t.name && out[n]);
    let x = maxX + 110;
    let y = minY;
    if (parent) {
      const p = out[parent] as Position;
      const pt = tables.find((u) => u.name === parent);
      x = p.x + (pt ? nodeSize(pt, showComments).width : 240) + 110;
      y = p.y;
    }
    while (overlaps(x, y, s.width, s.height)) y += 40;
    out[t.name] = { x, y };
  }
  return out;
}
