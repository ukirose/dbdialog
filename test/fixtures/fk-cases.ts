// Foreign keys MySQL 8.0 accepts or refuses, with the error it gives and the
// diagnostic DBdialog must report. Recorded from MySQL 8.0.46 on 2026-10-25;
// `npm run verify:mysql` replays them against a real server.

export interface FkCase {
  name: string;
  parent: string;
  child: string;
  parentOptions?: string;
  childOptions?: string;
  checksOff?: boolean;
  mysqlError: number | null;
  lint: string | null;
}

export const FK_CASES: FkCase[] = [
  {
    name: 'integer sign',
    parent: 'id BIGINT UNSIGNED PRIMARY KEY',
    child: 'pid BIGINT, FOREIGN KEY (pid) REFERENCES p (id)',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'integer size',
    parent: 'id INT PRIMARY KEY',
    child: 'pid BIGINT, FOREIGN KEY (pid) REFERENCES p (id)',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'display width',
    parent: 'id INT(11) PRIMARY KEY',
    child: 'pid INT, FOREIGN KEY (pid) REFERENCES p (id)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'BOOLEAN is TINYINT(1)',
    parent: 'id TINYINT(1) PRIMARY KEY',
    child: 'pid BOOLEAN, FOREIGN KEY (pid) REFERENCES p (id)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'DECIMAL scale',
    parent: 'id DECIMAL(15,0) PRIMARY KEY',
    child: 'pid DECIMAL(15,2), FOREIGN KEY (pid) REFERENCES p (id)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'DECIMAL precision',
    parent: 'id DECIMAL(15,0) PRIMARY KEY',
    child: 'pid DECIMAL(10,0), FOREIGN KEY (pid) REFERENCES p (id)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'VARCHAR length',
    parent: 'code VARCHAR(20) PRIMARY KEY',
    child: 'code VARCHAR(10), FOREIGN KEY (code) REFERENCES p (code)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'CHAR and VARCHAR',
    parent: 'code CHAR(10) PRIMARY KEY',
    child: 'code VARCHAR(10), FOREIGN KEY (code) REFERENCES p (code)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'collation',
    parent: 'code VARCHAR(10) COLLATE utf8mb4_bin PRIMARY KEY',
    child: 'code VARCHAR(10) COLLATE utf8mb4_0900_ai_ci, FOREIGN KEY (code) REFERENCES p (code)',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'column character set',
    parent: 'code VARCHAR(10) CHARACTER SET latin1 PRIMARY KEY',
    child: 'code VARCHAR(10) CHARACTER SET utf8mb4, FOREIGN KEY (code) REFERENCES p (code)',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'table character set',
    parent: 'code VARCHAR(10) PRIMARY KEY',
    child: 'code VARCHAR(10), FOREIGN KEY (code) REFERENCES p (code)',
    parentOptions: ' DEFAULT CHARSET=latin1',
    childOptions: ' DEFAULT CHARSET=utf8mb4',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'TEXT column',
    parent: 'code VARCHAR(10) PRIMARY KEY',
    child: 'code TEXT, FOREIGN KEY (code) REFERENCES p (code)',
    mysqlError: 1170,
    lint: 'fk-blob-column',
  },
  {
    name: 'DATETIME and TIMESTAMP',
    parent: 'd DATETIME PRIMARY KEY',
    child: 'd TIMESTAMP NULL, FOREIGN KEY (d) REFERENCES p (d)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'DATE and DATETIME',
    parent: 'd DATE PRIMARY KEY',
    child: 'd DATETIME, FOREIGN KEY (d) REFERENCES p (d)',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'VIRTUAL parent column',
    parent: 'a INT, v INT AS (a + 1) VIRTUAL, KEY (v)',
    child: 'pv INT, FOREIGN KEY (pv) REFERENCES p (v)',
    mysqlError: 3733,
    lint: 'fk-virtual-column',
  },
  {
    name: 'STORED parent column',
    parent: 'a INT, s INT AS (a + 1) STORED, UNIQUE KEY (s)',
    child: 'ps INT, FOREIGN KEY (ps) REFERENCES p (s)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'VIRTUAL child column',
    parent: 'id INT PRIMARY KEY',
    child: 'a INT, v INT AS (a) VIRTUAL, FOREIGN KEY (v) REFERENCES p (id)',
    mysqlError: 3733,
    lint: 'fk-virtual-column',
  },
  {
    name: 'STORED child, ON DELETE SET NULL',
    parent: 'id INT PRIMARY KEY',
    child: 'a INT, s INT AS (a) STORED, FOREIGN KEY (s) REFERENCES p (id) ON DELETE SET NULL',
    mysqlError: 3104,
    lint: 'fk-generated-action',
  },
  {
    name: 'STORED child, ON DELETE CASCADE',
    parent: 'id INT PRIMARY KEY',
    child: 'a INT, s INT AS (a) STORED, FOREIGN KEY (s) REFERENCES p (id) ON DELETE CASCADE',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'STORED child, ON UPDATE CASCADE',
    parent: 'id INT PRIMARY KEY',
    child: 'a INT, s INT AS (a) STORED, FOREIGN KEY (s) REFERENCES p (id) ON UPDATE CASCADE',
    mysqlError: 3104,
    lint: 'fk-generated-action',
  },
  {
    name: 'base of a STORED column, CASCADE',
    parent: 'id INT PRIMARY KEY',
    child: 'a INT, s INT AS (a + 1) STORED, FOREIGN KEY (a) REFERENCES p (id) ON DELETE CASCADE',
    mysqlError: 1215,
    lint: 'fk-generated-base-action',
  },
  {
    name: 'base of a STORED column, no action',
    parent: 'id INT PRIMARY KEY',
    child: 'a INT, s INT AS (a + 1) STORED, FOREIGN KEY (a) REFERENCES p (id)',
    mysqlError: null,
    lint: null,
  },
  {
    name: 'same ENUM',
    parent: "k ENUM('a','b') PRIMARY KEY",
    child: "k ENUM('a','b'), FOREIGN KEY (k) REFERENCES p (k)",
    mysqlError: null,
    lint: null,
  },
  {
    name: 'different ENUM members',
    parent: "k ENUM('a','b') PRIMARY KEY",
    child: "k ENUM('a','b','c'), FOREIGN KEY (k) REFERENCES p (k)",
    mysqlError: null,
    lint: null,
  },
  {
    name: 'VARCHAR and VARBINARY',
    parent: 'code VARCHAR(10) PRIMARY KEY',
    child: 'code VARBINARY(10), FOREIGN KEY (code) REFERENCES p (code)',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'one pair of a composite key',
    parent:
      'tenant_id BIGINT UNSIGNED, id BIGINT UNSIGNED, PRIMARY KEY (id), UNIQUE KEY (tenant_id, id)',
    child:
      'tenant_id BIGINT UNSIGNED, pid BIGINT, FOREIGN KEY (tenant_id, pid) REFERENCES p (tenant_id, id)',
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
  {
    name: 'FOREIGN_KEY_CHECKS=0 does not help',
    parent: 'id BIGINT UNSIGNED PRIMARY KEY',
    child: 'pid BIGINT, FOREIGN KEY (pid) REFERENCES p (id)',
    checksOff: true,
    mysqlError: 3780,
    lint: 'fk-type-mismatch',
  },
];

/** The schema text of one case, as a schema.sql would hold it. */
export function caseSql(c: FkCase): string {
  return `${c.checksOff ? 'SET FOREIGN_KEY_CHECKS = 0;\n' : ''}CREATE TABLE p (${c.parent})${c.parentOptions ?? ''};\nCREATE TABLE c (${c.child})${c.childOptions ?? ''};\n`;
}
