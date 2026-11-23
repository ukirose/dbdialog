// What the user has selected on the diagram, as a place in the file, so the
// coding agent they are talking to can be told (`dbdialog hook`), the way an
// editor tells it about selected lines.

import type { Schema, Span } from './model';
import { positionOf } from './view';

/** A table chosen on the diagram, with one of its columns or foreign keys, if any. */
export interface Selection {
  table: string;
  column: string | null;
  fkId: string | null;
}

/** The selection in the file: what it is, its whole lines, and their text. */
export interface SelectionSpot {
  label: string;
  /** 1-based, inclusive. */
  lines: [number, number];
  text: string;
}

const lower = (s: string) => s.toLowerCase();

export function selectionSpot(schema: Schema, sel: Selection): SelectionSpot | null {
  const t = schema.tables.find((x) => x.name === sel.table);
  if (!t) return null;
  let span: Span = { start: t.stmt.start, end: t.stmt.delimiter?.end ?? t.stmt.end };
  let label = `table ${t.name}`;
  const fk = sel.fkId ? t.foreignKeys.find((f) => f.id === sel.fkId) : undefined;
  const column = sel.column
    ? t.columns.find((c) => lower(c.name) === lower(sel.column as string))
    : undefined;
  if (fk) {
    const cols = fk.columns.parts.map((p) => p.column ?? '').join(', ');
    const refCols = fk.ref.columns?.parts.map((p) => p.column ?? '').join(', ') ?? '';
    span = fk.span;
    label = `foreign key (${cols}) → ${fk.ref.table.name} (${refCols}) of table ${t.name}`;
  } else if (column) {
    span = column.span;
    label = `column ${column.name} of table ${t.name}`;
  }
  const src = schema.source;
  // Whole lines, as an editor selection would show them.
  const from = src.lastIndexOf('\n', span.start - 1) + 1;
  const newline = src.indexOf('\n', Math.max(span.end - 1, span.start));
  const to = newline < 0 ? src.length : newline;
  return {
    label,
    lines: [
      positionOf(src, span.start).line,
      positionOf(src, Math.max(span.end - 1, span.start)).line,
    ],
    text: src.slice(from, to),
  };
}

/** What the agent is told, with the file's path as the session sees it. */
export function describeSelection(spot: SelectionSpot, path: string): string {
  const [a, b] = spot.lines;
  const where = a === b ? `line ${a}` : `lines ${a}-${b}`;
  return `Selected in DBdialog: ${path} ${where} (${spot.label})\n\`\`\`sql\n${spot.text}\n\`\`\`\n`;
}
