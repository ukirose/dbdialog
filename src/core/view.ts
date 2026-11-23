// What the server sends to the diagram: plain JSON built from the model.
// Both sides import these types, so the API is checked at compile time.

import { type Cardinality, cardinality } from './cardinality';
import { lex } from './lexer';
import { lint } from './lint';
import type {
  CheckDef,
  Diagnostic,
  ForeignKeyDef,
  KeyDef,
  RefAction,
  Schema,
  Severity,
  TableDef,
} from './model';
import { itemText } from './ops';
import { unquoteIdent } from './sqltext';

export interface ViewColumn {
  name: string;
  type: string;
  nullable: boolean | null;
  default: string | null;
  onUpdate: string | null;
  autoIncrement: boolean;
  comment: string | null;
  generated: { expr: string; storage: 'VIRTUAL' | 'STORED' } | null;
  /** COLLATE written on the column, if any. */
  collation: string | null;
  primaryKey: boolean;
  unique: boolean;
  foreignKey: boolean;
}

export interface ViewKey {
  id: string;
  text: string;
  kind: KeyDef['kind'];
  name: string | null;
  columns: string[];
  origin: 'table' | 'column';
}

export interface ViewForeignKey {
  id: string;
  text: string;
  name: string | null;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: RefAction | null;
  onUpdate: RefAction | null;
  origin: 'table' | 'column';
  /** Read from the DDL: how many rows each side of the relationship has. */
  cardinality: Cardinality;
}

export interface ViewCheck {
  id: string;
  text: string;
  name: string | null;
  expr: string;
  enforced: boolean | null;
  origin: 'table' | 'column';
  column: string | null;
  /** Columns of the table the expression mentions, as they are declared. */
  columns: string[];
}

export interface ViewTable {
  name: string;
  comment: string | null;
  line: number;
  sql: string;
  hasErrors: boolean;
  columns: ViewColumn[];
  primaryKey: ViewKey | null;
  keys: ViewKey[];
  foreignKeys: ViewForeignKey[];
  checks: ViewCheck[];
}

export interface ViewDiagnostic {
  severity: Severity;
  code: string;
  params: Record<string, string | number>;
  table: string | null;
  line: number;
  column: number;
}

export interface ViewSchema {
  file: string;
  version: number;
  tables: ViewTable[];
  diagnostics: ViewDiagnostic[];
  /** Statements the diagram does not draw (SET, CREATE INDEX, triggers…), for the status line. */
  otherStatements: { head: string; line: number }[];
}

export interface Position {
  x: number;
  y: number;
}

/** A box in the layout file: its position, and its width when the user set one. */
export interface LayoutEntry extends Position {
  w?: number;
}

/**
 * A line laid out by the automatic layout, kept in the layout file. It holds
 * while both boxes stay where they were when it was computed.
 */
export interface LayoutRoute {
  /** Positions of the child's box and of the parent's box at that time. */
  at: [[number, number], [number, number]];
  /** From the child's column to the parent's, every corner included. */
  points: [number, number][];
  /**
   * The side of the child's box the line leaves and the side of the parent's
   * box it enters (l: left, r: right). Absent: the child's left, the parent's right.
   */
  sides?: ['l' | 'r', 'l' | 'r'];
}

/**
 * How relationships are drawn: IE (crow's feet) or IDEF1X (FIPS PUB 184).
 * Both draw identifying relationships solid and non-identifying ones dashed.
 */
export type Notation = 'ie' | 'idef1x';

/** Everything the diagram needs; sent by GET /api/state, SSE and every edit response. */
export interface ServerState {
  schema: ViewSchema;
  layout: {
    tables: Record<string, LayoutEntry>;
    routes?: Record<string, LayoutRoute>;
    /** Absent: IE. */
    notation?: Notation;
  };
  /** Set when the file cannot be read (deleted, moved). */
  missing: boolean;
  /** Settings from the command line that the page needs. */
  ui: { lang: 'en' | 'ja' | 'auto' };
}

/** Error body of a refused edit. */
export interface ApiError {
  code: string;
  message: string;
  params?: Record<string, string | number>;
}

/** 1-based line and column of an offset. */
export function positionOf(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = src.indexOf('\n'); i >= 0 && i < offset; i = src.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}

function key(src: string, k: KeyDef): ViewKey {
  return {
    id: k.id,
    text: itemText(src, k),
    kind: k.kind,
    name: k.indexName?.name ?? k.constraintName?.name ?? null,
    columns: k.columns.parts.map((p) => p.column ?? `(${p.expr})`),
    origin: k.origin,
  };
}

function foreignKey(src: string, t: TableDef, fk: ForeignKeyDef): ViewForeignKey {
  return {
    id: fk.id,
    text: itemText(src, fk),
    name: fk.constraintName?.name ?? null,
    columns: fk.columns.parts.map((p) => p.column ?? ''),
    refTable: fk.ref.table.name,
    refColumns: fk.ref.columns?.parts.map((p) => p.column ?? '') ?? [],
    onDelete: fk.ref.onDelete,
    onUpdate: fk.ref.onUpdate,
    origin: fk.origin,
    cardinality: cardinality(t, fk),
  };
}

function check(src: string, t: TableDef, c: CheckDef): ViewCheck {
  const byName = new Map(t.columns.map((col) => [col.name.toLowerCase(), col.name]));
  const mentioned = new Set<string>();
  if (c.column) mentioned.add(byName.get(c.column.toLowerCase()) ?? c.column);
  for (const tok of lex(src, c.exprSpan.start, c.exprSpan.end)) {
    if (tok.kind !== 'ident' && tok.kind !== 'qident') continue;
    const name = byName.get(unquoteIdent(tok.text).toLowerCase());
    if (name) mentioned.add(name);
  }
  return {
    id: c.id,
    text: itemText(src, c),
    name: c.constraintName?.name ?? null,
    expr: c.expr,
    enforced: c.enforced,
    origin: c.origin,
    column: c.column,
    // In the order of the table, like the rows of the box.
    columns: t.columns.map((col) => col.name).filter((n) => mentioned.has(n)),
  };
}

export function toView(schema: Schema, file: string, version: number): ViewSchema {
  const src = schema.source;
  const lower = (s: string) => s.toLowerCase();
  const diagnostics: Diagnostic[] = [...schema.diagnostics, ...lint(schema)];
  return {
    file,
    version,
    tables: schema.tables.map((t) => {
      const inPk = new Set(t.primaryKey?.columns.parts.map((p) => lower(p.column ?? '')) ?? []);
      const inUnique = new Set(
        t.keys
          .filter((k) => k.kind === 'unique' && k.columns.parts.length === 1)
          .map((k) => lower(k.columns.parts[0]?.column ?? '')),
      );
      const inFk = new Set(
        t.foreignKeys.flatMap((f) => f.columns.parts.map((p) => lower(p.column ?? ''))),
      );
      return {
        name: t.name,
        comment: t.comment?.value ?? null,
        line: positionOf(src, t.stmt.start).line,
        sql: src.slice(t.stmt.start, t.stmt.delimiter?.end ?? t.stmt.end),
        hasErrors: t.hasErrors,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type.text,
          nullable: c.nullable ? c.nullable.value : null,
          default: c.default?.text ?? null,
          onUpdate: c.onUpdate?.text ?? null,
          autoIncrement: c.autoIncrement !== null,
          comment: c.comment?.value ?? null,
          generated: c.generated
            ? { expr: c.generated.expr, storage: c.generated.storage ?? 'VIRTUAL' }
            : null,
          collation: c.collate ? c.collate.text.replace(/^collate\s+/i, '').trim() : null,
          primaryKey: inPk.has(lower(c.name)),
          unique: inUnique.has(lower(c.name)),
          foreignKey: inFk.has(lower(c.name)),
        })),
        primaryKey: t.primaryKey ? key(src, t.primaryKey) : null,
        keys: t.keys.map((k) => key(src, k)),
        foreignKeys: t.foreignKeys.map((f) => foreignKey(src, t, f)),
        checks: t.checks.map((c) => check(src, t, c)),
      };
    }),
    diagnostics: diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      params: d.params,
      table: d.table,
      ...positionOf(src, d.span.start),
    })),
    otherStatements: schema.statements
      .filter((s) => s.kind !== 'create_table')
      .map((s) => ({ head: s.head, line: positionOf(src, s.span.start).line })),
  };
}
