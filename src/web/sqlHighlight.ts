// Colors for the SQL in the sidebar. DBdialog's own lexer splits the text, so
// it follows MySQL exactly (Japanese names, `--` needing a space after it).

import { lex, type Token } from '../core/lexer';

export type TokenClass = 'keyword' | 'type' | 'string' | 'number' | 'comment' | 'plain';

const KEYWORDS = new Set(
  `ACTION ADD ALTER ALWAYS AND AS ASC AUTO_INCREMENT BETWEEN BY CASCADE CASE CHARACTER CHARSET
  CHECK COLLATE COLUMN COMMENT CONSTRAINT CREATE CURRENT_TIMESTAMP DEFAULT DELETE DESC DROP ELSE
  END ENFORCED ENGINE EXISTS FALSE FOREIGN FULL FULLTEXT GENERATED IF IN INDEX IS KEY LIKE MATCH
  NO NOT NULL ON OR PARTIAL PRIMARY REFERENCES RESTRICT SET SIMPLE SPATIAL STORED TABLE TEMPORARY
  THEN TRUE UNIQUE UPDATE USING VIRTUAL WHEN`.split(/\s+/),
);

const TYPES = new Set(
  `BIGINT BINARY BIT BLOB BOOL BOOLEAN CHAR DATE DATETIME DEC DECIMAL DOUBLE ENUM FIXED FLOAT
  GEOMETRY INT INTEGER JSON LONGBLOB LONGTEXT MEDIUMBLOB MEDIUMINT MEDIUMTEXT NUMERIC POINT REAL
  SIGNED SMALLINT TEXT TIME TIMESTAMP TINYBLOB TINYINT TINYTEXT UNSIGNED VARBINARY VARCHAR YEAR
  ZEROFILL`.split(/\s+/),
);

function classify(tok: Token): TokenClass {
  switch (tok.kind) {
    case 'comment':
    case 'exec_comment':
      return 'comment';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'ident': {
      const word = tok.text.toUpperCase();
      if (TYPES.has(word)) return 'type';
      if (KEYWORDS.has(word)) return 'keyword';
      return 'plain';
    }
    default:
      return 'plain';
  }
}

/** The text cut into colored runs; joined back, the runs are the input exactly. */
export function highlightSql(sql: string): { text: string; cls: TokenClass }[] {
  const out: { text: string; cls: TokenClass }[] = [];
  for (const tok of lex(sql)) {
    const cls = classify(tok);
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += tok.text;
    else out.push({ text: tok.text, cls });
  }
  return out;
}
