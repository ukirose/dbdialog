// Column types the way MySQL 8.0 compares them in a foreign key. The rules
// were taken from MySQL 8.0.46 itself (scripts/verify-mysql.ts re-checks
// them): integers must match in size and sign, strings in character set and
// collation; DECIMAL precision, string length, CHAR vs VARCHAR, DATETIME vs
// TIMESTAMP and ENUM members may differ.

import type { ColumnDef, Schema, TableDef } from './model';

export type TypeFamily =
  | 'int'
  | 'decimal'
  | 'float'
  | 'string'
  | 'binary'
  | 'blob'
  | 'date'
  | 'datetime'
  | 'time'
  | 'year'
  | 'enum'
  | 'other';

export interface TypeInfo {
  family: TypeFamily;
  base: string;
  unsigned: boolean;
  charset: string | null;
  collation: string | null;
}

const ALIASES: Record<string, string> = {
  integer: 'int',
  int1: 'tinyint',
  int2: 'smallint',
  int3: 'mediumint',
  int4: 'int',
  int8: 'bigint',
  middleint: 'mediumint',
  bool: 'tinyint',
  boolean: 'tinyint',
  dec: 'decimal',
  numeric: 'decimal',
  fixed: 'decimal',
  real: 'double',
  float4: 'float',
  float8: 'double',
  character: 'char',
  nchar: 'char',
  nvarchar: 'varchar',
  varcharacter: 'varchar',
};

const FAMILIES: Record<string, TypeFamily> = {
  tinyint: 'int',
  smallint: 'int',
  mediumint: 'int',
  int: 'int',
  bigint: 'int',
  decimal: 'decimal',
  float: 'float',
  double: 'float',
  char: 'string',
  varchar: 'string',
  binary: 'binary',
  varbinary: 'binary',
  tinytext: 'blob',
  text: 'blob',
  mediumtext: 'blob',
  longtext: 'blob',
  tinyblob: 'blob',
  blob: 'blob',
  mediumblob: 'blob',
  longblob: 'blob',
  json: 'blob',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'datetime',
  time: 'time',
  year: 'year',
  enum: 'enum',
  set: 'enum',
};

/** Collation a character set gets when none is named (MySQL 8.0 defaults). */
const DEFAULT_COLLATION: Record<string, string> = {
  utf8mb4: 'utf8mb4_0900_ai_ci',
  utf8mb3: 'utf8mb3_general_ci',
  utf8: 'utf8mb3_general_ci',
  latin1: 'latin1_swedish_ci',
  ascii: 'ascii_general_ci',
  binary: 'binary',
  ujis: 'ujis_japanese_ci',
  sjis: 'sjis_japanese_ci',
  cp932: 'cp932_japanese_ci',
  eucjpms: 'eucjpms_japanese_ci',
};

const SERVER_CHARSET = 'utf8mb4';

/** Lower case, without quotes; "utf8" is MySQL's old name for utf8mb3. */
const unquote = (s: string) =>
  s
    .replace(/^['"`]|['"`]$/g, '')
    .toLowerCase()
    .replace(/^utf8(?=$|_)/, 'utf8mb3');

export function typeInfo(c: ColumnDef): TypeInfo {
  const text = c.type.text.toLowerCase().replace(/\s+/g, ' ').trim();
  let words = text
    .replace(/\(.*?\)/g, ' ')
    .split(' ')
    .filter(Boolean);
  if (words[0] === 'national') words = words.slice(1);
  let base = words[0] ?? '';
  if ((base === 'char' || base === 'character') && words[1] === 'varying') base = 'varchar';
  else if (base === 'long') base = words[1] === 'varbinary' ? 'mediumblob' : 'mediumtext';
  base = ALIASES[base] ?? base;
  let unsigned = /\b(unsigned|zerofill)\b/.test(text);
  if (base === 'serial') {
    base = 'bigint';
    unsigned = true;
  }
  const charset = /\b(?:character set|charset) (\S+)/.exec(text)?.[1] ?? null;
  const collation = c.collate ? unquote(c.collate.text.replace(/^collate\s+/i, '').trim()) : null;
  return {
    family: FAMILIES[base] ?? 'other',
    base,
    unsigned,
    charset: charset ? unquote(charset) : null,
    collation,
  };
}

/** DEFAULT CHARSET / COLLATE written in the table options. */
export function tableCharset(
  schema: Schema,
  t: TableDef,
): { charset: string | null; collation: string | null } {
  let charset: string | null = null;
  let collation: string | null = null;
  for (const o of t.options) {
    const text = schema.source.slice(o.span.start, o.span.end);
    const value = /(?:=|\s)\s*(\S+)\s*$/.exec(text)?.[1];
    if (!value) continue;
    if (o.name === 'CHARSET' || o.name === 'CHARACTER SET') charset = unquote(value);
    if (o.name === 'COLLATE') collation = unquote(value);
  }
  return { charset, collation };
}

/** Character set and collation a string column really gets. */
export function effectiveCollation(
  schema: Schema,
  t: TableDef,
  info: TypeInfo,
): { charset: string; collation: string | null } {
  const table = tableCharset(schema, t);
  const charset =
    info.charset ??
    info.collation?.split('_')[0] ??
    table.charset ??
    table.collation?.split('_')[0] ??
    SERVER_CHARSET;
  let collation = info.collation;
  if (!collation && !info.charset && table.collation?.startsWith(`${charset}_`)) {
    collation = table.collation;
  }
  return { charset, collation: collation ?? DEFAULT_COLLATION[charset] ?? null };
}

export type Mismatch = 'kind' | 'sign' | 'size' | 'charset' | 'collation' | 'blob';

/** Why MySQL would refuse to link these two columns, or null when it accepts them. */
export function fkMismatch(
  schema: Schema,
  child: { table: TableDef; column: ColumnDef },
  parent: { table: TableDef; column: ColumnDef },
): { reason: Mismatch; detail: string } | null {
  const a = typeInfo(child.column);
  const b = typeInfo(parent.column);
  if (a.family === 'blob' || b.family === 'blob') return { reason: 'blob', detail: '' };
  const judged: TypeFamily[] = [
    'int',
    'decimal',
    'string',
    'binary',
    'date',
    'datetime',
    'time',
    'year',
  ];
  if (!judged.includes(a.family) || !judged.includes(b.family)) return null;
  if (a.family !== b.family) return { reason: 'kind', detail: '' };
  if (a.family === 'int') {
    if (a.base !== b.base) return { reason: 'size', detail: `${a.base} / ${b.base}` };
    if (a.unsigned !== b.unsigned) return { reason: 'sign', detail: '' };
  }
  if (a.family === 'string') {
    const x = effectiveCollation(schema, child.table, a);
    const y = effectiveCollation(schema, parent.table, b);
    if (x.charset !== y.charset)
      return { reason: 'charset', detail: `${x.charset} / ${y.charset}` };
    if (x.collation && y.collation && x.collation !== y.collation) {
      return { reason: 'collation', detail: `${x.collation} / ${y.collation}` };
    }
  }
  return null;
}
