// Lossless MySQL lexer: the tokens of a range cover every character of it,
// whitespace and comments included, so any span can be rewritten in place.

export type TokenKind =
  | 'ws'
  | 'comment' // -- …  # …  /* … */
  | 'exec_comment' // /*! … */ — MySQL runs its content; we keep it as text
  | 'ident'
  | 'qident' // `quoted identifier`
  | 'string' // '…'  "…"  N'…'  X'…'  B'…'
  | 'number'
  | 'punct' // ( ) , ; .
  | 'op'
  | 'var' // @user_var  @@system_var
  | 'unknown';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
}

export function isTrivia(t: Token): boolean {
  return t.kind === 'ws' || t.kind === 'comment' || t.kind === 'exec_comment';
}

export function isWhitespaceCode(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
}

// MySQL: unquoted identifiers may use [0-9a-zA-Z$_] and U+0080..U+FFFF.
// Surrogate halves are excluded, so characters beyond U+FFFF end an identifier.
export function isIdentPartCode(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f ||
    c === 0x24 ||
    (c >= 0x80 && c <= 0xffff && !(c >= 0xd800 && c <= 0xdfff))
  );
}

/** `--` starts a comment only when a space or control character (or the end) follows. */
export function isDashCommentAt(src: string, i: number, end: number): boolean {
  if (src.charCodeAt(i) !== 0x2d || src.charCodeAt(i + 1) !== 0x2d) return false;
  return i + 2 >= end || src.charCodeAt(i + 2) <= 0x20;
}

/** End of the line comment that starts at i (the newline itself is not part of it). */
export function lineCommentEnd(src: string, i: number, end: number): number {
  let j = i;
  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === 0x0a || c === 0x0d) break;
    j++;
  }
  return j;
}

/** End of the block comment starting at i (`/*`); unterminated comments run to the end. */
export function blockCommentEnd(src: string, i: number, end: number): number {
  const close = src.indexOf('*/', i + 2);
  return close < 0 || close + 2 > end ? end : close + 2;
}

/** End of the quoted text starting at i. Handles doubled quotes and backslash escapes. */
export function quotedEnd(src: string, i: number, end: number, backslash: boolean): number {
  const q = src.charCodeAt(i);
  let j = i + 1;
  while (j < end) {
    const c = src.charCodeAt(j);
    if (backslash && c === 0x5c) {
      j += 2;
      continue;
    }
    if (c === q) {
      if (src.charCodeAt(j + 1) === q && j + 1 < end) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return end;
}

const MULTI_OPS = ['<=>', '->>', '<=', '>=', '<>', '!=', '<<', '>>', '&&', '||', ':=', '->'];
const SINGLE_OPS = '=<>!~^&|+-*/%?:{}';
const NUMBER_RE = /0x[0-9a-fA-F]+|0b[01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

export function lex(src: string, start = 0, end = src.length): Token[] {
  const out: Token[] = [];
  let i = start;
  const push = (kind: TokenKind, s: number, e: number) => {
    out.push({ kind, start: s, end: e, text: src.slice(s, e) });
    i = e;
  };

  while (i < end) {
    const c = src.charCodeAt(i);
    const ch = src[i] as string;

    if (isWhitespaceCode(c) || (i === 0 && c === 0xfeff)) {
      let j = i + 1;
      while (j < end && isWhitespaceCode(src.charCodeAt(j))) j++;
      push('ws', i, j);
      continue;
    }
    if (c === 0x23 /* # */ || isDashCommentAt(src, i, end)) {
      push('comment', i, lineCommentEnd(src, i, end));
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      push(src[i + 2] === '!' ? 'exec_comment' : 'comment', i, blockCommentEnd(src, i, end));
      continue;
    }
    if (ch === "'" || ch === '"') {
      push('string', i, quotedEnd(src, i, end, true));
      continue;
    }
    if (ch === '`') {
      push('qident', i, quotedEnd(src, i, end, false));
      continue;
    }
    // N'…' (national), X'…' (hex), B'…' (bit) string literals
    if (/[nNxXbB]/.test(ch) && src[i + 1] === "'") {
      const backslash = ch === 'n' || ch === 'N';
      push('string', i, quotedEnd(src, i + 1, end, backslash));
      continue;
    }
    if ((c >= 0x30 && c <= 0x39) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      const numEnd = m ? Math.min(i + m[0].length, end) : i + 1;
      // "1abc" or "0xZZ" is an identifier in MySQL: digits may start a name.
      if (m && !m[0].includes('.') && numEnd < end && isIdentPartCode(src.charCodeAt(numEnd))) {
        let j = i;
        while (j < end && isIdentPartCode(src.charCodeAt(j))) j++;
        push('ident', i, j);
      } else {
        push('number', i, numEnd);
      }
      continue;
    }
    if (isIdentPartCode(c)) {
      let j = i + 1;
      while (j < end && isIdentPartCode(src.charCodeAt(j))) j++;
      push('ident', i, j);
      continue;
    }
    if (ch === '@') {
      let j = i + 1;
      if (src[j] === '@') j++;
      if (src[j] === "'" || src[j] === '"' || src[j] === '`') {
        j = quotedEnd(src, j, end, src[j] !== '`');
      } else {
        while (j < end && (isIdentPartCode(src.charCodeAt(j)) || src[j] === '.')) j++;
      }
      push('var', i, j);
      continue;
    }
    if ('(),;.'.includes(ch)) {
      push('punct', i, i + 1);
      continue;
    }
    const multi = MULTI_OPS.find((op) => src.startsWith(op, i) && i + op.length <= end);
    if (multi) {
      push('op', i, i + multi.length);
      continue;
    }
    if (SINGLE_OPS.includes(ch)) {
      push('op', i, i + 1);
      continue;
    }
    // Anything else (for example a character beyond U+FFFF) is kept as one unknown token.
    const cp = src.codePointAt(i) ?? c;
    push('unknown', i, i + (cp > 0xffff ? 2 : 1));
  }
  return out;
}
