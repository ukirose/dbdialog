import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Position,
} from '@xyflow/react';
import type { LayoutRoute, Notation, ViewForeignKey, ViewTable } from '../../core/view';
import { t } from '../i18n';
import { fkColor, fkKey } from './colors';
import { routeKey } from './elkLayout';
import { rowCenter } from './geometry';
import { markerId } from './Markers';
import { labelPoint, routedPath, visiblePoint } from './pathMid';
import { textWidth } from './TableNode';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FkEdgeData extends Record<string, unknown> {
  table: string;
  fk: ViewForeignKey;
  /** Which column pair of the key this line joins. */
  pair: number;
  /** Palette index; null for a REFERENCES inside a column, which MySQL ignores. */
  color: number | null;
  /** Sideways shift of the middle segment, so lines between the same two tables do not overlap. */
  shift: number;
  /** How far a line leaving and entering on the same side (or a self loop) swings out. */
  outset: number;
  /** Under the pointer or chosen: drawn thicker, with its label. */
  active: boolean;
  /** The line the automatic layout routed around the boxes, while both boxes stay put. */
  route: [number, number][] | null;
  /**
   * A column paired with itself in a key to its own table (tenant_id → tenant_id):
   * a small loop beside its row, without ends; the key's other lines carry those.
   */
  selfPair: boolean;
  /** The one line of its foreign key that shows the label (name, ON DELETE). */
  labeled: boolean;
  notation: Notation;
  /** Every box: the arrow and the label go where no box hides them. */
  boxes: Box[];
}

export type FkEdgeType = Edge<FkEdgeData>;

export interface Emphasis {
  /** Foreign keys (fkKey) drawn thick, with their label. */
  active: Set<string>;
  /**
   * Foreign keys drawn above the others: the chosen one only. A hovered line is
   * not raised, because raising moves it in the DOM and the pointer would lose it.
   */
  raised: Set<string>;
  /** When set, the foreign keys left undimmed; everything else fades. */
  spot: Set<string> | null;
  /** The selected table: its lines are drawn a little heavier. */
  near: string | null;
  /**
   * Lines (by edge id) carrying the values of the chosen column, followed
   * through every table; the other lines fade. A hover spot comes first.
   */
  flow: Set<string> | null;
}

/** Whether a box is where it was when a route was computed (positions are whole pixels). */
const stayed = (box: Box | undefined, at: [number, number]) =>
  box !== undefined && Math.abs(box.x - at[0]) < 0.5 && Math.abs(box.y - at[1]) < 0.5;

const LANE_GAP = 8;
/** How far a column's loop to itself reaches out of its box (its curve's control points). */
const SMALL_LOOP = 22;
/** Width of a half-width character in a label (.fk-label: 11px monospace). */
const LABEL_CHAR = 6.7;

/** The declared spelling of a column (MySQL column names ignore case). */
function columnName(tbl: ViewTable, name: string): string | null {
  const lower = name.toLowerCase();
  return tbl.columns.find((c) => c.name.toLowerCase() === lower)?.name ?? null;
}

interface Line {
  edge: FkEdgeType & { data: FkEdgeData };
  group: string;
  self: boolean;
  /** +1 when the line runs rightward, -1 leftward. */
  dx: number;
  fromY: number;
  toY: number;
}

/**
 * One line per column pair, from the row of the referencing column to the row
 * of the referenced one, so each column of a composite key shows where it points.
 */
export function buildEdges(
  tables: ViewTable[],
  boxes: Record<string, Box>,
  colors: Map<string, number>,
  emphasis: Emphasis,
  routes: Record<string, LayoutRoute> | null = null,
  notation: Notation = 'ie',
): FkEdgeType[] {
  const byName = new Map(tables.map((x) => [x.name, x]));
  const all = Object.values(boxes);
  const lines: Line[] = [];
  for (const tbl of tables) {
    for (const fk of tbl.foreignKeys) {
      const parent = byName.get(fk.refTable);
      if (!parent) continue;
      const key = fkKey(tbl.name, fk.id);
      const self = parent === tbl;
      const a = boxes[tbl.name];
      const b = boxes[parent.name];
      // Leave from the side facing the other table; around the right when they overlap.
      let from: 'l' | 'r' = 'r';
      let to: 'l' | 'r' = 'r';
      if (!self && a && b) {
        if (b.x >= a.x + a.width) to = 'l';
        else if (b.x + b.width <= a.x) from = 'l';
      }
      const active = emphasis.active.has(key);
      const first = lines.length;
      fk.columns.forEach((name, i) => {
        const col = columnName(tbl, name);
        const refCol = columnName(parent, fk.refColumns[i] ?? '');
        if (!col || !refCol) return; // lint reports the unknown column
        const id = `${key}\u0000${i}`;
        const classes = ['fk-edge'];
        if (active) classes.push('is-active');
        if (emphasis.spot) {
          if (!emphasis.spot.has(key)) classes.push('is-dim');
        } else if (emphasis.flow) {
          classes.push(emphasis.flow.has(id) ? 'is-flow' : 'is-dim');
        }
        if (emphasis.near === tbl.name || emphasis.near === parent.name) classes.push('is-near');
        // A routed line leaves and enters on the sides the layout gave it
        // (child left, parent right, unless it closes a cycle), wherever the boxes ended up.
        const r =
          fk.origin === 'table' && !self
            ? routes?.[routeKey(tbl.name, col, parent.name, refCol)]
            : undefined;
        const route = r && stayed(a, r.at[0]) && stayed(b, r.at[1]) ? r : null;
        const [routeFrom, routeTo] = route?.sides ?? ['l', 'r'];
        lines.push({
          group: self ? tbl.name : [tbl.name, parent.name].sort().join('\u0000'),
          self,
          dx: from === 'r' ? 1 : -1,
          fromY: (a?.y ?? 0) + rowCenter(tbl, col),
          toY: (b?.y ?? 0) + rowCenter(parent, refCol),
          edge: {
            id,
            source: tbl.name,
            sourceHandle: `${route ? routeFrom : from}:${col}`,
            target: parent.name,
            targetHandle: `${route ? routeTo : to}:${refCol}`,
            type: self ? 'selfLoop' : 'fk',
            className: classes.join(' '),
            zIndex: emphasis.raised.has(key) ? 10 : 0,
            data: {
              table: tbl.name,
              fk,
              pair: i,
              color: fk.origin === 'table' ? (colors.get(key) ?? 0) : null,
              shift: 0,
              outset: 24,
              active,
              route: route?.points ?? null,
              selfPair: self && col === refCol,
              labeled: false,
              notation,
              boxes: all,
            },
          },
        });
      });
      // The label goes on the first line that is more than a column's loop to itself.
      const own = lines.slice(first);
      const carrier = own.find((l) => !l.edge.data.selfPair) ?? own[0];
      if (carrier) carrier.edge.data.labeled = true;
    }
  }

  // Lines between the same two tables run in parallel lanes. Ordered so that
  // lines keeping their order (upper row to upper row) do not cross.
  const groups = new Map<string, Line[]>();
  for (const l of lines) {
    if (l.edge.data.selfPair) continue; // a small loop of its own, beside its row
    groups.set(l.group, [...(groups.get(l.group) ?? []), l]);
  }
  for (const g of groups.values()) {
    const self = g[0]?.self ?? false;
    if (self) g.sort((p, q) => Math.abs(p.toY - p.fromY) - Math.abs(q.toY - q.fromY));
    else g.sort((p, q) => p.fromY - q.fromY);
    const down = g.reduce((s, l) => s + (l.toY - l.fromY), 0) >= 0 ? 1 : -1;
    g.forEach((l, i) => {
      l.edge.data.shift = ((g.length - 1) / 2 - i) * LANE_GAP * l.dx * down;
      l.edge.data.outset = 24 + i * 10;
    });
  }
  // A column's small loop to itself sits right beside its row; the other loops
  // of its table pass over that row, so they swing out around it.
  const small = new Set(lines.filter((l) => l.edge.data.selfPair).map((l) => l.group));
  for (const l of lines) {
    if (l.self && !l.edge.data.selfPair && small.has(l.group)) l.edge.data.outset += SMALL_LOOP;
  }
  return lines.map((l) => l.edge);
}

function stroke(d: FkEdgeData): string {
  return d.color === null ? 'var(--fgColor-danger)' : fkColor(d.color);
}

function labelText(fk: ViewForeignKey): string {
  if (fk.origin === 'column') return t('edge.ignored');
  return [
    fk.name,
    fk.onDelete && `ON DELETE ${fk.onDelete}`,
    fk.onUpdate && `ON UPDATE ${fk.onUpdate}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function Line(props: {
  id: string;
  path: string;
  d: FkEdgeData;
  /** Where the line leaves the child's row, and which way: -1 left, 1 right. */
  start: { x: number; y: number; dir: number };
  /** Where the line enters the parent's row, from which side: -1 left, 1 right. */
  end: { x: number; y: number; dir: number };
  /** Where the label goes when it does not sit on the line (beside a loop). */
  label?: { x: number; y: number };
}) {
  const { d } = props;
  const ignored = d.color === null;
  const card = d.fk.cardinality;
  const idef = d.notation === 'idef1x';
  // No ends and no arrow: a REFERENCES MySQL ignores, or a column's loop to itself.
  const bare = ignored || d.selfPair;
  // The ends, read from the DDL. IE: children per parent at the child end,
  // parents per child at the parent end. IDEF1X: a dot at the child end, and a
  // diamond at the parent end when the key may be NULL (an optional relationship).
  let ends: { markerStart?: string; markerEnd?: string } = {};
  if (!bare && idef) {
    ends = {
      markerStart: `url(#${markerId('dot', d.color)})`,
      ...(card.parent === 'zeroOrOne'
        ? { markerEnd: `url(#${markerId('diamond', d.color)})` }
        : {}),
    };
  } else if (!bare) {
    ends = {
      markerStart: `url(#${markerId(card.child, d.color)})`,
      markerEnd: `url(#${markerId(card.parent, d.color)})`,
    };
  }
  // Solid: an identifying relationship (the foreign key is in the child's
  // primary key). Dashed: a non-identifying one. Dotted: ignored by MySQL.
  const dash = ignored ? '1 4' : card.identifying ? undefined : '5 4';
  const text = d.active && d.labeled ? labelText(d.fk) : '';
  // The arrow (from the child to the parent: the way the key points) goes where
  // no box covers the line; the label where all of it stays clear of the boxes,
  // or else where it covers the least of them (it is drawn above them).
  const spot = bare ? null : visiblePoint(props.path, d.boxes);
  const half = { x: (textWidth(text) * LABEL_CHAR + 16) / 2 + 4, y: 14 };
  const at = props.label ?? (text ? labelPoint(props.path, d.boxes, half) : null);
  // IDEF1X writes "Z" beside the dot when the child has one row at most.
  const zero = idef && !bare && card.child === 'zeroOrOne';
  return (
    <>
      <BaseEdge
        id={props.id}
        path={props.path}
        {...ends}
        interactionWidth={12}
        style={{
          stroke: stroke(d),
          strokeDasharray: dash,
          strokeLinecap: ignored ? 'round' : undefined,
        }}
      />
      {!bare && spot && (
        <path
          className="fk-dir"
          d="M -4 -4.5 L 2.5 0 L -4 4.5"
          transform={`translate(${spot.x} ${spot.y}) rotate(${spot.angle})`}
          style={{ stroke: stroke(d) }}
        />
      )}
      {zero && (
        <text
          className="fk-card"
          x={props.start.x + props.start.dir * 13}
          y={props.start.y - 7}
          textAnchor="middle"
          style={{ fill: stroke(d) }}
        >
          Z
        </text>
      )}
      {text && at && (
        <EdgeLabelRenderer>
          <div
            className="fk-label nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)`,
              borderColor: stroke(d),
            }}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export function FkEdge(props: EdgeProps<FkEdgeType>) {
  const d = props.data;
  if (!d) return null;
  const start = {
    x: props.sourceX,
    y: props.sourceY,
    dir: props.sourcePosition === Position.Left ? -1 : 1,
  };
  const end = {
    x: props.targetX,
    y: props.targetY,
    dir: props.targetPosition === Position.Left ? -1 : 1,
  };
  const routed =
    d.route &&
    routedPath(
      d.route,
      { x: props.sourceX, y: props.sourceY },
      { x: props.targetX, y: props.targetY },
    );
  if (routed) return <Line id={props.id} path={routed} d={d} start={start} end={end} />;
  const facing = props.sourcePosition !== props.targetPosition;
  const [path] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 8,
    offset: facing ? 20 : d.outset,
    centerX: facing ? (props.sourceX + props.targetX) / 2 + d.shift : undefined,
  });
  return <Line id={props.id} path={path} d={d} start={start} end={end} />;
}

/** A foreign key to its own table, drawn as a loop on the right of the box. */
export function SelfLoopEdge(props: EdgeProps<FkEdgeType>) {
  const d = props.data;
  if (!d) return null;
  const { sourceX, sourceY, targetX, targetY } = props;
  const start = { x: sourceX, y: sourceY, dir: 1 };
  const end = { x: targetX, y: targetY, dir: 1 };
  if (d.selfPair) {
    // A column paired with itself: a small loop out of its row and back into it.
    const [x, y, r] = [sourceX, sourceY, SMALL_LOOP];
    const path = `M ${x} ${y} C ${x + r} ${y - r / 2}, ${x + r} ${y + r / 2}, ${x} ${y}`;
    return (
      <Line id={props.id} path={path} d={d} start={start} end={end} label={{ x: x + r + 2, y }} />
    );
  }
  const out = Math.max(sourceX, targetX) + d.outset;
  const path = `M ${sourceX} ${sourceY} C ${out} ${sourceY}, ${out} ${targetY}, ${targetX} ${targetY}`;
  return (
    <Line
      id={props.id}
      path={path}
      d={d}
      start={start}
      end={end}
      label={{ x: out - 6, y: (sourceY + targetY) / 2 }}
    />
  );
}
