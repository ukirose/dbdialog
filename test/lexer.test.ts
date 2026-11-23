import { describe, expect, it } from 'vitest';
import { lex } from '../src/core/lexer';
import { splitStatements } from '../src/core/statements';
import { FIXTURES, fixture } from './helpers';

const kinds = (src: string) => lex(src).map((t) => `${t.kind}:${t.text}`);

describe('lex', () => {
  it.each(FIXTURES)('covers every character of %s (lossless)', (name) => {
    const src = fixture(name);
    const toks = lex(src);
    expect(toks.map((t) => t.text).join('')).toBe(src);
    for (let i = 1; i < toks.length; i++) expect(toks[i]?.start).toBe(toks[i - 1]?.end);
  });

  it('reads Japanese names without quotes, as MySQL does (U+0080..U+FFFF)', () => {
    expect(kinds('作家ID BIGINT')).toEqual(['ident:作家ID', 'ws: ', 'ident:BIGINT']);
  });

  it('treats -- as a comment only when a space follows', () => {
    expect(kinds('a -- note')).toEqual(['ident:a', 'ws: ', 'comment:-- note']);
    expect(kinds('a--b')).toEqual(['ident:a', 'op:-', 'op:-', 'ident:b']);
    expect(kinds('# note\nx')).toEqual(['comment:# note', 'ws:\n', 'ident:x']);
  });

  it('reads quoted names and strings with their escapes', () => {
    expect(kinds('`a``b`')).toEqual(['qident:`a``b`']);
    expect(kinds("'it''s \\' ok'")).toEqual(["string:'it''s \\' ok'"]);
    expect(kinds("N'x' X'0F' b'01'")).toEqual([
      "string:N'x'",
      'ws: ',
      "string:X'0F'",
      'ws: ',
      "string:b'01'",
    ]);
  });

  it('tells numbers from names that start with digits', () => {
    expect(kinds('1e5 1abc 0x1F 0xZZ 1.5')).toEqual([
      'number:1e5',
      'ws: ',
      'ident:1abc',
      'ws: ',
      'number:0x1F',
      'ws: ',
      'ident:0xZZ',
      'ws: ',
      'number:1.5',
    ]);
  });

  it('keeps versioned comments apart from plain comments', () => {
    expect(kinds('/*!80016 NOT ENFORCED */ /* x */')).toEqual([
      'exec_comment:/*!80016 NOT ENFORCED */',
      'ws: ',
      'comment:/* x */',
    ]);
  });
});

describe('splitStatements', () => {
  it('ignores delimiters inside strings, names and comments', () => {
    const src =
      "CREATE TABLE a (x VARCHAR(5) DEFAULT ';'); -- ; here\nCREATE TABLE `b;` (y INT); /* ; */";
    const st = splitStatements(src);
    expect(st.map((s) => src.slice(s.start, s.end))).toEqual([
      "CREATE TABLE a (x VARCHAR(5) DEFAULT ';')",
      'CREATE TABLE `b;` (y INT)',
    ]);
  });

  it('follows the DELIMITER command like the mysql client', () => {
    const src = fixture('edge-cases.sql');
    const st = splitStatements(src);
    expect(st[0]?.kind).toBe('delimiter_command');
    const trigger = st[1];
    expect(trigger && src.slice(trigger.start, trigger.end)).toMatch(/^create trigger .* end$/);
    expect(trigger?.delimiter && src.slice(trigger.delimiter.start, trigger.delimiter.end)).toBe(
      '//',
    );
    expect(st[2]?.kind).toBe('delimiter_command');
    expect(st[3] && src.slice(st[3].start, st[3].start + 12)).toBe('create table');
  });

  it('keeps a last statement without a delimiter', () => {
    const st = splitStatements('CREATE TABLE a (x INT)\n');
    expect(st).toHaveLength(1);
    expect(st[0]?.delimiter).toBeNull();
  });
});
