// Splits a SQL file into statements the way the mysql client does: it scans
// characters, skips quotes and comments, and honors the DELIMITER command.

import {
  blockCommentEnd,
  isDashCommentAt,
  isWhitespaceCode,
  lineCommentEnd,
  quotedEnd,
} from './lexer';
import type { Span } from './model';

export interface RawStatement {
  kind: 'sql' | 'delimiter_command';
  /** First character of the statement (never whitespace or a plain comment). */
  start: number;
  /** Where the delimiter starts, or the end of the file for the last statement. */
  end: number;
  delimiter: Span | null;
}

const DELIMITER_RE = /delimiter[ \t]+(\S+)/iy;

export function splitStatements(src: string): RawStatement[] {
  const out: RawStatement[] = [];
  const n = src.length;
  let delim = ';';
  let i = 0;
  let stmtStart = -1;

  while (i < n) {
    const c = src.charCodeAt(i);
    if (isWhitespaceCode(c) || (i === 0 && c === 0xfeff)) {
      i++;
      continue;
    }
    if (stmtStart < 0) {
      DELIMITER_RE.lastIndex = i;
      const m = DELIMITER_RE.exec(src);
      if (m?.[1]) {
        const end = lineCommentEnd(src, i, n);
        out.push({ kind: 'delimiter_command', start: i, end, delimiter: null });
        delim = m[1];
        i = end;
        continue;
      }
    }
    if (c === 0x23 /* # */ || isDashCommentAt(src, i, n)) {
      i = lineCommentEnd(src, i, n);
      continue;
    }
    if (c === 0x2f /* / */ && src[i + 1] === '*') {
      // A versioned comment (/*! … */) is executed by MySQL, so it can be a statement by itself.
      if (src[i + 2] === '!' && stmtStart < 0) stmtStart = i;
      i = blockCommentEnd(src, i, n);
      continue;
    }
    if (src.startsWith(delim, i)) {
      if (stmtStart >= 0) {
        out.push({
          kind: 'sql',
          start: stmtStart,
          end: i,
          delimiter: { start: i, end: i + delim.length },
        });
      }
      stmtStart = -1;
      i += delim.length;
      continue;
    }
    if (stmtStart < 0) stmtStart = i;
    if (c === 0x27 || c === 0x22) {
      i = quotedEnd(src, i, n, true);
    } else if (c === 0x60) {
      i = quotedEnd(src, i, n, false);
    } else {
      i++;
    }
  }
  if (stmtStart >= 0) out.push({ kind: 'sql', start: stmtStart, end: n, delimiter: null });
  return out;
}
