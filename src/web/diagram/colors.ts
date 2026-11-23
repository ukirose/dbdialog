// One color per foreign key, so that the columns of a composite key and its
// lines read as one group. Colors come from Primer's data visualization
// palette; green, red and yellow are left out because the diff highlight uses them.

import type { ViewTable } from '../../core/view';

export const FK_PALETTE = [
  'blue',
  'orange',
  'purple',
  'teal',
  'pink',
  'olive',
  'coral',
  'plum',
  'pine',
  'brown',
  'auburn',
  'lime',
] as const;

/**
 * The agent view draws a line closing a cycle in red, so its lines take no
 * reddish color: in reading tests an agent took a coral line for a red one.
 */
export const AGENT_PALETTE = FK_PALETTE.filter((c) => c !== 'coral' && c !== 'auburn');

export const agentColor = (i: number) =>
  `var(--data-${AGENT_PALETTE[i % AGENT_PALETTE.length]}-color-emphasis)`;

export const fkColor = (i: number) =>
  `var(--data-${FK_PALETTE[i % FK_PALETTE.length]}-color-emphasis)`;
export const fkMuted = (i: number) =>
  `var(--data-${FK_PALETTE[i % FK_PALETTE.length]}-color-muted)`;

export const fkKey = (table: string, fkId: string) => `${table}\u0000${fkId}`;

/**
 * Greedy coloring: each foreign key takes the first color that no other
 * foreign key of its two tables uses yet. Inline REFERENCES (ignored by
 * MySQL) get no color; they are drawn as warnings.
 */
export function assignFkColors(
  tables: ViewTable[],
  colors: number = FK_PALETTE.length,
): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Map<string, Set<number>>();
  const usedBy = (table: string) => {
    let s = used.get(table);
    if (!s) {
      s = new Set();
      used.set(table, s);
    }
    return s;
  };
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (fk.origin !== 'table') continue;
      const taken = new Set([...usedBy(t.name), ...usedBy(fk.refTable)]);
      let color = 0;
      while (taken.has(color) && color < colors) color++;
      if (color === colors) color = out.size % colors;
      out.set(fkKey(t.name, fk.id), color);
      usedBy(t.name).add(color);
      usedBy(fk.refTable).add(color);
    }
  }
  return out;
}
