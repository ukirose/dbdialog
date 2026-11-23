// Reading and writing small pieces of MySQL text: identifiers, string
// literals, and the display width used to keep aligned columns aligned.

import { isIdentPartCode } from './lexer';

/** MySQL 8.0 reserved words: an identifier spelled like one must be quoted. */
const RESERVED = new Set(
  `ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY
  CALL CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT
  CREATE CROSS CUBE CUME_DIST CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE
  DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL DECLARE DEFAULT DELAYED DELETE
  DENSE_RANK DESC DESCRIBE DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH ELSE ELSEIF
  EMPTY ENCLOSED ESCAPED EXCEPT EXISTS EXIT EXPLAIN FALSE FETCH FIRST_VALUE FLOAT FLOAT4 FLOAT8 FOR
  FORCE FOREIGN FROM FULLTEXT FUNCTION GENERATED GET GRANT GROUP GROUPING GROUPS HAVING HIGH_PRIORITY
  HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN INDEX INFILE INNER INOUT INSENSITIVE INSERT INT
  INT1 INT2 INT3 INT4 INT8 INTEGER INTERSECT INTERVAL INTO IO_AFTER_GTIDS IO_BEFORE_GTIDS IS ITERATE
  JOIN JSON_TABLE KEY KEYS KILL LAG LAST_VALUE LATERAL LEAD LEADING LEAVE LEFT LIKE LIMIT LINEAR LINES
  LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP LOW_PRIORITY MASTER_BIND
  MASTER_SSL_VERIFY_SERVER_CERT MATCH MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT MIDDLEINT
  MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NTH_VALUE NTILE NULL
  NUMERIC OF ON OPTIMIZE OPTIMIZER_COSTS OPTION OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PARTITION
  PERCENT_RANK PRECISION PRIMARY PROCEDURE PURGE RANGE RANK READ READS READ_WRITE REAL RECURSIVE
  REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN REVOKE RIGHT RLIKE
  ROW ROWS ROW_NUMBER SCHEMA SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW SIGNAL
  SMALLINT SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS
  SQL_SMALL_RESULT SSL STARTING STORED STRAIGHT_JOIN SYSTEM TABLE TERMINATED THEN TINYBLOB TINYINT
  TINYTEXT TO TRAILING TRIGGER TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE
  UTC_TIME UTC_TIMESTAMP VALUES VARBINARY VARCHAR VARCHARACTER VARYING VIRTUAL WHEN WHERE WHILE WINDOW
  WITH WRITE XOR YEAR_MONTH ZEROFILL`.split(/\s+/),
);

export function isReservedWord(word: string): boolean {
  return RESERVED.has(word.toUpperCase());
}

export function unquoteIdent(text: string): string {
  if (text.startsWith('`')) {
    const inner = text.endsWith('`') && text.length > 1 ? text.slice(1, -1) : text.slice(1);
    return inner.replace(/``/g, '`');
  }
  return text;
}

export function needsQuoting(name: string): boolean {
  if (name === '' || /^[0-9]+$/.test(name) || isReservedWord(name)) return true;
  for (let i = 0; i < name.length; i++) {
    if (!isIdentPartCode(name.charCodeAt(i))) return true;
  }
  // Something like "1e5" would be read back as a number.
  return /^[0-9]+[eE][0-9]+$/.test(name) || /^0x[0-9a-fA-F]+$/.test(name) || /^0b[01]+$/.test(name);
}

export function quoteIdent(name: string, always = false): string {
  return always || needsQuoting(name) ? `\`${name.replace(/`/g, '``')}\`` : name;
}

const DECODE_ESCAPES: Record<string, string> = {
  '0': '\0',
  "'": "'",
  '"': '"',
  b: '\b',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '\x1a',
  '\\': '\\',
  '%': '\\%',
  _: '\\_',
};

/** Value of one string token: '…', "…" or N'…' (hex and bit literals stay as written). */
export function decodeStringToken(text: string): string {
  let body = text;
  const first = body[0];
  if (first === 'x' || first === 'X' || first === 'b' || first === 'B') return text;
  if (first === 'n' || first === 'N') body = body.slice(1);
  const q = body[0];
  const inner = body.endsWith(q ?? '') && body.length > 1 ? body.slice(1, -1) : body.slice(1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (c === '\\' && i + 1 < inner.length) {
      const e = inner[i + 1] as string;
      out += DECODE_ESCAPES[e] ?? e;
      i++;
    } else if (c === q && inner[i + 1] === q) {
      out += c;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** A string literal MySQL reads back as `value` (default sql_mode: backslash escapes on). */
export function encodeString(value: string, quote: "'" | '"' = "'"): string {
  let out = '';
  for (const c of value) {
    if (c === '\\') out += '\\\\';
    else if (c === quote) out += quote + quote;
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\0') out += '\\0';
    else if (c === '\x1a') out += '\\Z';
    else out += c;
  }
  return quote + out + quote;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Columns a string takes in a monospaced editor (East Asian wide characters count 2). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}
