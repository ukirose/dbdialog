// The layout of the agent view: a graph of the tables. ELK places the boxes,
// parents to the left of their children, and routes the lines around them at
// right angles; the page draws exactly what comes back, so nothing can land
// on anything. Every line has two ends of its own on the sides of its boxes
// (ELK orders them to cross less, and makes a box taller when many lines end
// on it), so no two lines meet in one point. What else is drawn is laid out
// with them, at the size the browser measured: a column with no foreign key
// is a small box of its own ("column → ?") that its line runs to, and the
// reason a line needs a look is a label ELK makes room for.

import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { ViewTable } from '../../core/view';
import { fkKey } from './colors';
import { cycleClosers } from './elkLayout';

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/** A label: ELK leaves out labels without text, so the text goes along. */
export interface LabelSize extends Size {
  text: string;
}

export interface AgentLine {
  /** fkKey of the foreign key. */
  key: string;
  child: string;
  parent: string;
  /** From the child to the parent, at right angles. */
  points: [number, number][];
  /** It closes a cycle: it runs from left to right, against the others. */
  closesCycle: boolean;
  label: Rect | null;
}

/** A column named like a reference with no foreign key, and the line from its table to "?". */
export interface Stub {
  table: string;
  column: string;
  box: Rect;
  /** From the table to the stub's box. */
  points: [number, number][];
}

export interface AgentScene {
  boxes: Record<string, Rect>;
  lines: AgentLine[];
  stubs: Stub[];
  width: number;
  height: number;
}

export interface Extras {
  /** Columns with no foreign key, and the size of their boxes ("column → ?"). */
  stubs?: { table: string; column: string; size: Size }[];
  /** fkKey → the label of a line that needs a look. */
  labels?: Record<string, LabelSize>;
}

const OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  // Ties go to the order of the file, so the same schema gives the same picture.
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.mergeEdges': 'false',
  // Wide channels between the layers: lines running side by side there are
  // where a reader loses track of one, so they keep 12px apart.
  'elk.spacing.nodeNode': '20',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.edgeNode': '14',
  'elk.layered.spacing.edgeNodeBetweenLayers': '14',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.portPort': '12',
  'elk.spacing.edgeLabel': '4',
  'elk.spacing.labelLabel': '6',
  'elk.spacing.componentComponent': '32',
  'elk.padding': '[top=8,left=8,bottom=8,right=8]',
};

const box = (n: ElkNode): Rect => ({
  x: Math.round(n.x ?? 0),
  y: Math.round(n.y ?? 0),
  width: Math.round(n.width ?? 0),
  height: Math.round(n.height ?? 0),
});

export async function agentLayout(
  tables: ViewTable[],
  /** Each box as the browser drew it: ELK may make it taller to hold the ends of its lines. */
  measured: Record<string, Size>,
  extras: Extras = {},
): Promise<AgentScene> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const byName = new Map(tables.map((t) => [t.name, t]));
  const ids = new Map(tables.map((t, i) => [t.name, `n${i}`]));
  const ports = new Map<string, ElkPort[]>(tables.map((t) => [t.name, []]));
  const end = (table: string, side: 'WEST' | 'EAST'): string => {
    const list = ports.get(table) ?? [];
    const id = `${ids.get(table)}p${list.length}`;
    list.push({ id, width: 2, height: 2, layoutOptions: { 'elk.port.side': side } });
    return id;
  };

  // Parents go left of their children: a line runs from the parent's right to
  // the child's left. A key closing a cycle cannot (one of the two tables has
  // to be on the right), so it leaves its child on the right and enters the
  // parent on the left. A key to its own table loops on the right.
  const closers = cycleClosers(tables);
  const edges: ElkExtendedEdge[] = [];
  const lines = new Map<string, Omit<AgentLine, 'points' | 'label'> & { flip: boolean }>();
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const parent = byName.get(fk.refTable);
      // Not drawn: a table outside the picture, or a REFERENCES MySQL ignores.
      if (!parent || fk.origin !== 'table') continue;
      const key = fkKey(t.name, fk.id);
      const self = parent === t;
      const closes = closers.has(key);
      const [source, target] = self
        ? [end(t.name, 'EAST'), end(t.name, 'EAST')]
        : closes
          ? [end(t.name, 'EAST'), end(parent.name, 'WEST')]
          : [end(parent.name, 'EAST'), end(t.name, 'WEST')];
      const id = `x${edges.length}`;
      const label = extras.labels?.[key];
      edges.push({
        id,
        sources: [source],
        targets: [target],
        labels: label
          ? [
              {
                id: `${id}l`,
                text: label.text,
                width: label.width,
                height: label.height,
                layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' },
              },
            ]
          : [],
      });
      lines.set(id, {
        key,
        child: t.name,
        parent: parent.name,
        closesCycle: closes,
        flip: !self && !closes,
      });
    }
  }

  // A column with no foreign key points at "?": a box of its own on the
  // parents' side, like the parent it does not have.
  const stubs = (extras.stubs ?? []).filter((s) => byName.has(s.table));
  const stubNodes: ElkNode[] = stubs.map((s, i) => {
    edges.push({ id: `y${i}`, sources: [`s${i}e`], targets: [end(s.table, 'WEST')] });
    return {
      id: `s${i}`,
      width: s.size.width,
      height: s.size.height,
      ports: [{ id: `s${i}e`, width: 2, height: 2, layoutOptions: { 'elk.port.side': 'EAST' } }],
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
    };
  });

  const children: ElkNode[] = [
    ...tables.map((t) => {
      const m = measured[t.name] ?? { width: 160, height: 40 };
      return {
        id: ids.get(t.name) ?? '',
        width: m.width,
        height: m.height,
        ports: ports.get(t.name) ?? [],
        layoutOptions: {
          'elk.portConstraints': 'FIXED_SIDE',
          'elk.portAlignment.default': 'CENTER',
          'elk.nodeSize.constraints': '[PORTS, MINIMUM_SIZE]',
          'elk.nodeSize.minimum': `(${m.width},${m.height})`,
        },
      };
    }),
    ...stubNodes,
  ];

  const graph: ElkNode = await new ELK().layout({
    id: 'root',
    layoutOptions: OPTIONS,
    children,
    edges,
  });

  const names = new Map([...ids].map(([name, id]) => [id, name]));
  const placed = new Map((graph.children ?? []).map((c) => [c.id, c]));
  const boxes: Record<string, Rect> = {};
  for (const c of graph.children ?? []) {
    const name = names.get(c.id);
    if (name) boxes[name] = box(c);
  }
  const route = (e: ElkExtendedEdge): [number, number][] => {
    const s = e.sections?.[0];
    if (!s) return [];
    return [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(
      (q) => [Math.round(q.x), Math.round(q.y)] as [number, number],
    );
  };
  const out: AgentLine[] = [];
  const outStubs: Stub[] = [];
  for (const e of graph.edges ?? []) {
    const points = route(e);
    if (points.length === 0) continue;
    const line = lines.get(e.id);
    if (line) {
      // Drawn from the child to the parent, like every foreign key line.
      if (line.flip) points.reverse();
      const { flip: _, ...rest } = line;
      const l = e.labels?.[0];
      const label =
        l && l.x !== undefined && l.y !== undefined
          ? { x: Math.round(l.x), y: Math.round(l.y), width: l.width ?? 0, height: l.height ?? 0 }
          : null;
      out.push({ ...rest, points, label });
      continue;
    }
    const i = Number(e.id.slice(1));
    const stub = e.id.startsWith('y') ? stubs[i] : undefined;
    const node = placed.get(`s${i}`);
    if (stub && node) {
      outStubs.push({
        table: stub.table,
        column: stub.column,
        box: box(node),
        points: points.reverse(),
      });
    }
  }
  return { boxes, lines: out, stubs: outStubs, width: graph.width ?? 0, height: graph.height ?? 0 };
}

export interface PictureChecks {
  /** Boxes and labels drawn on top of each other. */
  overlaps: number;
  /** Lines passing behind a box. */
  behind: number;
}

const apart = (a: Rect, b: Rect) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

/** Like apart, but a segment of no width or height still counts as inside. */
const apartOpen = (s: Rect, b: Rect) =>
  s.x + s.width < b.x || b.x + b.width < s.x || s.y + s.height < b.y || b.y + b.height < s.y;

/**
 * Checks the picture keeps what the layout promises, so an agent can trust
 * that nothing is hidden: no two boxes or labels overlap, and no line passes
 * behind a box (lines end on the edge of their boxes, so the inside is shrunk
 * by 2px before testing).
 */
export function pictureChecks(scene: AgentScene): PictureChecks {
  const boxes = [...Object.values(scene.boxes), ...scene.stubs.map((s) => s.box)];
  const things = [...boxes, ...scene.lines.flatMap((l) => (l.label ? [l.label] : []))];
  let overlaps = 0;
  things.forEach((a, i) => {
    for (const b of things.slice(i + 1)) if (!apart(a, b)) overlaps++;
  });
  const inner = boxes.map((b) => ({
    x: b.x + 2,
    y: b.y + 2,
    width: b.width - 4,
    height: b.height - 4,
  }));
  let behind = 0;
  for (const points of [...scene.lines, ...scene.stubs].map((l) => l.points)) {
    const crosses = points.slice(1).some((p, k) => {
      const q = points[k] as [number, number];
      const seg = {
        x: Math.min(p[0], q[0]),
        y: Math.min(p[1], q[1]),
        width: Math.abs(p[0] - q[0]),
        height: Math.abs(p[1] - q[1]),
      };
      return inner.some((b) => !apartOpen(seg, b));
    });
    if (crosses) behind++;
  }
  return { overlaps, behind };
}
