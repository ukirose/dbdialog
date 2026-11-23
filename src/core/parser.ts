// Recursive-descent parser for the MySQL 8.0 CREATE TABLE subset that a
// schema file uses. Expressions (CHECK, DEFAULT (…), AS (…)) are not parsed:
// they are kept as the text between their balanced parentheses.

import { isTrivia, lex, type Token } from './lexer';
import type {
  CheckDef,
  ColumnDef,
  CreateDefinition,
  Diagnostic,
  ForeignKeyDef,
  Ident,
  KeyDef,
  KeyKind,
  KeyPart,
  KeyPartList,
  RefAction,
  ReferenceDef,
  Schema,
  Span,
  StatementInfo,
  StringLiteral,
  TableDef,
  TableOption,
} from './model';
import { decodeStringToken, unquoteIdent } from './sqltext';
import { splitStatements } from './statements';

class ParseError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

class Cursor {
  i = 0;
  constructor(
    readonly toks: Token[],
    readonly endPos: number,
  ) {}

  get done(): boolean {
    return this.i >= this.toks.length;
  }
  peek(k = 0): Token | undefined {
    return this.toks[this.i + k];
  }
  prev(): Token {
    const t = this.toks[this.i - 1];
    if (!t) throw new ParseError('internal: no previous token', this.endPos);
    return t;
  }
  pos(): number {
    return this.peek()?.start ?? this.endPos;
  }
  next(): Token {
    const t = this.toks[this.i];
    if (!t) throw new ParseError('unexpected end of statement', this.endPos);
    this.i++;
    return t;
  }
  /** A value token (name, number, keyword); never a "(", ")" or "," that belongs to the structure. */
  value(): Token {
    const t = this.peek();
    if (!t || (t.kind === 'punct' && t.text !== '.'))
      throw new ParseError('expected a value', this.pos());
    this.i++;
    return t;
  }
  /** Unquoted word (keywords are never backtick-quoted). */
  is(word: string, k = 0): boolean {
    const t = this.peek(k);
    return t?.kind === 'ident' && t.text.toUpperCase() === word;
  }
  isAny(words: readonly string[], k = 0): boolean {
    const t = this.peek(k);
    return t?.kind === 'ident' && words.includes(t.text.toUpperCase());
  }
  accept(...words: string[]): boolean {
    for (let k = 0; k < words.length; k++) if (!this.is(words[k] as string, k)) return false;
    this.i += words.length;
    return true;
  }
  expect(...words: string[]): void {
    if (!this.accept(...words)) throw new ParseError(`expected ${words.join(' ')}`, this.pos());
  }
  isPunct(p: string, k = 0): boolean {
    const t = this.peek(k);
    return t?.kind === 'punct' && t.text === p;
  }
  acceptPunct(p: string): Token | null {
    return this.isPunct(p) ? this.next() : null;
  }
  expectPunct(p: string): Token {
    const t = this.acceptPunct(p);
    if (!t) throw new ParseError(`expected "${p}"`, this.pos());
    return t;
  }
  acceptOp(op: string): boolean {
    const t = this.peek();
    if (t?.kind === 'op' && t.text === op) {
      this.i++;
      return true;
    }
    return false;
  }
  isIdent(k = 0): boolean {
    const t = this.peek(k);
    return t?.kind === 'ident' || t?.kind === 'qident';
  }
  ident(): Ident {
    const t = this.peek();
    if (!t || (t.kind !== 'ident' && t.kind !== 'qident')) {
      throw new ParseError('expected a name', this.pos());
    }
    this.i++;
    return {
      name: unquoteIdent(t.text),
      span: { start: t.start, end: t.end },
      quoted: t.kind === 'qident',
    };
  }
  /** Consumes "(" … ")" and returns both parenthesis tokens. */
  balanced(): { open: Token; close: Token } {
    const open = this.expectPunct('(');
    let depth = 1;
    while (!this.done) {
      const t = this.next();
      if (t.kind === 'punct' && t.text === '(') depth++;
      else if (t.kind === 'punct' && t.text === ')' && --depth === 0) return { open, close: t };
    }
    throw new ParseError('unbalanced parentheses', open.start);
  }
}

const span = (start: number, end: number): Span => ({ start, end });

const ACTIONS: Record<string, RefAction> = {
  RESTRICT: 'RESTRICT',
  CASCADE: 'CASCADE',
  'SET NULL': 'SET NULL',
  'SET DEFAULT': 'SET DEFAULT',
  'NO ACTION': 'NO ACTION',
};

const CONSTRAINT_STARTS = [
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'FOREIGN',
  'CHECK',
  'INDEX',
  'KEY',
  'FULLTEXT',
  'SPATIAL',
] as const;

class TableParser {
  readonly diagnostics: Diagnostic[] = [];
  private tableName: string | null = null;

  constructor(
    readonly src: string,
    readonly cur: Cursor,
  ) {}

  private text(s: Span): string {
    return this.src.slice(s.start, s.end);
  }

  private stringLiteral(): StringLiteral {
    const first = this.cur.peek();
    if (first?.kind !== 'string') throw new ParseError('expected a string', this.cur.pos());
    let value = '';
    let last = first;
    while (this.cur.peek()?.kind === 'string') {
      last = this.cur.next();
      value += decodeStringToken(last.text);
    }
    const q = first.text.replace(/^[nN]/, '')[0] === '"' ? '"' : "'";
    return { value, span: span(first.start, last.end), quote: q };
  }

  private tableName_(): { ident: Ident; qualifier: Ident | null } {
    const first = this.cur.ident();
    if (this.cur.isPunct('.')) {
      this.cur.next();
      return { ident: this.cur.ident(), qualifier: first };
    }
    return { ident: first, qualifier: null };
  }

  private keyParts(): KeyPartList {
    const open = this.cur.expectPunct('(');
    const parts: KeyPart[] = [];
    for (;;) {
      const start = this.cur.pos();
      let part: KeyPart;
      if (this.cur.isPunct('(')) {
        const { open: o, close: c } = this.cur.balanced();
        part = {
          column: null,
          expr: this.src.slice(o.end, c.start).trim(),
          length: null,
          order: null,
          span: span(start, c.end),
          nameSpan: null,
          quoted: false,
        };
      } else {
        const id = this.cur.ident();
        let length: number | null = null;
        if (this.cur.isPunct('(')) {
          this.cur.next();
          length = Number(this.cur.value().text);
          this.cur.expectPunct(')');
        }
        part = {
          column: id.name,
          expr: null,
          length,
          order: null,
          span: span(start, this.cur.prev().end),
          nameSpan: id.span,
          quoted: id.quoted,
        };
      }
      if (this.cur.is('ASC') || this.cur.is('DESC')) {
        part.order = this.cur.next().text.toUpperCase() as 'ASC' | 'DESC';
        part.span = span(part.span.start, this.cur.prev().end);
      }
      parts.push(part);
      if (!this.cur.acceptPunct(',')) break;
    }
    const close = this.cur.expectPunct(')');
    return { parts, span: span(open.start, close.end) };
  }

  private indexOptions(): void {
    for (;;) {
      if (this.cur.is('KEY_BLOCK_SIZE')) {
        this.cur.next();
        this.cur.acceptOp('=');
        this.cur.value();
      } else if (this.cur.is('USING')) {
        this.cur.next();
        this.cur.value();
      } else if (this.cur.accept('WITH', 'PARSER')) {
        this.cur.value();
      } else if (this.cur.is('COMMENT')) {
        this.cur.next();
        this.stringLiteral();
      } else if (this.cur.is('VISIBLE') || this.cur.is('INVISIBLE')) {
        this.cur.next();
      } else if (this.cur.is('ENGINE_ATTRIBUTE') || this.cur.is('SECONDARY_ENGINE_ATTRIBUTE')) {
        this.cur.next();
        this.cur.acceptOp('=');
        this.stringLiteral();
      } else {
        return;
      }
    }
  }

  private optionalIndexName(): Ident | null {
    if (this.cur.isIdent() && !this.cur.is('USING') && !this.cur.isPunct('('))
      return this.cur.ident();
    return null;
  }

  private reference(): ReferenceDef {
    const start = this.cur.pos();
    this.cur.expect('REFERENCES');
    const { ident, qualifier } = this.tableName_();
    const columns = this.cur.isPunct('(') ? this.keyParts() : null;
    const ref: ReferenceDef = {
      table: ident,
      qualifier,
      columns,
      match: null,
      onDelete: null,
      onDeleteSpan: null,
      onUpdate: null,
      onUpdateSpan: null,
      span: span(start, start),
    };
    for (;;) {
      if (this.cur.is('MATCH')) {
        this.cur.next();
        ref.match = this.cur.value().text.toUpperCase();
      } else if (this.cur.is('ON') && (this.cur.is('DELETE', 1) || this.cur.is('UPDATE', 1))) {
        const w2 = this.cur.peek(2)?.text.toUpperCase() ?? '';
        const w3 = this.cur.peek(3)?.text.toUpperCase() ?? '';
        const action = ACTIONS[w2] ?? ACTIONS[`${w2} ${w3}`];
        if (!action) break; // e.g. a column's ON UPDATE CURRENT_TIMESTAMP
        const onStart = this.cur.next().start;
        const which = this.cur.next().text.toUpperCase();
        this.cur.next();
        if (action.includes(' ')) this.cur.next();
        const s = span(onStart, this.cur.prev().end);
        if (which === 'DELETE') {
          ref.onDelete = action;
          ref.onDeleteSpan = s;
        } else {
          ref.onUpdate = action;
          ref.onUpdateSpan = s;
        }
      } else {
        break;
      }
    }
    ref.span = span(start, this.cur.prev().end);
    return ref;
  }

  private check(
    start: number,
    constraintName: Ident | null,
    origin: 'table' | 'column',
    column: string | null,
  ): CheckDef {
    this.cur.expect('CHECK');
    const { open, close } = this.cur.balanced();
    let enforced: boolean | null = null;
    if (this.cur.accept('NOT', 'ENFORCED')) enforced = false;
    else if (this.cur.accept('ENFORCED')) enforced = true;
    return {
      kind: 'check',
      id: '',
      constraintName,
      expr: this.src.slice(open.end, close.start).trim(),
      exprSpan: span(open.end, close.start),
      enforced,
      span: span(start, this.cur.prev().end),
      origin,
      column,
    };
  }

  private column(): ColumnDef {
    const nameIdent = this.cur.ident();
    const col: ColumnDef = {
      kind: 'column',
      name: nameIdent.name,
      nameIdent,
      span: nameIdent.span,
      type: { text: '', span: span(0, 0) },
      nullable: null,
      default: null,
      onUpdate: null,
      autoIncrement: null,
      unique: null,
      primaryKey: null,
      comment: null,
      generated: null,
      collate: null,
      references: null,
      checks: [],
      attrs: [],
    };

    // Data type: name, (args), and modifiers such as UNSIGNED or CHARACTER SET.
    const typeTok = this.cur.next();
    if (typeTok.kind !== 'ident') throw new ParseError('expected a data type', typeTok.start);
    const t = typeTok.text.toUpperCase();
    if (t === 'DOUBLE') this.cur.accept('PRECISION');
    else if (t === 'CHAR' || t === 'CHARACTER' || t === 'NCHAR') this.cur.accept('VARYING');
    else if (t === 'LONG') {
      if (this.cur.isAny(['VARCHAR', 'VARBINARY'])) this.cur.next();
    } else if (t === 'NATIONAL') {
      if (this.cur.isAny(['CHAR', 'CHARACTER', 'VARCHAR', 'VARCHARACTER'])) this.cur.next();
      this.cur.accept('VARYING');
    }
    if (this.cur.isPunct('(')) this.cur.balanced();
    for (;;) {
      if (
        this.cur.isAny(['UNSIGNED', 'SIGNED', 'ZEROFILL', 'BINARY', 'ASCII', 'UNICODE', 'BYTE'])
      ) {
        this.cur.next();
      } else if (this.cur.is('CHARACTER') && this.cur.is('SET', 1)) {
        this.cur.next();
        this.cur.next();
        this.cur.value();
      } else if (this.cur.is('CHARSET')) {
        this.cur.next();
        this.cur.value();
      } else {
        break;
      }
    }
    const typeSpan = span(typeTok.start, this.cur.prev().end);
    col.type = { text: this.text(typeSpan), span: typeSpan };

    while (!this.cur.done && !this.cur.isPunct(',') && !this.cur.isPunct(')')) {
      const start = this.cur.pos();
      if (this.cur.accept('NOT', 'NULL')) {
        col.nullable = { value: false, span: span(start, this.cur.prev().end) };
      } else if (this.cur.accept('NULL')) {
        col.nullable = { value: true, span: span(start, this.cur.prev().end) };
      } else if (this.cur.is('DEFAULT')) {
        this.cur.next();
        const vStart = this.cur.pos();
        const v = this.cur.peek();
        if (this.cur.isPunct('(')) {
          this.cur.balanced();
        } else if (v?.kind === 'string') {
          this.stringLiteral();
        } else if (
          v?.kind === 'ident' &&
          v.text.startsWith('_') &&
          this.cur.peek(1)?.kind === 'string'
        ) {
          this.cur.next();
          this.stringLiteral();
        } else if (v?.kind === 'op' && (v.text === '-' || v.text === '+')) {
          this.cur.next();
          this.cur.value();
        } else {
          this.cur.value();
          if (this.cur.isPunct('(')) this.cur.balanced(); // CURRENT_TIMESTAMP(6), NOW()
        }
        const valueSpan = span(vStart, this.cur.prev().end);
        col.default = { text: this.text(valueSpan), span: span(start, valueSpan.end), valueSpan };
      } else if (this.cur.is('ON') && this.cur.is('UPDATE', 1)) {
        this.cur.next();
        this.cur.next();
        this.cur.value();
        if (this.cur.isPunct('(')) this.cur.balanced();
        const s = span(start, this.cur.prev().end);
        col.onUpdate = { text: this.text(s), span: s };
      } else if (this.cur.accept('AUTO_INCREMENT')) {
        col.autoIncrement = span(start, this.cur.prev().end);
      } else if (this.cur.is('UNIQUE')) {
        this.cur.next();
        this.cur.accept('KEY');
        col.unique = span(start, this.cur.prev().end);
      } else if (this.cur.is('PRIMARY')) {
        this.cur.next();
        this.cur.expect('KEY');
        col.primaryKey = span(start, this.cur.prev().end);
      } else if (this.cur.is('KEY')) {
        this.cur.next();
        col.primaryKey = span(start, this.cur.prev().end);
      } else if (this.cur.is('COMMENT')) {
        this.cur.next();
        const literal = this.stringLiteral();
        col.comment = { value: literal.value, span: span(start, literal.span.end), literal };
      } else if (this.cur.is('COLLATE')) {
        this.cur.next();
        this.cur.value();
        const s = span(start, this.cur.prev().end);
        col.collate = { text: this.text(s), span: s };
      } else if (this.cur.isAny(['COLUMN_FORMAT', 'STORAGE', 'SRID'])) {
        this.cur.next();
        this.cur.value();
      } else if (this.cur.isAny(['ENGINE_ATTRIBUTE', 'SECONDARY_ENGINE_ATTRIBUTE'])) {
        this.cur.next();
        this.cur.acceptOp('=');
        this.stringLiteral();
      } else if (this.cur.isAny(['VISIBLE', 'INVISIBLE'])) {
        this.cur.next();
      } else if (this.cur.is('GENERATED') || this.cur.is('AS')) {
        let always = false;
        if (this.cur.accept('GENERATED')) {
          this.cur.expect('ALWAYS');
          always = true;
        }
        this.cur.expect('AS');
        const { open, close } = this.cur.balanced();
        let storage: 'VIRTUAL' | 'STORED' | null = null;
        let storageSpan: Span | null = null;
        if (this.cur.isAny(['VIRTUAL', 'STORED'])) {
          const st = this.cur.next();
          storage = st.text.toUpperCase() as 'VIRTUAL' | 'STORED';
          storageSpan = span(st.start, st.end);
        }
        col.generated = {
          expr: this.src.slice(open.end, close.start).trim(),
          exprSpan: span(open.end, close.start),
          span: span(start, this.cur.prev().end),
          storage,
          storageSpan,
          always,
        };
      } else if (this.cur.isAny(['VIRTUAL', 'STORED']) && col.generated && !col.generated.storage) {
        const st = this.cur.next();
        col.generated.storage = st.text.toUpperCase() as 'VIRTUAL' | 'STORED';
        col.generated.storageSpan = span(st.start, st.end);
      } else if (this.cur.is('REFERENCES')) {
        col.references = this.reference();
      } else if (this.cur.is('CONSTRAINT') || this.cur.is('CHECK')) {
        let name: Ident | null = null;
        if (this.cur.accept('CONSTRAINT') && !this.cur.is('CHECK')) name = this.cur.ident();
        col.checks.push(this.check(start, name, 'column', col.name));
      } else {
        // Keep anything unknown as text and carry on; it is never rewritten.
        const tok = this.cur.peek() as Token;
        if (this.cur.isPunct('(')) this.cur.balanced();
        else this.cur.next();
        this.warn(
          'unknown-column-attribute',
          { text: tok.text, column: col.name },
          span(start, this.cur.prev().end),
        );
      }
      col.attrs.push(span(start, this.cur.prev().end));
    }
    col.span = span(nameIdent.span.start, this.cur.prev().end);
    return col;
  }

  private definition(): CreateDefinition {
    const start = this.cur.pos();
    if (!this.cur.isAny(CONSTRAINT_STARTS)) return this.column();

    let constraintName: Ident | null = null;
    if (this.cur.accept('CONSTRAINT')) {
      if (!this.cur.isAny(['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK']))
        constraintName = this.cur.ident();
    }
    const key = (kind: KeyKind, indexName: Ident | null): KeyDef => {
      if (this.cur.is('USING')) {
        this.cur.next();
        this.cur.value();
      }
      const columns = this.keyParts();
      this.indexOptions();
      return {
        kind,
        id: '',
        constraintName,
        indexName,
        columns,
        span: span(start, this.cur.prev().end),
        origin: 'table',
        column: null,
      };
    };

    if (this.cur.accept('PRIMARY', 'KEY')) return key('primary', null);
    if (this.cur.is('UNIQUE')) {
      this.cur.next();
      if (this.cur.isAny(['INDEX', 'KEY'])) this.cur.next();
      return key('unique', this.optionalIndexName());
    }
    if (this.cur.accept('FOREIGN', 'KEY')) {
      const indexName = this.optionalIndexName();
      const columns = this.keyParts();
      const ref = this.reference();
      const fk: ForeignKeyDef = {
        kind: 'foreign',
        id: '',
        constraintName,
        indexName,
        columns,
        ref,
        span: span(start, this.cur.prev().end),
        origin: 'table',
        column: null,
      };
      return fk;
    }
    if (this.cur.is('CHECK')) return this.check(start, constraintName, 'table', null);
    if (constraintName)
      throw new ParseError('expected PRIMARY KEY, UNIQUE, FOREIGN KEY or CHECK', this.cur.pos());
    if (this.cur.isAny(['INDEX', 'KEY'])) {
      this.cur.next();
      return key('index', this.optionalIndexName());
    }
    const kind = this.cur.next().text.toLowerCase() as 'fulltext' | 'spatial';
    if (this.cur.isAny(['INDEX', 'KEY'])) this.cur.next();
    return key(kind, this.optionalIndexName());
  }

  /** Skips to the next top-level "," or ")" after a definition that could not be read. */
  private recover(from: number): void {
    this.cur.i = from;
    let depth = 0;
    while (!this.cur.done) {
      const t = this.cur.peek() as Token;
      if (t.kind === 'punct') {
        if (t.text === '(') depth++;
        else if (t.text === ')') {
          if (depth === 0) return;
          depth--;
        } else if (t.text === ',' && depth === 0) return;
      }
      this.cur.next();
    }
  }

  private warn(
    code: string,
    params: Record<string, string | number>,
    s: Span,
    severity: 'warning' | 'error' | 'info' = 'warning',
  ): void {
    this.diagnostics.push({ severity, code, params, span: s, table: this.tableName });
  }

  parse(stmt: { start: number; end: number; delimiter: Span | null }): TableDef | null {
    const cur = this.cur;
    const temporary = cur.accept('CREATE', 'TEMPORARY', 'TABLE');
    if (!temporary) cur.expect('CREATE', 'TABLE');
    const ifNotExists = cur.accept('IF', 'NOT', 'EXISTS');
    const { ident, qualifier } = this.tableName_();
    this.tableName = ident.name;
    if (!cur.isPunct('(') || cur.isAny(['SELECT', 'LIKE', 'WITH'], 1) || cur.isPunct('(', 1)) {
      // CREATE TABLE … LIKE / AS SELECT: valid, but not something we can draw.
      this.warn(
        'table-not-modeled',
        { table: ident.name },
        span(stmt.start, cur.prev().end),
        'info',
      );
      return null;
    }
    const open = cur.next();
    const defs: CreateDefinition[] = [];
    const commas: number[] = [];
    let hasErrors = false;
    for (;;) {
      const from = cur.i;
      const startPos = cur.pos();
      try {
        const def = this.definition();
        if (!cur.isPunct(',') && !cur.isPunct(')'))
          throw new ParseError('unexpected text', cur.pos());
        defs.push(def);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        hasErrors = true;
        this.warn('parse-error', { message: e.message }, span(e.pos, e.pos), 'error');
        this.recover(from);
        const endPos = cur.i > from ? cur.prev().end : startPos;
        defs.push({
          kind: 'unknown',
          span: span(startPos, endPos),
          text: this.src.slice(startPos, endPos),
        });
      }
      const comma = cur.acceptPunct(',');
      if (!comma) break;
      commas.push(comma.start);
    }
    const close = cur.expectPunct(')');

    // Table options: ENGINE=…, DEFAULT CHARSET=…, COMMENT='…'; PARTITION BY … is kept as text.
    const options: TableOption[] = [];
    let comment: TableDef['comment'] = null;
    let tail: Span | null = null;
    const lastEnd = cur.toks[cur.toks.length - 1]?.end ?? close.end;
    while (!cur.done) {
      if (cur.acceptPunct(',')) continue;
      const optStart = cur.pos();
      if (cur.isAny(['PARTITION', 'IGNORE', 'REPLACE', 'AS', 'SELECT', 'WITH'])) {
        tail = span(optStart, lastEnd);
        break;
      }
      try {
        cur.accept('DEFAULT');
        const nameTok = cur.value();
        let name = nameTok.text.toUpperCase();
        if (name === 'CHARACTER' && cur.accept('SET')) name = 'CHARACTER SET';
        if (name === 'START' && cur.accept('TRANSACTION')) name = 'START TRANSACTION';
        const hasEquals = cur.acceptOp('=');
        if (name === 'COMMENT') {
          const literal = this.stringLiteral();
          comment = { value: literal.value, span: span(optStart, literal.span.end), literal };
        } else if (name !== 'START TRANSACTION') {
          if (cur.isPunct('(')) cur.balanced();
          else if (!cur.done && !cur.isPunct(',')) {
            if (cur.peek()?.kind === 'string') this.stringLiteral();
            else cur.next();
          }
        }
        options.push({ name, span: span(optStart, cur.prev().end), hasEquals });
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        // An option we cannot read: keep the rest of the statement as text.
        tail = span(optStart, lastEnd);
        break;
      }
    }

    const columns = defs.filter((d): d is ColumnDef => d.kind === 'column');
    const keys: KeyDef[] = [];
    const foreignKeys: ForeignKeyDef[] = [];
    const checks: CheckDef[] = [];
    const primaries: KeyDef[] = [];
    for (const d of defs) {
      if (d.kind === 'column') {
        if (d.primaryKey) primaries.push(inlineKey('primary', d, d.primaryKey));
        if (d.unique) keys.push(inlineKey('unique', d, d.unique));
        if (d.references) {
          foreignKeys.push({
            kind: 'foreign',
            id: '',
            constraintName: null,
            indexName: null,
            columns: {
              parts: [
                {
                  column: d.name,
                  expr: null,
                  length: null,
                  order: null,
                  span: d.nameIdent.span,
                  nameSpan: d.nameIdent.span,
                  quoted: d.nameIdent.quoted,
                },
              ],
              span: d.nameIdent.span,
            },
            ref: d.references,
            span: d.references.span,
            origin: 'column',
            column: d.name,
          });
        }
        checks.push(...d.checks);
      } else if (d.kind === 'primary') {
        primaries.push(d);
      } else if (
        d.kind === 'unique' ||
        d.kind === 'index' ||
        d.kind === 'fulltext' ||
        d.kind === 'spatial'
      ) {
        keys.push(d);
      } else if (d.kind === 'foreign') {
        foreignKeys.push(d);
      } else if (d.kind === 'check') {
        checks.push(d);
      }
    }
    const byPos = (a: { span: Span }, b: { span: Span }) => a.span.start - b.span.start;
    keys.sort(byPos);
    foreignKeys.sort(byPos);
    checks.sort(byPos);
    primaries.sort(byPos);
    const primaryKey = primaries[0] ?? null;
    if (primaryKey) primaryKey.id = 'primary';
    for (const extra of primaries.slice(1)) {
      this.warn('multiple-primary-keys', { table: ident.name }, extra.span, 'error');
    }
    const counters: Record<string, number> = {};
    for (const k of keys) {
      counters[k.kind] = (counters[k.kind] ?? -1) + 1;
      k.id = `${k.kind}:${counters[k.kind]}`;
    }
    foreignKeys.forEach((fk, i) => {
      fk.id = `foreign:${i}`;
    });
    checks.forEach((c, i) => {
      c.id = `check:${i}`;
    });

    return {
      name: ident.name,
      nameIdent: ident,
      qualifier,
      temporary,
      ifNotExists,
      stmt: {
        start: stmt.start,
        end: stmt.end,
        contentEnd: cur.toks[cur.toks.length - 1]?.end ?? stmt.end,
        delimiter: stmt.delimiter,
      },
      open: open.start,
      close: close.start,
      defs,
      commas,
      columns,
      primaryKey,
      keys,
      foreignKeys,
      checks,
      comment,
      options,
      tail,
      hasErrors,
    };
  }
}

function inlineKey(kind: 'primary' | 'unique', col: ColumnDef, s: Span): KeyDef {
  return {
    kind,
    id: '',
    constraintName: null,
    indexName: null,
    columns: {
      parts: [
        {
          column: col.name,
          expr: null,
          length: null,
          order: null,
          span: col.nameIdent.span,
          nameSpan: col.nameIdent.span,
          quoted: col.nameIdent.quoted,
        },
      ],
      span: col.nameIdent.span,
    },
    span: s,
    origin: 'column',
    column: col.name,
  };
}

function statementHead(toks: Token[]): string {
  return toks
    .slice(0, 4)
    .map((t) => t.text)
    .join(' ')
    .slice(0, 80);
}

/** Parses a whole schema file. Never throws: problems become diagnostics. */
export function parseSchema(src: string): Schema {
  const statements: StatementInfo[] = [];
  const tables: TableDef[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const raw of splitStatements(src)) {
    const s = span(raw.start, raw.end);
    if (raw.kind === 'delimiter_command') {
      statements.push({
        kind: 'delimiter',
        span: s,
        delimiter: null,
        head: src.slice(raw.start, raw.end),
      });
      continue;
    }
    const toks = lex(src, raw.start, raw.end).filter((t) => !isTrivia(t));
    const isCreateTable =
      toks[0]?.kind === 'ident' &&
      toks[0].text.toUpperCase() === 'CREATE' &&
      ((toks[1]?.kind === 'ident' && toks[1].text.toUpperCase() === 'TABLE') ||
        (toks[1]?.text.toUpperCase() === 'TEMPORARY' && toks[2]?.text.toUpperCase() === 'TABLE'));
    if (!isCreateTable) {
      statements.push({
        kind: 'other',
        span: s,
        delimiter: raw.delimiter,
        head: statementHead(toks),
      });
      noteSchemaChange(toks, s, diagnostics);
      continue;
    }
    const parser = new TableParser(src, new Cursor(toks, raw.end));
    let table: TableDef | null = null;
    try {
      table = parser.parse(raw);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      parser.diagnostics.push({
        severity: 'error',
        code: 'parse-error',
        params: { message: e.message },
        span: span(e.pos, e.pos),
        table: null,
      });
    }
    diagnostics.push(...parser.diagnostics);
    if (table) {
      tables.push(table);
      statements.push({
        kind: 'create_table',
        span: s,
        delimiter: raw.delimiter,
        head: statementHead(toks),
      });
    } else {
      statements.push({
        kind: 'other',
        span: s,
        delimiter: raw.delimiter,
        head: statementHead(toks),
      });
    }
  }
  return { source: src, statements, tables, diagnostics };
}

/** ALTER TABLE / CREATE INDEX change a table, but the diagram does not read them. */
function noteSchemaChange(toks: Token[], s: Span, out: Diagnostic[]): void {
  const w = toks.map((t) => (t.kind === 'ident' ? t.text.toUpperCase() : t.text));
  let table: string | null = null;
  if (w[0] === 'ALTER' && w[1] === 'TABLE') {
    const t = toks[w[2] === 'IF' ? 4 : 2];
    if (t) table = unquoteIdent(t.text);
  } else if (w[0] === 'CREATE' && w.includes('INDEX')) {
    const on = w.indexOf('ON');
    const t = on >= 0 ? toks[on + 1] : undefined;
    if (t) table = unquoteIdent(t.text);
  }
  if (table) {
    out.push({
      severity: 'info',
      code: 'statement-not-modeled',
      params: {
        table,
        head: toks
          .slice(0, 3)
          .map((t) => t.text)
          .join(' '),
      },
      span: s,
      table,
    });
  }
}
