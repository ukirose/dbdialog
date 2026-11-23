// Text edits and the small amount of layout knowledge needed to insert or
// remove a line the way the file already writes things.

import type { Schema, Span, TableDef } from './model';
import { displayWidth } from './sqltext';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(src: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  let limit = Number.POSITIVE_INFINITY;
  for (const e of sorted) {
    if (e.end > limit) throw new Error(`overlapping edits at ${e.start}`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

export function lineStart(src: string, pos: number): number {
  return src.lastIndexOf('\n', pos - 1) + 1;
}

/** Position of the line break that ends the line holding pos ("\r\n" counts as one break). */
export function lineEnd(src: string, pos: number): number {
  const nl = src.indexOf('\n', pos);
  if (nl < 0) return src.length;
  return nl > 0 && src[nl - 1] === '\r' && nl - 1 >= pos ? nl - 1 : nl;
}

export function nextLineStart(src: string, pos: number): number {
  const nl = src.indexOf('\n', pos);
  return nl < 0 ? src.length : nl + 1;
}

export function onlySpaces(src: string, a: number, b: number): boolean {
  return /^[ \t]*$/.test(src.slice(a, b));
}

/** True when from pos to the end of the line there is only blank space and comments. */
export function restOfLineIsTrivia(src: string, pos: number): boolean {
  const rest = src.slice(pos, lineEnd(src, pos));
  return /^[ \t]*((--(\s.*)?|#.*|\/\*.*\*\/[ \t]*))?$/.test(rest);
}

function isCommentLine(line: string): boolean {
  return /^[ \t]*(--(\s|$)|#|\/\*.*\*\/[ \t]*$)/.test(line);
}

/**
 * Start of the full-line comments directly above the line starting at ls
 * (a blank line ends the block). Never goes above `floor`.
 */
export function attachedCommentStart(src: string, ls: number, floor: number): number {
  let start = ls;
  while (start > floor) {
    const prevStart = lineStart(src, start - 1);
    if (prevStart < floor) break;
    const line = src.slice(prevStart, start).replace(/\r?\n$/, '');
    if (!isCommentLine(line)) break;
    start = prevStart;
  }
  return start;
}

export interface Style {
  nl: string;
  upper: boolean;
  quoteAll: boolean;
  listSep: string;
  refSpace: boolean;
  uniqueWord: string;
  generatedAlways: boolean;
  optionEquals: boolean;
}

/** Reads how the file writes things, so that inserted text looks like its neighbors. */
export function detectStyle(schema: Schema): Style {
  const src = schema.source;
  const crlf = (src.match(/\r\n/g) ?? []).length;
  const lf = (src.match(/\n/g) ?? []).length - crlf;
  let upper = 0;
  let lower = 0;
  let quoted = 0;
  let bare = 0;
  let tight = 0;
  let spaced = 0;
  let refSpace = 0;
  let refTight = 0;
  const uniqueWords: Record<string, number> = {};
  let always = false;
  let eq = 0;
  let noEq = 0;
  for (const t of schema.tables) {
    const kw = src.slice(t.stmt.start, t.stmt.start + 6);
    if (kw === 'CREATE') upper++;
    else if (kw === 'create') lower++;
    for (const c of t.columns) {
      if (c.nameIdent.quoted) quoted++;
      else bare++;
      if (c.generated?.always) always = true;
    }
    const lists = [...t.keys, ...t.foreignKeys, ...(t.primaryKey ? [t.primaryKey] : [])].map(
      (k) => k.columns,
    );
    for (const l of lists) {
      if (l.parts.length < 2) continue;
      const text = src.slice(l.span.start, l.span.end);
      if (/,\S/.test(text)) tight++;
      else spaced++;
    }
    for (const fk of t.foreignKeys) {
      if (!fk.ref.columns) continue;
      if (/\s/.test(src.slice(fk.ref.table.span.end, fk.ref.columns.span.start))) refSpace++;
      else refTight++;
    }
    for (const k of t.keys) {
      if (k.kind !== 'unique' || k.origin !== 'table') continue;
      const m = /^(?:CONSTRAINT\s+\S+\s+)?(UNIQUE(?:\s+(?:KEY|INDEX))?)/i.exec(
        src.slice(k.span.start, k.span.end),
      );
      const w = m?.[1]?.toUpperCase().replace(/\s+/g, ' ');
      if (w) uniqueWords[w] = (uniqueWords[w] ?? 0) + 1;
    }
    for (const o of t.options) {
      if (o.hasEquals) eq++;
      else noEq++;
    }
  }
  const uniqueWord =
    Object.entries(uniqueWords).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNIQUE KEY';
  return {
    nl: crlf > lf ? '\r\n' : '\n',
    upper: upper >= lower,
    quoteAll: quoted > bare,
    listSep: tight > spaced ? ',' : ', ',
    refSpace: refSpace >= refTight,
    uniqueWord,
    generatedAlways: always,
    optionEquals: eq >= noEq,
  };
}

/** Keyword in the file's case. */
export function kw(style: Style, words: string): string {
  return style.upper ? words.toUpperCase() : words.toLowerCase();
}

export function indentOf(src: string, s: Span): string | null {
  const ls = lineStart(src, s.start);
  return onlySpaces(src, ls, s.start) ? src.slice(ls, s.start) : null;
}

/**
 * The display column where types start when the column definitions are
 * aligned (as in "id   BIGINT" / "name VARCHAR"; East Asian characters count two), or null.
 */
export function typeColumn(src: string, t: TableDef): number | null {
  const counts = new Map<number, number>();
  let padded = 0;
  for (const c of t.columns) {
    const ls = lineStart(src, c.span.start);
    const before = src.slice(ls, c.type.span.start);
    if (before.includes('\t') || !onlySpaces(src, ls, c.span.start)) continue;
    const col = displayWidth(before);
    counts.set(col, (counts.get(col) ?? 0) + 1);
    if (src.slice(c.nameIdent.span.end, c.type.span.start).length > 1) padded++;
  }
  if (padded === 0) return null;
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

/** Spaces after a column name so that its type starts at `col` (at least one). */
export function padTo(indent: string, nameText: string, col: number | null): string {
  if (col === null) return ' ';
  return ' '.repeat(Math.max(1, col - displayWidth(indent + nameText)));
}
