// Edit operations sent by the diagram. Each one is applied to the latest text
// by computing the smallest text edits; everything else stays byte for byte.

import {
  applyEdits,
  attachedCommentStart,
  detectStyle,
  indentOf,
  kw,
  lineEnd,
  lineStart,
  nextLineStart,
  onlySpaces,
  padTo,
  restOfLineIsTrivia,
  type Style,
  type TextEdit,
  typeColumn,
} from './edit';
import { isTrivia, lex, type Token } from './lexer';
import type {
  CheckDef,
  ColumnDef,
  CreateDefinition,
  ForeignKeyDef,
  Ident,
  KeyDef,
  KeyPartList,
  RefAction,
  Schema,
  Span,
  TableDef,
} from './model';
import { parseSchema } from './parser';
import { displayWidth, encodeString, quoteIdent, unquoteIdent } from './sqltext';

export interface ColumnSpec {
  name: string;
  type: string;
  nullable?: boolean | null;
  default?: string | null;
  autoIncrement?: boolean;
  comment?: string | null;
  generated?: { expr: string; storage: 'VIRTUAL' | 'STORED' } | null;
}

/** Fields present are changed; null removes the clause. */
export type ColumnPatch = Partial<ColumnSpec>;

export interface FkSpec {
  name?: string | null;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: RefAction | null;
  onUpdate?: RefAction | null;
}

/** Points at a constraint: its id and the source text the diagram saw. */
export interface ItemRef {
  id: string;
  text: string;
}

export type Op =
  | {
      op: 'table.add';
      name: string;
      comment?: string | null;
      columns: ColumnSpec[];
      primaryKey?: string[];
    }
  | { op: 'table.rename'; table: string; to: string }
  | { op: 'table.delete'; table: string; cascade?: boolean }
  | { op: 'table.setComment'; table: string; comment: string | null; expect?: string | null }
  | { op: 'column.add'; table: string; column: ColumnSpec; after?: string | null }
  | { op: 'column.update'; table: string; column: string; set: ColumnPatch; expect?: ColumnPatch }
  | { op: 'column.delete'; table: string; column: string; cascade?: boolean }
  | { op: 'key.setPrimary'; table: string; columns: string[] }
  | {
      op: 'key.add';
      table: string;
      kind: 'unique' | 'index';
      columns: string[];
      name?: string | null;
    }
  | { op: 'key.update'; table: string; target: ItemRef; columns?: string[]; name?: string | null }
  | { op: 'key.delete'; table: string; target: ItemRef }
  | { op: 'fk.add'; table: string; fk: FkSpec }
  | { op: 'fk.update'; table: string; target: ItemRef; fk: Partial<FkSpec> }
  | { op: 'fk.delete'; table: string; target: ItemRef }
  | { op: 'fk.makeTableLevel'; table: string; target: ItemRef }
  | { op: 'check.add'; table: string; expr: string; name?: string | null }
  | { op: 'check.update'; table: string; target: ItemRef; expr?: string; name?: string | null }
  | { op: 'check.delete'; table: string; target: ItemRef };

export type OpErrorCode = 'not-found' | 'conflict' | 'invalid' | 'referenced' | 'exists';

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

type Item = KeyDef | ForeignKeyDef | CheckDef;

/** Text that identifies a constraint; inline ones also carry their column. */
export function itemText(src: string, item: Item): string {
  const text = src.slice(item.span.start, item.span.end);
  return item.origin === 'column' ? `${item.column}\u0000${text}` : text;
}

/** Applies operations one after another; each sees the result of the previous one. */
export function applyOps(src: string, ops: Op[]): string {
  let text = src;
  for (const op of ops) text = applyOp(text, op);
  return text;
}

export function applyOp(src: string, op: Op): string {
  const before = parseSchema(src);
  const ctx = new Ctx(before);
  const result = ctx.run(op);
  const text = typeof result === 'string' ? result : applyEdits(src, result);
  const after = parseSchema(text);
  const errors = (s: Schema) => s.diagnostics.filter((d) => d.severity === 'error').length;
  if (errors(after) > errors(before)) {
    throw new OpError('invalid', 'the edited SQL would not parse', { op: op.op });
  }
  return text;
}

/** Collects edits; inserts at the same position are joined in the given order. */
class Edits {
  private readonly list: TextEdit[] = [];
  private readonly inserts = new Map<number, { order: number; text: string }[]>();

  replace(s: Span, text: string): void {
    this.list.push({ start: s.start, end: s.end, text });
  }
  remove(s: Span): void {
    this.list.push({ start: s.start, end: s.end, text: '' });
  }
  insert(pos: number, text: string, order = 0): void {
    const at = this.inserts.get(pos) ?? [];
    at.push({ order, text });
    this.inserts.set(pos, at);
  }
  build(): TextEdit[] {
    const out = [...this.list];
    for (const [pos, items] of this.inserts) {
      items.sort((a, b) => a.order - b.order);
      out.push({ start: pos, end: pos, text: items.map((i) => i.text).join('') });
    }
    return out;
  }
}

// Canonical order of column attributes, used to pick where a new one goes.
const ATTR_ORDER = {
  collate: 0,
  generated: 1,
  nullable: 2,
  default: 3,
  onUpdate: 4,
  autoIncrement: 5,
  unique: 6,
  primaryKey: 7,
  comment: 8,
} as const;
type AttrName = keyof typeof ATTR_ORDER;

const MAX_NAME = 64;

class Ctx {
  readonly src: string;
  readonly style: Style;

  constructor(readonly schema: Schema) {
    this.src = schema.source;
    this.style = detectStyle(schema);
  }

  // ---- lookups ----

  table(name: string): TableDef {
    const t = this.schema.tables.find((x) => sameName(x.name, name));
    if (!t) throw new OpError('not-found', `table ${name} not found`, { table: name });
    return t;
  }
  column(t: TableDef, name: string): ColumnDef {
    const c = t.columns.find((x) => sameName(x.name, name));
    if (!c)
      throw new OpError('not-found', `column ${t.name}.${name} not found`, {
        table: t.name,
        column: name,
      });
    return c;
  }
  find<T extends Item>(items: T[], ref: ItemRef): T {
    const same = items.filter((i) => itemText(this.src, i) === ref.text);
    const hit = same.length > 1 ? (same.find((i) => i.id === ref.id) ?? same[0]) : same[0];
    if (!hit)
      throw new OpError('conflict', 'the constraint changed since it was shown', { id: ref.id });
    return hit;
  }
  defIndex(t: TableDef, def: CreateDefinition): number {
    const i = t.defs.indexOf(def);
    if (i < 0) throw new OpError('invalid', 'not a table-level definition');
    return i;
  }

  // ---- text helpers ----

  kw(words: string): string {
    return kw(this.style, words);
  }
  name(name: string, like?: { quoted: boolean } | null): string {
    checkName(name);
    return quoteIdent(name, like ? like.quoted : this.style.quoteAll);
  }
  list(names: string[], old?: KeyPartList | null): string {
    const parts = names.map((n) => {
      const prev = old?.parts.find((p) => p.column !== null && sameName(p.column, n));
      return prev ? this.src.slice(prev.span.start, prev.span.end) : this.name(n);
    });
    return `(${parts.join(this.style.listSep)})`;
  }
  /** Removes a span together with the blank space in front of it. */
  removeSpaced(e: Edits, s: Span): void {
    let start = s.start;
    while (start > 0 && (this.src[start - 1] === ' ' || this.src[start - 1] === '\t')) start--;
    if (start > 0 && this.src[start - 1] !== '\n' && this.src[start - 1] !== '\r') {
      e.remove({ start, end: s.end });
      return;
    }
    let end = s.end;
    while (this.src[end] === ' ' || this.src[end] === '\t') end++;
    e.remove({ start: s.start, end });
  }
  /** Tokens (without trivia) of a span. */
  tokens(s: Span): Token[] {
    return lex(this.src, s.start, s.end).filter((t) => !isTrivia(t));
  }

  // ---- definitions inside CREATE TABLE ( … ) ----

  /** Inserts a definition after defs[after] (or as the last one), on its own line when the table is laid out that way. */
  insertDef(e: Edits, t: TableDef, after: number | null, text: string): void {
    const src = this.src;
    const idx = after ?? t.defs.length - 1;
    const prev = t.defs[idx];
    if (!prev) {
      e.insert(t.open + 1, text);
      return;
    }
    const isLast = idx === t.defs.length - 1;
    const indent = indentOf(src, prev.span);
    if (indent !== null) {
      if (!isLast) {
        const comma = t.commas[idx] as number;
        const next = t.defs[idx + 1] as CreateDefinition;
        if (lineStart(src, next.span.start) > comma) {
          e.insert(nextLineStart(src, comma), `${indent}${text},${this.style.nl}`);
          return;
        }
      } else if (t.close > lineEnd(src, prev.span.end)) {
        e.insert(prev.span.end, ',');
        e.insert(lineEnd(src, prev.span.end), `${this.style.nl}${indent}${text}`, 1);
        return;
      } else {
        e.insert(prev.span.end, `,${this.style.nl}${indent}${text}`);
        return;
      }
    }
    e.insert(prev.span.end, `${this.style.listSep}${text}`);
  }

  removeDef(e: Edits, t: TableDef, def: CreateDefinition): void {
    const src = this.src;
    const idx = this.defIndex(t, def);
    if (t.defs.length === 1) throw new OpError('invalid', 'a table needs at least one definition');
    const isLast = idx === t.defs.length - 1;
    const ls = lineStart(src, def.span.start);
    const afterEnd = isLast ? def.span.end : (t.commas[idx] as number) + 1;
    if (onlySpaces(src, ls, def.span.start) && restOfLineIsTrivia(src, afterEnd)) {
      const floor = idx > 0 ? (t.commas[idx - 1] as number) + 1 : t.open + 1;
      const start = Math.max(attachedCommentStart(src, ls, floor), floor);
      e.remove({ start, end: nextLineStart(src, afterEnd) });
      if (isLast) {
        const comma = t.commas[idx - 1] as number;
        e.remove({ start: comma, end: comma + 1 });
      }
      return;
    }
    if (!isLast) {
      e.remove({ start: def.span.start, end: (t.defs[idx + 1] as CreateDefinition).span.start });
    } else {
      e.remove({ start: t.commas[idx - 1] as number, end: def.span.end });
    }
  }

  /** Position after the last definition of the given kinds (or the last column). */
  afterLast(t: TableDef, kinds: CreateDefinition['kind'][]): number {
    for (let i = t.defs.length - 1; i >= 0; i--) {
      if (kinds.includes((t.defs[i] as CreateDefinition).kind)) return i;
    }
    for (let i = t.defs.length - 1; i >= 0; i--) {
      if ((t.defs[i] as CreateDefinition).kind === 'column') return i;
    }
    return t.defs.length - 1;
  }

  // ---- column attributes ----

  presentAttrs(c: ColumnDef): { name: AttrName; span: Span }[] {
    const out: { name: AttrName; span: Span }[] = [];
    if (c.collate) out.push({ name: 'collate', span: c.collate.span });
    if (c.generated) out.push({ name: 'generated', span: c.generated.span });
    if (c.nullable) out.push({ name: 'nullable', span: c.nullable.span });
    if (c.default) out.push({ name: 'default', span: c.default.span });
    if (c.onUpdate) out.push({ name: 'onUpdate', span: c.onUpdate.span });
    if (c.autoIncrement) out.push({ name: 'autoIncrement', span: c.autoIncrement });
    if (c.unique) out.push({ name: 'unique', span: c.unique });
    if (c.primaryKey) out.push({ name: 'primaryKey', span: c.primaryKey });
    if (c.comment) out.push({ name: 'comment', span: c.comment.span });
    return out;
  }
  /** Where a missing attribute goes: after the last present one that comes before it. */
  anchor(c: ColumnDef, attr: AttrName): number {
    let pos = c.type.span.end;
    for (const a of this.presentAttrs(c)) {
      if (ATTR_ORDER[a.name] < ATTR_ORDER[attr] && a.span.end > pos) pos = a.span.end;
    }
    return pos;
  }
  insertAttr(e: Edits, c: ColumnDef, attr: AttrName, text: string): void {
    e.insert(this.anchor(c, attr), ` ${text}`, ATTR_ORDER[attr]);
  }

  columnText(spec: ColumnSpec, indent: string, typeCol: number | null): string {
    checkFragment(spec.type, 'type');
    const name = this.name(spec.name);
    const parts = [name + padTo(indent, name, typeCol) + spec.type.trim()];
    if (spec.generated) {
      checkFragment(spec.generated.expr, 'expression');
      parts.push(
        `${this.kw(this.style.generatedAlways ? 'GENERATED ALWAYS AS' : 'AS')} (${spec.generated.expr.trim()}) ${this.kw(spec.generated.storage)}`,
      );
    }
    if (spec.nullable === false) parts.push(this.kw('NOT NULL'));
    if (spec.nullable === true) parts.push(this.kw('NULL'));
    if (spec.default != null && !spec.generated) {
      checkFragment(spec.default, 'default');
      parts.push(`${this.kw('DEFAULT')} ${spec.default.trim()}`);
    }
    if (spec.autoIncrement) parts.push(this.kw('AUTO_INCREMENT'));
    if (spec.comment != null) parts.push(`${this.kw('COMMENT')} ${this.lit(spec.comment, 1024)}`);
    return parts.join(' ');
  }
  lit(value: string, max: number, quote: "'" | '"' = "'"): string {
    if ([...value].length > max)
      throw new OpError('invalid', `comment is longer than ${max} characters`, { max });
    return encodeString(value, quote);
  }

  /** Renames the uses of a column inside an expression (CHECK, AS (…), DEFAULT (…)). */
  renameInExpr(e: Edits, s: Span, from: string, to: string): void {
    const toks = this.tokens(s);
    toks.forEach((tok, i) => {
      if (tok.kind !== 'ident' && tok.kind !== 'qident') return;
      if (!sameName(unquoteIdent(tok.text), from)) return;
      const prev = toks[i - 1];
      const next = toks[i + 1];
      if (next?.text === '(' || next?.text === '.' || prev?.text === '.') return;
      e.replace(tok, this.name(to, { quoted: tok.kind === 'qident' }));
    });
  }
  mentions(s: Span, column: string): boolean {
    return this.tokens(s).some(
      (tok, i, all) =>
        (tok.kind === 'ident' || tok.kind === 'qident') &&
        sameName(unquoteIdent(tok.text), column) &&
        all[i + 1]?.text !== '(',
    );
  }

  // ---- operations ----

  run(op: Op): TextEdit[] | string {
    switch (op.op) {
      case 'table.add':
        return this.tableAdd(op);
      case 'table.rename':
        return this.tableRename(op.table, op.to);
      case 'table.delete':
        return this.tableDelete(op.table, op.cascade ?? false);
      case 'table.setComment':
        return this.tableComment(op.table, op.comment, op);
      case 'column.add':
        return this.columnAdd(op.table, op.column, op.after ?? null);
      case 'column.update':
        return this.columnUpdate(op.table, op.column, op.set, op.expect);
      case 'column.delete':
        return this.columnDelete(op.table, op.column, op.cascade ?? false);
      case 'key.setPrimary':
        return this.setPrimary(op.table, op.columns);
      case 'key.add':
        return this.keyAdd(op.table, op.kind, op.columns, op.name ?? null);
      case 'key.update':
        return this.keyUpdate(op.table, op.target, op.columns, op.name);
      case 'key.delete':
        return this.keyDelete(op.table, op.target);
      case 'fk.add':
        return this.fkAdd(op.table, op.fk);
      case 'fk.update':
        return this.fkUpdate(op.table, op.target, op.fk);
      case 'fk.delete':
        return this.fkDelete(op.table, op.target);
      case 'fk.makeTableLevel':
        return this.fkMakeTableLevel(op.table, op.target);
      case 'check.add':
        return this.checkAdd(op.table, op.expr, op.name ?? null);
      case 'check.update':
        return this.checkUpdate(op.table, op.target, op.expr, op.name);
      case 'check.delete':
        return this.checkDelete(op.table, op.target);
    }
  }

  tableAdd(op: Extract<Op, { op: 'table.add' }>): TextEdit[] {
    const { src, style } = this;
    checkName(op.name);
    if (this.schema.tables.some((t) => sameName(t.name, op.name))) {
      throw new OpError('exists', `table ${op.name} already exists`, { table: op.name });
    }
    if (op.columns.length === 0) throw new OpError('invalid', 'a new table needs a column');
    const indent = '  ';
    const width = Math.max(...op.columns.map((c) => displayWidth(this.name(c.name))));
    const lines = op.columns.map(
      (c) =>
        indent +
        this.columnText(c, indent, op.columns.length > 1 ? displayWidth(indent) + width + 1 : null),
    );
    if (op.primaryKey?.length)
      lines.push(`${indent}${this.kw('PRIMARY KEY')} ${this.list(op.primaryKey)}`);
    const last = this.schema.tables[this.schema.tables.length - 1];
    // Reuse the table options the file already writes (ENGINE=…, DEFAULT CHARSET=…), minus COMMENT.
    const options = last
      ? last.options
          .filter((o) => o.name !== 'COMMENT' && o.name !== 'AUTO_INCREMENT')
          .map((o) => src.slice(o.span.start, o.span.end))
      : [];
    if (op.comment != null)
      options.push(
        `${this.kw('COMMENT')}${style.optionEquals ? '=' : ' '}${this.lit(op.comment, 2048)}`,
      );
    const delim = last?.stmt.delimiter
      ? src.slice(last.stmt.delimiter.start, last.stmt.delimiter.end)
      : ';';
    const body = [
      `${this.kw('CREATE TABLE')} ${this.name(op.name)} (`,
      lines.join(`,${style.nl}`),
      `)${options.length ? ` ${options.join(' ')}` : ''}${delim}`,
    ].join(style.nl);
    if (last) {
      const endPos = last.stmt.delimiter?.end ?? last.stmt.contentEnd;
      const at = restOfLineIsTrivia(src, endPos) ? lineEnd(src, endPos) : endPos;
      return [{ start: at, end: at, text: `${style.nl}${style.nl}${body}` }];
    }
    const lead = src === '' ? '' : src.endsWith('\n') ? style.nl : `${style.nl}${style.nl}`;
    return [{ start: src.length, end: src.length, text: `${lead}${body}${style.nl}` }];
  }

  tableRename(from: string, to: string): TextEdit[] {
    const t = this.table(from);
    checkName(to);
    if (!sameName(from, to) && this.schema.tables.some((x) => sameName(x.name, to))) {
      throw new OpError('exists', `table ${to} already exists`, { table: to });
    }
    const e = new Edits();
    e.replace(t.nameIdent.span, this.name(to, t.nameIdent));
    for (const u of this.schema.tables) {
      for (const fk of u.foreignKeys) {
        if (sameName(fk.ref.table.name, t.name))
          e.replace(fk.ref.table.span, this.name(to, fk.ref.table));
      }
    }
    return e.build();
  }

  referencing(t: TableDef, column?: string): { table: TableDef; fk: ForeignKeyDef }[] {
    const out: { table: TableDef; fk: ForeignKeyDef }[] = [];
    for (const u of this.schema.tables) {
      for (const fk of u.foreignKeys) {
        if (!sameName(fk.ref.table.name, t.name)) continue;
        if (u === t && column === undefined) continue; // a self-reference goes away with the table
        if (
          column !== undefined &&
          !fk.ref.columns?.parts.some((p) => p.column && sameName(p.column, column))
        )
          continue;
        out.push({ table: u, fk });
      }
    }
    return out;
  }

  tableDelete(name: string, cascade: boolean): string | TextEdit[] {
    const t = this.table(name);
    const refs = this.referencing(t);
    if (refs.length > 0) {
      if (!cascade) {
        throw new OpError(
          'referenced',
          `table ${t.name} is referenced by ${refs.length} foreign key(s)`,
          {
            table: t.name,
            count: refs.length,
            by: refs.map((r) => r.table.name).join(', '),
          },
        );
      }
      // Drop the foreign keys first, one at a time, then the table.
      let text = this.src;
      for (const r of refs) {
        text = applyOp(text, {
          op: 'fk.delete',
          table: r.table.name,
          target: { id: r.fk.id, text: itemText(this.src, r.fk) },
        });
      }
      return applyOp(text, { op: 'table.delete', table: t.name });
    }
    return [this.removeStatement(t)];
  }

  removeStatement(t: TableDef): TextEdit {
    const src = this.src;
    const idx = this.schema.statements.findIndex((s) => s.span.start === t.stmt.start);
    const prev = this.schema.statements[idx - 1];
    const floor = prev ? (prev.delimiter?.end ?? prev.span.end) : 0;
    const ls = lineStart(src, t.stmt.start);
    let start = onlySpaces(src, ls, t.stmt.start)
      ? Math.max(attachedCommentStart(src, ls, floor), floor)
      : t.stmt.start;
    const endPos = t.stmt.delimiter?.end ?? t.stmt.contentEnd;
    let end = restOfLineIsTrivia(src, endPos) ? nextLineStart(src, endPos) : endPos;
    // Do not leave two blank lines where the table was.
    const blankBefore =
      start >= 1 && /(^|\n)[ \t]*\r?\n$/.test(src.slice(Math.max(0, start - 3), start));
    const blankAfter = /^[ \t]*\r?\n/.exec(src.slice(end));
    if (blankAfter && (blankBefore || start === 0)) end += blankAfter[0].length;
    else if (end >= src.length && blankBefore) start = lineStart(src, start - 1);
    return { start, end, text: '' };
  }

  tableComment(name: string, comment: string | null, op: { expect?: string | null }): TextEdit[] {
    const t = this.table(name);
    if (op.expect !== undefined && (t.comment?.value ?? null) !== op.expect) {
      throw new OpError('conflict', 'the table comment changed since it was shown', {
        table: t.name,
      });
    }
    const e = new Edits();
    if (comment === null) {
      if (!t.comment) return [];
      const opt = t.options.find((o) => o.name === 'COMMENT');
      const i = opt ? t.options.indexOf(opt) : -1;
      const prevOpt = i > 0 ? t.options[i - 1] : undefined;
      if (prevOpt && this.src.slice(prevOpt.span.end, t.comment.span.start).includes(',')) {
        e.remove({ start: prevOpt.span.end, end: t.comment.span.end });
      } else {
        this.removeSpaced(e, t.comment.span);
      }
    } else if (t.comment) {
      e.replace(t.comment.literal.span, this.lit(comment, 2048, t.comment.literal.quote));
    } else {
      const opt = `${this.kw('COMMENT')}${this.style.optionEquals ? '=' : ' '}${this.lit(comment, 2048)}`;
      if (t.tail) e.insert(t.tail.start, `${opt} `);
      else e.insert(t.stmt.contentEnd, ` ${opt}`);
    }
    return e.build();
  }

  columnAdd(tableName: string, spec: ColumnSpec, after: string | null): TextEdit[] {
    const t = this.table(tableName);
    if (t.columns.some((c) => sameName(c.name, spec.name))) {
      throw new OpError('exists', `column ${spec.name} already exists`, {
        table: t.name,
        column: spec.name,
      });
    }
    const anchor = after !== null ? this.column(t, after) : t.columns[t.columns.length - 1];
    const idx = anchor ? this.defIndex(t, anchor) : null;
    const indent = anchor ? (indentOf(this.src, anchor.span) ?? '') : '';
    const e = new Edits();
    this.insertDef(
      e,
      t,
      idx,
      this.columnText(spec, indent, indent ? typeColumn(this.src, t) : null),
    );
    return e.build();
  }

  columnUpdate(
    tableName: string,
    columnName: string,
    set: ColumnPatch,
    expect?: ColumnPatch,
  ): TextEdit[] {
    const t = this.table(tableName);
    const c = this.column(t, columnName);
    if (expect) checkExpect(c, expect);
    const e = new Edits();
    const src = this.src;

    if (set.type !== undefined && set.type.trim() !== c.type.text) {
      checkFragment(set.type, 'type');
      e.replace(c.type.span, set.type.trim());
    }
    if (set.nullable !== undefined) {
      const v = set.nullable;
      if (c.nullable) {
        if (v === null) this.removeSpaced(e, c.nullable.span);
        else if (v !== c.nullable.value)
          e.replace(c.nullable.span, this.kw(v ? 'NULL' : 'NOT NULL'));
      } else if (v !== null) {
        this.insertAttr(e, c, 'nullable', this.kw(v ? 'NULL' : 'NOT NULL'));
      }
    }
    const generated = set.generated !== undefined ? set.generated : c.generated;
    if (set.default !== undefined) {
      const v = set.default;
      if (v !== null) checkFragment(v, 'default');
      if (c.default) {
        if (v === null) this.removeSpaced(e, c.default.span);
        else if (v.trim() !== c.default.text) e.replace(c.default.valueSpan, v.trim());
      } else if (v !== null && !generated) {
        this.insertAttr(e, c, 'default', `${this.kw('DEFAULT')} ${v.trim()}`);
      }
    }
    if (set.autoIncrement !== undefined) {
      if (set.autoIncrement && !c.autoIncrement)
        this.insertAttr(e, c, 'autoIncrement', this.kw('AUTO_INCREMENT'));
      if (!set.autoIncrement && c.autoIncrement) this.removeSpaced(e, c.autoIncrement);
    }
    if (set.comment !== undefined) {
      const v = set.comment;
      if (c.comment) {
        if (v === null) this.removeSpaced(e, c.comment.span);
        else if (v !== c.comment.value)
          e.replace(c.comment.literal.span, this.lit(v, 1024, c.comment.literal.quote));
      } else if (v !== null) {
        this.insertAttr(e, c, 'comment', `${this.kw('COMMENT')} ${this.lit(v, 1024)}`);
      }
    }
    if (set.generated !== undefined) {
      const v = set.generated;
      if (v === null) {
        if (c.generated) this.removeSpaced(e, c.generated.span);
      } else {
        checkFragment(v.expr, 'expression');
        if (c.generated) {
          const inner = trimmedSpan(src, c.generated.exprSpan);
          if (v.expr.trim() !== c.generated.expr) e.replace(inner, v.expr.trim());
          // Without VIRTUAL/STORED, MySQL makes the column VIRTUAL.
          if (v.storage !== (c.generated.storage ?? 'VIRTUAL')) {
            if (c.generated.storageSpan) e.replace(c.generated.storageSpan, this.kw(v.storage));
            else e.insert(c.generated.span.end, ` ${this.kw(v.storage)}`);
          }
        } else {
          // A generated column cannot have DEFAULT, ON UPDATE or AUTO_INCREMENT.
          if (c.default && set.default === undefined) this.removeSpaced(e, c.default.span);
          if (c.onUpdate) this.removeSpaced(e, c.onUpdate.span);
          if (c.autoIncrement && set.autoIncrement === undefined)
            this.removeSpaced(e, c.autoIncrement);
          const as = this.kw(this.style.generatedAlways ? 'GENERATED ALWAYS AS' : 'AS');
          this.insertAttr(e, c, 'generated', `${as} (${v.expr.trim()}) ${this.kw(v.storage)}`);
        }
      }
    }
    if (set.name !== undefined && set.name !== c.name) {
      this.renameColumn(e, t, c, set.name);
    }
    return e.build();
  }

  renameColumn(e: Edits, t: TableDef, c: ColumnDef, to: string): void {
    const src = this.src;
    if (!sameName(c.name, to) && t.columns.some((x) => sameName(x.name, to))) {
      throw new OpError('exists', `column ${to} already exists`, { table: t.name, column: to });
    }
    const newText = this.name(to, c.nameIdent);
    const indent = indentOf(src, c.span);
    const col = typeColumn(src, t);
    const gap = src.slice(c.nameIdent.span.end, c.type.span.start);
    const aligned =
      indent !== null &&
      col !== null &&
      /^ +$/.test(gap) &&
      displayWidth(src.slice(lineStart(src, c.span.start), c.type.span.start)) === col;
    if (aligned) {
      e.replace(
        { start: c.nameIdent.span.start, end: c.type.span.start },
        newText + padTo(indent, newText, col),
      );
    } else {
      e.replace(c.nameIdent.span, newText);
    }
    const renameParts = (list: KeyPartList | null | undefined) => {
      for (const p of list?.parts ?? []) {
        if (p.column && p.nameSpan && sameName(p.column, c.name))
          e.replace(p.nameSpan, this.name(to, p));
        if (p.expr) this.renameInExpr(e, p.span, c.name, to);
      }
    };
    for (const k of [...(t.primaryKey ? [t.primaryKey] : []), ...t.keys]) {
      if (k.origin === 'table') renameParts(k.columns);
    }
    for (const fk of t.foreignKeys) if (fk.origin === 'table') renameParts(fk.columns);
    for (const u of this.schema.tables) {
      for (const fk of u.foreignKeys) {
        if (sameName(fk.ref.table.name, t.name)) {
          for (const p of fk.ref.columns?.parts ?? []) {
            if (p.column && p.nameSpan && sameName(p.column, c.name))
              e.replace(p.nameSpan, this.name(to, p));
          }
        }
      }
    }
    for (const ch of t.checks) this.renameInExpr(e, ch.exprSpan, c.name, to);
    for (const other of t.columns) {
      if (other.generated) this.renameInExpr(e, other.generated.exprSpan, c.name, to);
      if (other.default && src[other.default.valueSpan.start] === '(')
        this.renameInExpr(e, other.default.valueSpan, c.name, to);
    }
  }

  columnDelete(tableName: string, columnName: string, cascade: boolean): string | TextEdit[] {
    const t = this.table(tableName);
    const c = this.column(t, columnName);
    if (t.columns.length === 1) throw new OpError('invalid', 'a table needs at least one column');
    const usedBy = (list: KeyPartList) =>
      list.parts.some(
        (p) =>
          (p.column && sameName(p.column, c.name)) ||
          (p.expr !== null && this.mentions(p.span, c.name)),
      );
    const generatedUsers = t.columns.filter(
      (o) => o !== c && o.generated && this.mentions(o.generated.exprSpan, c.name),
    );
    if (generatedUsers.length > 0) {
      throw new OpError(
        'referenced',
        `generated column ${generatedUsers[0]?.name} uses ${c.name}`,
        {
          table: t.name,
          column: c.name,
          by: generatedUsers.map((g) => g.name).join(', '),
        },
      );
    }
    const ops: Op[] = [];
    for (const k of [...(t.primaryKey ? [t.primaryKey] : []), ...t.keys]) {
      if (k.origin === 'table' && usedBy(k.columns)) {
        ops.push(
          k.kind === 'primary'
            ? { op: 'key.setPrimary', table: t.name, columns: [] }
            : {
                op: 'key.delete',
                table: t.name,
                target: { id: k.id, text: itemText(this.src, k) },
              },
        );
      }
    }
    for (const fk of t.foreignKeys) {
      if (fk.origin === 'table' && usedBy(fk.columns))
        ops.push({
          op: 'fk.delete',
          table: t.name,
          target: { id: fk.id, text: itemText(this.src, fk) },
        });
    }
    for (const r of this.referencing(t, c.name)) {
      if (r.table === t && hasFkDelete(ops, r.fk.id)) continue;
      ops.push({
        op: 'fk.delete',
        table: r.table.name,
        target: { id: r.fk.id, text: itemText(this.src, r.fk) },
      });
    }
    for (const ch of t.checks) {
      if (ch.origin === 'table' && this.mentions(ch.exprSpan, c.name))
        ops.push({
          op: 'check.delete',
          table: t.name,
          target: { id: ch.id, text: itemText(this.src, ch) },
        });
    }
    if (ops.length > 0 && !cascade) {
      throw new OpError('referenced', `${ops.length} constraint(s) use ${c.name}`, {
        table: t.name,
        column: c.name,
        count: ops.length,
      });
    }
    if (ops.length > 0) {
      const text = applyOps(this.src, ops);
      return applyOp(text, { op: 'column.delete', table: t.name, column: c.name });
    }
    const e = new Edits();
    this.removeDef(e, t, c);
    return e.build();
  }

  setPrimary(tableName: string, columns: string[]): TextEdit[] {
    const t = this.table(tableName);
    for (const name of columns) this.column(t, name);
    const pk = t.primaryKey;
    const e = new Edits();
    const pkText = () =>
      `${this.kw('PRIMARY KEY')} ${this.list(columns, pk?.origin === 'table' ? pk.columns : null)}`;
    if (columns.length === 0) {
      if (!pk) return [];
      if (pk.origin === 'table') this.removeDef(e, t, pk);
      else this.removeSpaced(e, pk.span);
      return e.build();
    }
    if (pk?.origin === 'table') {
      e.replace(pk.columns.span, this.list(columns, pk.columns));
      return e.build();
    }
    if (pk && columns.length === 1 && pk.column && sameName(pk.column, columns[0] as string))
      return [];
    if (pk) this.removeSpaced(e, pk.span);
    const lastColumn = t.columns[t.columns.length - 1] as ColumnDef;
    this.insertDef(e, t, this.defIndex(t, lastColumn), pkText());
    return e.build();
  }

  keyAdd(
    tableName: string,
    kind: 'unique' | 'index',
    columns: string[],
    name: string | null,
  ): TextEdit[] {
    const t = this.table(tableName);
    if (columns.length === 0) throw new OpError('invalid', 'a key needs at least one column');
    for (const n of columns) this.column(t, n);
    const word = kind === 'unique' ? this.kw(this.style.uniqueWord) : this.kw(this.indexWord(t));
    const text = `${word}${name ? ` ${this.name(name)}` : ''} ${this.list(columns)}`;
    const e = new Edits();
    this.insertDef(
      e,
      t,
      this.afterLast(t, ['primary', 'unique', 'index', 'fulltext', 'spatial']),
      text,
    );
    return e.build();
  }

  indexWord(t: TableDef): string {
    for (const k of t.keys) {
      if (k.kind === 'index' && k.origin === 'table') {
        return /^INDEX/i.test(this.src.slice(k.span.start, k.span.end)) ? 'INDEX' : 'KEY';
      }
    }
    return 'KEY';
  }

  keyUpdate(
    tableName: string,
    target: ItemRef,
    columns: string[] | undefined,
    name: string | null | undefined,
  ): string | TextEdit[] {
    const t = this.table(tableName);
    const k = this.find(t.keys, target);
    const e = new Edits();
    if (k.origin === 'column') {
      // An inline UNIQUE only covers its column: turn it into a table-level key.
      const cols = columns ?? [k.column as string];
      const text = this.applyEditsNow((x) => this.removeSpaced(x, k.span));
      return applyOp(text, {
        op: 'key.add',
        table: t.name,
        kind: 'unique',
        columns: cols,
        name: name ?? null,
      });
    }
    if (columns) {
      if (columns.length === 0) throw new OpError('invalid', 'a key needs at least one column');
      for (const n of columns) this.column(t, n);
      e.replace(k.columns.span, this.list(columns, k.columns));
    }
    if (name !== undefined)
      this.renameConstraint(e, k, k.indexName ?? k.constraintName, name, k.columns.span.start);
    return e.build();
  }

  applyEditsNow(fn: (e: Edits) => void): string {
    const e = new Edits();
    fn(e);
    return applyEdits(this.src, e.build());
  }

  /** Changes, adds or removes the name of a key or constraint. */
  renameConstraint(
    e: Edits,
    item: Item,
    current: Ident | null,
    name: string | null,
    insertAt: number,
  ): void {
    if (current) {
      if (name === null || name === '') {
        if (item.kind === 'foreign' || item.kind === 'check' || current === item.constraintName) {
          // Remove "CONSTRAINT name " together.
          const toks = this.tokens(item.span);
          const kwTok = toks.find((x) => x.text.toUpperCase() === 'CONSTRAINT');
          if (kwTok && current === item.constraintName) {
            const after = toks[toks.indexOf(kwTok) + 2];
            e.remove({ start: kwTok.start, end: after ? after.start : current.span.end });
            return;
          }
        }
        this.removeSpaced(e, current.span);
        return;
      }
      if (name !== current.name) e.replace(current.span, this.name(name, current));
      return;
    }
    if (name === null || name === '') return;
    if (item.kind === 'foreign' || item.kind === 'check') {
      e.insert(item.span.start, `${this.kw('CONSTRAINT')} ${this.name(name)} `);
    } else {
      const ws = /\s/.test(this.src[insertAt - 1] ?? '');
      e.insert(insertAt, `${ws ? '' : ' '}${this.name(name)} `);
    }
  }

  keyDelete(tableName: string, target: ItemRef): TextEdit[] {
    const t = this.table(tableName);
    const k = this.find(t.keys, target);
    const e = new Edits();
    if (k.origin === 'table') this.removeDef(e, t, k);
    else this.removeSpaced(e, k.span);
    return e.build();
  }

  fkText(spec: FkSpec): string {
    const name = spec.name ? `${this.kw('CONSTRAINT')} ${this.name(spec.name)} ` : '';
    let text = `${name}${this.kw('FOREIGN KEY')} ${this.list(spec.columns)} ${this.kw('REFERENCES')} ${this.name(spec.refTable)}${this.style.refSpace ? ' ' : ''}${this.list(spec.refColumns)}`;
    if (spec.onDelete) text += ` ${this.kw('ON DELETE')} ${this.kw(spec.onDelete)}`;
    if (spec.onUpdate) text += ` ${this.kw('ON UPDATE')} ${this.kw(spec.onUpdate)}`;
    return text;
  }

  checkFk(t: TableDef, spec: FkSpec): void {
    if (spec.columns.length === 0)
      throw new OpError('invalid', 'a foreign key needs at least one column');
    if (spec.columns.length !== spec.refColumns.length) {
      throw new OpError('invalid', 'the foreign key needs as many referenced columns as columns', {
        columns: spec.columns.length,
        refColumns: spec.refColumns.length,
      });
    }
    for (const n of spec.columns) this.column(t, n);
    const ref = this.table(spec.refTable);
    for (const n of spec.refColumns) this.column(ref, n);
  }

  fkAdd(tableName: string, spec: FkSpec): TextEdit[] {
    const t = this.table(tableName);
    this.checkFk(t, spec);
    const e = new Edits();
    this.insertDef(
      e,
      t,
      this.afterLast(t, ['foreign', 'primary', 'unique', 'index', 'fulltext', 'spatial']),
      this.fkText(spec),
    );
    return e.build();
  }

  fkUpdate(tableName: string, target: ItemRef, patch: Partial<FkSpec>): TextEdit[] {
    const t = this.table(tableName);
    const fk = this.find(t.foreignKeys, target);
    if (fk.origin === 'column')
      throw new OpError('invalid', 'make the inline REFERENCES a FOREIGN KEY first');
    const merged: FkSpec = {
      name: fk.constraintName?.name ?? null,
      columns: fk.columns.parts.map((p) => p.column ?? ''),
      refTable: fk.ref.table.name,
      refColumns: fk.ref.columns?.parts.map((p) => p.column ?? '') ?? [],
      onDelete: fk.ref.onDelete,
      onUpdate: fk.ref.onUpdate,
      ...patch,
    };
    this.checkFk(t, merged);
    const e = new Edits();
    if (patch.columns) e.replace(fk.columns.span, this.list(patch.columns, fk.columns));
    if (patch.refTable !== undefined && !sameName(patch.refTable, fk.ref.table.name)) {
      e.replace(fk.ref.table.span, this.name(patch.refTable, fk.ref.table));
    }
    if (patch.refColumns) {
      if (fk.ref.columns)
        e.replace(fk.ref.columns.span, this.list(patch.refColumns, fk.ref.columns));
      else e.insert(fk.ref.table.span.end, ` ${this.list(patch.refColumns)}`);
    }
    if (patch.onDelete !== undefined && patch.onDelete !== fk.ref.onDelete) {
      const text = patch.onDelete ? `${this.kw('ON DELETE')} ${this.kw(patch.onDelete)}` : null;
      if (fk.ref.onDeleteSpan) {
        if (text) e.replace(fk.ref.onDeleteSpan, text);
        else this.removeSpaced(e, fk.ref.onDeleteSpan);
      } else if (text) {
        if (fk.ref.onUpdateSpan) e.insert(fk.ref.onUpdateSpan.start, `${text} `);
        else e.insert(fk.span.end, ` ${text}`, 0);
      }
    }
    if (patch.onUpdate !== undefined && patch.onUpdate !== fk.ref.onUpdate) {
      const text = patch.onUpdate ? `${this.kw('ON UPDATE')} ${this.kw(patch.onUpdate)}` : null;
      if (fk.ref.onUpdateSpan) {
        if (text) e.replace(fk.ref.onUpdateSpan, text);
        else this.removeSpaced(e, fk.ref.onUpdateSpan);
      } else if (text) {
        e.insert(fk.span.end, ` ${text}`, 1);
      }
    }
    if (patch.name !== undefined)
      this.renameConstraint(e, fk, fk.constraintName, patch.name, fk.span.start);
    return e.build();
  }

  fkDelete(tableName: string, target: ItemRef): TextEdit[] {
    const t = this.table(tableName);
    const fk = this.find(t.foreignKeys, target);
    const e = new Edits();
    if (fk.origin === 'table') this.removeDef(e, t, fk);
    else this.removeSpaced(e, fk.ref.span);
    return e.build();
  }

  fkMakeTableLevel(tableName: string, target: ItemRef): TextEdit[] {
    const t = this.table(tableName);
    const fk = this.find(t.foreignKeys, target);
    if (fk.origin !== 'column' || !fk.column)
      throw new OpError('invalid', 'the foreign key is already table-level');
    const e = new Edits();
    this.removeSpaced(e, fk.ref.span);
    const refText = this.src.slice(fk.ref.span.start, fk.ref.span.end);
    const text = `${this.kw('FOREIGN KEY')} (${this.name(fk.column, fk.columns.parts[0])}) ${refText}`;
    this.insertDef(
      e,
      t,
      this.afterLast(t, ['foreign', 'primary', 'unique', 'index', 'fulltext', 'spatial']),
      text,
    );
    return e.build();
  }

  checkAdd(tableName: string, expr: string, name: string | null): TextEdit[] {
    const t = this.table(tableName);
    checkFragment(expr, 'expression');
    const e = new Edits();
    const text = `${name ? `${this.kw('CONSTRAINT')} ${this.name(name)} ` : ''}${this.kw('CHECK')} (${expr.trim()})`;
    this.insertDef(
      e,
      t,
      this.afterLast(t, ['check', 'foreign', 'primary', 'unique', 'index', 'fulltext', 'spatial']),
      text,
    );
    return e.build();
  }

  checkUpdate(
    tableName: string,
    target: ItemRef,
    expr: string | undefined,
    name: string | null | undefined,
  ): TextEdit[] {
    const t = this.table(tableName);
    const ch = this.find(t.checks, target);
    const e = new Edits();
    if (expr !== undefined && expr.trim() !== ch.expr) {
      checkFragment(expr, 'expression');
      e.replace(trimmedSpan(this.src, ch.exprSpan), expr.trim());
    }
    if (name !== undefined) this.renameConstraint(e, ch, ch.constraintName, name, ch.span.start);
    return e.build();
  }

  checkDelete(tableName: string, target: ItemRef): TextEdit[] {
    const t = this.table(tableName);
    const ch = this.find(t.checks, target);
    const e = new Edits();
    if (ch.origin === 'table') this.removeDef(e, t, ch);
    else this.removeSpaced(e, ch.span);
    return e.build();
  }
}

function hasFkDelete(ops: Op[], id: string): boolean {
  return ops.some((o) => o.op === 'fk.delete' && o.target.id === id);
}

function trimmedSpan(src: string, s: Span): Span {
  let start = s.start;
  let end = s.end;
  while (start < end && /\s/.test(src[start] as string)) start++;
  while (end > start && /\s/.test(src[end - 1] as string)) end--;
  return { start, end };
}

function checkName(name: string): void {
  if (name.trim() === '' || name !== name.trim())
    throw new OpError('invalid', 'a name cannot be empty or start/end with spaces', { name });
  if ([...name].length > MAX_NAME)
    throw new OpError('invalid', `a name can have at most ${MAX_NAME} characters`, { name });
  if (name.includes('\0')) throw new OpError('invalid', 'a name cannot contain NUL', { name });
}

/**
 * A piece of SQL typed into the diagram (a type, a DEFAULT, a CHECK
 * expression) must stay inside its clause: balanced, closed, no ";" and no
 * comma outside parentheses.
 */
export function checkFragment(text: string, what: 'type' | 'default' | 'expression'): void {
  if (text.trim() === '') throw new OpError('invalid', `the ${what} is empty`, { what });
  let depth = 0;
  for (const t of lex(text)) {
    const unclosed =
      (t.kind === 'string' && (t.text.length < 2 || !/['"]$/.test(t.text))) ||
      (t.kind === 'qident' && (t.text.length < 2 || !t.text.endsWith('`'))) ||
      ((t.kind === 'comment' || t.kind === 'exec_comment') &&
        t.text.startsWith('/*') &&
        !t.text.endsWith('*/'));
    if (unclosed)
      throw new OpError('invalid', `the ${what} has an unclosed quote or comment`, { what });
    if (t.kind === 'comment' && !t.text.startsWith('/*')) {
      throw new OpError('invalid', `the ${what} cannot contain a line comment`, { what });
    }
    if (t.kind === 'punct') {
      if (t.text === '(') depth++;
      if (t.text === ')' && --depth < 0) break;
      if (t.text === ';' || (t.text === ',' && depth === 0)) {
        throw new OpError('invalid', `the ${what} cannot contain "${t.text}" here`, { what });
      }
    }
  }
  if (depth !== 0) throw new OpError('invalid', `the ${what} has unbalanced parentheses`, { what });
}

/** The diagram sends the values it showed; if the file has changed since, refuse. */
function checkExpect(c: ColumnDef, expect: ColumnPatch): void {
  const current: ColumnPatch = {
    name: c.name,
    type: c.type.text,
    nullable: c.nullable ? c.nullable.value : null,
    default: c.default ? c.default.text : null,
    autoIncrement: c.autoIncrement !== null,
    comment: c.comment ? c.comment.value : null,
    generated: c.generated
      ? { expr: c.generated.expr, storage: c.generated.storage ?? 'VIRTUAL' }
      : null,
  };
  for (const key of Object.keys(expect) as (keyof ColumnPatch)[]) {
    if (JSON.stringify(expect[key] ?? null) !== JSON.stringify(current[key] ?? null)) {
      throw new OpError('conflict', `column ${c.name} changed since it was shown`, {
        column: c.name,
        field: key,
      });
    }
  }
}
