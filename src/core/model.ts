// The schema model built from schema.sql. Every part keeps the span (start/end
// offsets in the source) it was read from, so edits can rewrite only that part.

/** Half-open range [start, end) of UTF-16 offsets into the source text. */
export interface Span {
  start: number;
  end: number;
}

export interface Ident {
  name: string;
  span: Span;
  quoted: boolean;
}

export interface StringLiteral {
  value: string;
  /** Covers every adjacent string token ('a' 'b' is one literal in MySQL). */
  span: Span;
  quote: "'" | '"';
}

export type RefAction = 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'SET DEFAULT';

export interface KeyPart {
  column: string | null;
  /** Functional key part: ((expr)) */
  expr: string | null;
  length: number | null;
  order: 'ASC' | 'DESC' | null;
  span: Span;
  nameSpan: Span | null;
  quoted: boolean;
}

export interface KeyPartList {
  parts: KeyPart[];
  /** From "(" to ")". */
  span: Span;
}

export interface ReferenceDef {
  table: Ident;
  qualifier: Ident | null;
  columns: KeyPartList | null;
  match: string | null;
  onDelete: RefAction | null;
  onDeleteSpan: Span | null;
  onUpdate: RefAction | null;
  onUpdateSpan: Span | null;
  span: Span;
}

export interface Clause {
  text: string;
  span: Span;
}

export interface ColumnDef {
  kind: 'column';
  name: string;
  nameIdent: Ident;
  span: Span;
  type: Clause;
  nullable: { value: boolean; span: Span } | null;
  default: { text: string; span: Span; valueSpan: Span } | null;
  onUpdate: Clause | null;
  autoIncrement: Span | null;
  unique: Span | null;
  primaryKey: Span | null;
  comment: { value: string; span: Span; literal: StringLiteral } | null;
  generated: {
    expr: string;
    exprSpan: Span;
    span: Span;
    storage: 'VIRTUAL' | 'STORED' | null;
    storageSpan: Span | null;
    always: boolean;
  } | null;
  collate: Clause | null;
  references: ReferenceDef | null;
  checks: CheckDef[];
  /** Spans of every attribute after the type, in source order. */
  attrs: Span[];
}

export type KeyKind = 'primary' | 'unique' | 'index' | 'fulltext' | 'spatial';

export interface KeyDef {
  kind: KeyKind;
  id: string;
  constraintName: Ident | null;
  indexName: Ident | null;
  columns: KeyPartList;
  span: Span;
  origin: 'table' | 'column';
  column: string | null;
}

export interface ForeignKeyDef {
  kind: 'foreign';
  id: string;
  constraintName: Ident | null;
  indexName: Ident | null;
  columns: KeyPartList;
  ref: ReferenceDef;
  span: Span;
  /** 'column' = an inline REFERENCES, which MySQL 8.0 parses and then ignores. */
  origin: 'table' | 'column';
  column: string | null;
}

export interface CheckDef {
  kind: 'check';
  id: string;
  constraintName: Ident | null;
  expr: string;
  /** Inside the parentheses. */
  exprSpan: Span;
  enforced: boolean | null;
  span: Span;
  origin: 'table' | 'column';
  column: string | null;
}

export interface UnknownDef {
  kind: 'unknown';
  span: Span;
  text: string;
}

export type CreateDefinition = ColumnDef | KeyDef | ForeignKeyDef | CheckDef | UnknownDef;

export interface TableOption {
  name: string;
  span: Span;
  hasEquals: boolean;
}

export interface TableDef {
  name: string;
  nameIdent: Ident;
  qualifier: Ident | null;
  temporary: boolean;
  ifNotExists: boolean;
  /** start: first token; end: delimiter start (or end of file); contentEnd: end of the last token. */
  stmt: { start: number; end: number; contentEnd: number; delimiter: Span | null };
  open: number;
  close: number;
  /** Table-level definitions in source order, and the commas between them. */
  defs: CreateDefinition[];
  commas: number[];
  columns: ColumnDef[];
  primaryKey: KeyDef | null;
  keys: KeyDef[];
  foreignKeys: ForeignKeyDef[];
  checks: CheckDef[];
  comment: { value: string; span: Span; literal: StringLiteral } | null;
  options: TableOption[];
  /** PARTITION BY … or anything else after the options that is kept as text. */
  tail: Span | null;
  hasErrors: boolean;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Stable code; the UI turns code + params into a message in the user's language. */
  code: string;
  params: Record<string, string | number>;
  span: Span;
  table: string | null;
}

export interface StatementInfo {
  kind: 'create_table' | 'other' | 'delimiter';
  span: Span;
  delimiter: Span | null;
  /** First words, for listing statements the diagram does not show. */
  head: string;
}

export interface Schema {
  source: string;
  statements: StatementInfo[];
  tables: TableDef[];
  diagnostics: Diagnostic[];
}
