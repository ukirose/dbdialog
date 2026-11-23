// Line ends, one set per foreign key color. A line runs from the child (the
// table with the foreign key) to the parent; "auto-start-reverse" turns the
// same marker around at the start, so each end faces its table.
//
// IE (crow's feet), the symbol next to the box is the most, the other the least:
//   one        ||   exactly one parent
//   zeroOrOne  o|   no parent or one (a nullable foreign key); at the child: one at most
//   zeroOrMany o<   any number of children
// IDEF1X (FIPS PUB 184, 3.5.2):
//   dot        ●    the child end: zero, one or more ("Z" beside it: zero or one)
//   diamond    ◇    the parent end of an optional relationship (a nullable foreign key)

import { FK_PALETTE, fkColor } from './colors';

export type EndKind = 'one' | 'zeroOrOne' | 'zeroOrMany' | 'dot' | 'diamond';

const KINDS: EndKind[] = ['one', 'zeroOrOne', 'zeroOrMany', 'dot', 'diamond'];

/** `color`: a palette index, or null for the neutral ends of the legend. */
export const markerId = (kind: EndKind, color: number | null) =>
  `dbd-${kind}-${color === null ? 'muted' : color % FK_PALETTE.length}`;

function End({ id, kind, stroke }: { id: string; kind: EndKind; stroke: string }) {
  const s = { stroke, strokeWidth: 1.5, fill: 'none' };
  const ring = { stroke, strokeWidth: 1.5, fill: 'var(--bgColor-inset)' };
  return (
    <marker
      id={id}
      viewBox="0 0 18 16"
      refX="18"
      refY="8"
      markerWidth="18"
      markerHeight="16"
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      {kind === 'one' && <path d="M 10 2 L 10 14 M 14 2 L 14 14" style={s} />}
      {kind === 'zeroOrOne' && (
        <>
          <circle cx="7" cy="8" r="3.5" style={ring} />
          <path d="M 14 2 L 14 14" style={s} />
        </>
      )}
      {kind === 'zeroOrMany' && (
        <>
          <circle cx="5" cy="8" r="3.5" style={ring} />
          <path d="M 10 8 L 18 2 M 10 8 L 18 14 M 10 8 L 18 8" style={s} />
        </>
      )}
      {kind === 'dot' && <circle cx="13.5" cy="8" r="3.75" style={{ fill: stroke }} />}
      {kind === 'diamond' && <path d="M 4 8 L 10 4 L 16 8 L 10 12 Z" style={ring} />}
    </marker>
  );
}

export function Markers() {
  const colors: (number | null)[] = [...FK_PALETTE.map((_, i) => i), null];
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {colors.map((c) =>
          KINDS.map((k) => (
            <End
              key={markerId(k, c)}
              id={markerId(k, c)}
              kind={k}
              stroke={c === null ? 'var(--fgColor-muted)' : fkColor(c)}
            />
          )),
        )}
      </defs>
    </svg>
  );
}
