// The middle of an SVG path and the direction it runs there, for the arrow
// that shows which way a foreign key points. Paths come from React Flow
// (M, L, Q for the rounded corners) and from the self loops (C).

type Point = [number, number];

function sample(d: string): Point[] {
  const tokens = d.match(/[MLQC]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const pts: Point[] = [];
  let i = 0;
  let cmd = '';
  let cur: Point = [0, 0];
  const num = () => Number(tokens[i++]);
  const pair = (): Point => [num(), num()];
  while (i < tokens.length) {
    const tok = tokens[i] as string;
    if (/^[MLQC]$/i.test(tok)) {
      cmd = tok.toUpperCase();
      i++;
    } else if (cmd === 'M' || cmd === 'L') {
      cur = pair();
      pts.push(cur);
    } else if (cmd === 'Q') {
      const [c, e] = [pair(), pair()];
      const s = cur;
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const u = 1 - t;
        pts.push([
          u * u * s[0] + 2 * u * t * c[0] + t * t * e[0],
          u * u * s[1] + 2 * u * t * c[1] + t * t * e[1],
        ]);
      }
      cur = e;
    } else if (cmd === 'C') {
      const [c1, c2, e] = [pair(), pair(), pair()];
      const s = cur;
      for (let k = 1; k <= 16; k++) {
        const t = k / 16;
        const u = 1 - t;
        pts.push([
          u ** 3 * s[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * e[0],
          u ** 3 * s[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * e[1],
        ]);
      }
      cur = e;
    } else {
      i++;
    }
  }
  return pts;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Spot = { x: number; y: number; angle: number };

/**
 * The point nearest the middle of the path that no box covers (boxes are drawn
 * over the lines), with the angle of the path there: where the arrow of a line
 * can be seen. `margin` keeps it clear of the box borders. The middle itself
 * when every point is covered.
 */
export function visiblePoint(d: string, boxes: Rect[], margin = 6): Spot | null {
  const spots = fromMiddle(d);
  const half = { x: margin, y: margin };
  return spots.find((p) => overlap(p, boxes, half) === 0) ?? spots[0] ?? null;
}

/**
 * Where a label of the given half width and height goes on the path: the
 * point nearest the middle where all of it is clear of the boxes, or else the
 * point where it covers the least of them (labels are drawn above the boxes),
 * on a part of the line that shows rather than one behind a box.
 */
export function labelPoint(d: string, boxes: Rect[], half: { x: number; y: number }): Spot | null {
  let best: Spot | null = null;
  let least = Number.POSITIVE_INFINITY;
  const dot = { x: 0.5, y: 0.5 };
  for (const p of fromMiddle(d)) {
    const area = overlap(p, boxes, half) + (overlap(p, boxes, dot) > 0 ? 1e9 : 0);
    if (area === 0) return p;
    if (area < least) {
      least = area;
      best = p;
    }
  }
  return best;
}

/** How much of a thing of half size `half` centered on p lies on the boxes, in px². */
function overlap(p: { x: number; y: number }, boxes: Rect[], half: { x: number; y: number }) {
  let area = 0;
  for (const b of boxes) {
    const w = Math.min(p.x + half.x, b.x + b.width) - Math.max(p.x - half.x, b.x);
    const h = Math.min(p.y + half.y, b.y + b.height) - Math.max(p.y - half.y, b.y);
    if (w > 0 && h > 0) area += w * h;
  }
  return area;
}

/** Points every 4 px along the path, from the middle outwards, both ways. */
function fromMiddle(d: string): Spot[] {
  const pts = sample(d);
  const lens = [0];
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1] as Point, pts[k] as Point];
    lens.push((lens[k - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lens[lens.length - 1] ?? 0;
  if (total === 0) return [];
  const at = (s: number): Spot => {
    let k = 1;
    // The first segment of some length that reaches s.
    while (k < pts.length - 1 && ((lens[k] as number) < s || lens[k] === lens[k - 1])) k++;
    const [a, b] = [pts[k - 1] as Point, pts[k] as Point];
    const len = (lens[k] as number) - (lens[k - 1] as number);
    const f = len === 0 ? 0 : Math.min(Math.max((s - (lens[k - 1] as number)) / len, 0), 1);
    return {
      x: a[0] + (b[0] - a[0]) * f,
      y: a[1] + (b[1] - a[1]) * f,
      angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
    };
  };
  const out: Spot[] = [];
  for (let off = 0; off <= total / 2; off += 4) {
    for (const s of off === 0 ? [total / 2] : [total / 2 - off, total / 2 + off]) out.push(at(s));
  }
  return out;
}

/** Halfway along the path, with the angle (degrees) of the path there. */
export function pathMidpoint(d: string): { x: number; y: number; angle: number } | null {
  const pts = sample(d);
  let total = 0;
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1] as Point, pts[k] as Point];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (total === 0) return null;
  let left = total / 2;
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1] as Point, pts[k] as Point];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    if (left <= len) {
      const f = left / len;
      return {
        x: a[0] + (b[0] - a[0]) * f,
        y: a[1] + (b[1] - a[1]) * f,
        angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
      };
    }
    left -= len;
  }
  return null;
}

/** A polyline with its corners rounded, as an SVG path. */
export function roundedPath(points: Point[], radius = 8): string {
  const [first, ...rest] = points;
  if (!first || rest.length === 0) return '';
  let d = `M ${first[0]},${first[1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1] as Point, points[i] as Point, points[i + 1] as Point];
    const r = Math.min(
      radius,
      Math.hypot(b[0] - a[0], b[1] - a[1]) / 2,
      Math.hypot(c[0] - b[0], c[1] - b[1]) / 2,
    );
    const toward = (p: Point): Point => {
      const len = Math.hypot(p[0] - b[0], p[1] - b[1]) || 1;
      return [b[0] + ((p[0] - b[0]) * r) / len, b[1] + ((p[1] - b[1]) * r) / len];
    };
    const [p, q] = [toward(a), toward(c)];
    d += `L ${p[0]},${p[1]}Q ${b[0]},${b[1]} ${q[0]},${q[1]}`;
  }
  const last = points[points.length - 1] as Point;
  return `${d}L ${last[0]},${last[1]}`;
}

/**
 * A line the automatic layout routed, attached to where its two rows are now:
 * the ends move to the handles, and the segments next to them move along so
 * the corners stay square. Null when that would leave a slanted line.
 */
export function routedPath(
  route: Point[],
  source: { x: number; y: number },
  target: { x: number; y: number },
): string | null {
  const pts = route.map((p) => [p[0], p[1]] as Point);
  const n = pts.length;
  if (n < 2) return null;
  const snap = (end: number, next: number, to: { x: number; y: number }) => {
    const [e, m] = [pts[end] as Point, pts[next] as Point];
    if (next !== end && n > 2) {
      if (Math.abs(m[1] - e[1]) < 1) m[1] = to.y;
      else if (Math.abs(m[0] - e[0]) < 1) m[0] = to.x;
    }
    pts[end] = [to.x, to.y];
  };
  snap(0, 1, source);
  snap(n - 1, n - 2, target);
  if (n === 2 && Math.abs(source.y - target.y) > 1 && Math.abs(source.x - target.x) > 1)
    return null;
  return roundedPath(pts);
}
