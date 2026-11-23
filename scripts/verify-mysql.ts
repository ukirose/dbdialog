// Runs the fixtures, and the fixtures after a series of diagram edits, in a
// real MySQL 8.0 (Docker), then checks that MySQL read the same comments,
// CHECK constraints, generated columns and foreign keys as dbdialog did.
//
//   npm run verify:mysql
//
// The mysql client in the image defaults to latin1, which silently garbles
// Japanese text and then garbles it back when read with the same setting.
// Every call passes --default-character-set=utf8mb4, and comments are compared
// as text after reading them back.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, lint, type Op, parseSchema } from '../src/core/index';
import { caseSql, FK_CASES } from '../test/fixtures/fk-cases';

const MYSQL = [
  'compose',
  'exec',
  '-T',
  'db',
  'mysql',
  '--default-character-set=utf8mb4',
  '-uroot',
  '--batch',
  '--raw',
  '--skip-column-names',
];

function mysql(sql: string, db?: string): string {
  return execFileSync('docker', [...MYSQL, ...(db ? ['-D', db] : [])], {
    input: sql,
    encoding: 'utf8',
  });
}

function rows(sql: string, db: string): string[][] {
  return mysql(sql, db)
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split('\t'));
}

const fixture = (name: string) =>
  readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Edits a person would make in the diagram (the same operations the GUI sends).
const EDITS: Record<string, Op[]> = {
  'library.sql': [
    {
      op: 'column.update',
      table: 'loans',
      column: 'status',
      set: { comment: 'How far it has gone' },
    },
    {
      op: 'column.add',
      table: 'loans',
      after: 'fee',
      column: { name: 'due_date', type: 'DATE', nullable: true, comment: 'Due date' },
    },
    {
      op: 'check.add',
      table: 'loans',
      expr: "due_date IS NULL OR status <> 'new'",
      name: 'chk_loans_due',
    },
    { op: 'column.update', table: 'members', column: 'ID', set: { name: 'member_number' } },
    {
      op: 'fk.add',
      table: 'member_codes',
      fk: {
        columns: ['tenant_id'],
        refTable: 'tenants',
        refColumns: ['ID'],
        onDelete: 'RESTRICT',
      },
    },
    {
      op: 'column.update',
      table: 'member_codes',
      column: 'alive',
      set: { generated: { expr: 'IF(deleted_at IS NULL, 1, NULL)', storage: 'VIRTUAL' } },
    },
    { op: 'table.setComment', table: 'loans', comment: 'Loans (books lent out)' },
    {
      op: 'table.add',
      name: 'fines',
      comment: 'Fines paid',
      columns: [
        {
          name: 'ID',
          type: 'BIGINT UNSIGNED',
          nullable: false,
          autoIncrement: true,
          comment: 'Fine ID',
        },
      ],
      primaryKey: ['ID'],
    },
    {
      op: 'column.add',
      table: 'fines',
      column: {
        name: 'tenant_id',
        type: 'BIGINT UNSIGNED',
        nullable: false,
        comment: 'Tenant ID',
      },
    },
    {
      op: 'column.add',
      table: 'fines',
      column: { name: 'loan_id', type: 'BIGINT UNSIGNED', nullable: false, comment: 'Loan ID' },
    },
    {
      op: 'fk.add',
      table: 'fines',
      fk: {
        name: 'fk_fines_loans',
        columns: ['tenant_id', 'loan_id'],
        refTable: 'loans',
        refColumns: ['tenant_id', 'ID'],
      },
    },
  ],
  'marketplace.sql': [
    {
      op: 'column.update',
      table: 'purchases',
      column: 'amount_excl_tax',
      set: { generated: { expr: 'amount - IFNULL(tax_amount, 0)', storage: 'STORED' } },
    },
    {
      op: 'column.update',
      table: 'sellers',
      column: 'code',
      set: { type: 'VARCHAR(32)', comment: "Seller code ('internal')" },
    },
    {
      op: 'column.update',
      table: 'categories',
      column: 'parent_id',
      set: { name: 'parent_category_id' },
    },
    {
      op: 'fk.update',
      table: 'purchases',
      target: {
        id: 'foreign:0',
        text: 'CONSTRAINT fk_purchases_seller FOREIGN KEY (tenant_id, seller_id) REFERENCES sellers (tenant_id, id)',
      },
      fk: { onDelete: 'RESTRICT' },
    },
    { op: 'table.rename', table: 'shipments', to: 'deliveries' },
  ],
  'japanese.sql': [
    {
      op: 'column.add',
      table: '作品',
      after: '題名',
      column: { name: '副題', type: 'VARCHAR(200)', nullable: true, comment: '副題' },
    },
    { op: 'column.update', table: '作品', column: '状態', set: { comment: '執筆の段階' } },
    { op: 'column.update', table: '作家', column: '名前', set: { name: '筆名' } },
    // The key 作品 references: its foreign key follows the new name.
    { op: 'column.update', table: '作家', column: 'ID', set: { name: '作家番号' } },
    { op: 'table.rename', table: '章', to: '節' },
    { op: 'table.setComment', table: '作品', comment: '書かれた作品' },
  ],
};

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failures++;
  process.stdout.write(`${ok ? '  ok  ' : '  NG  '}${what}\n`);
}

/** Runs one SQL file in a fresh database and compares MySQL's catalog with dbdialog's model. */
function verify(label: string, sql: string): void {
  process.stdout.write(`\n# ${label}\n`);
  const db = `dbdialog_verify_${Date.now()}`;
  mysql(`DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db} CHARACTER SET utf8mb4;`);
  try {
    mysql(sql, db);
    check(true, 'MySQL 8.0 ran the file without errors');
  } catch (e) {
    check(false, `MySQL 8.0 rejected the file: ${(e as { stderr?: string }).stderr ?? e}`);
    return;
  }
  const schema = parseSchema(sql);
  const q = (s: string) => rows(s, db);

  const tableComments = new Map(
    q(
      `SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db}'`,
    ).map(([n, c]) => [n, c]),
  );
  const columnComments = new Map(
    q(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${db}'`,
    ).map(([t, c, comment, extra, gen]) => [`${t}.${c}`, { comment, extra, gen }]),
  );
  const checks = q(
    `SELECT TABLE_NAME, COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = '${db}' AND CONSTRAINT_TYPE = 'CHECK' GROUP BY TABLE_NAME`,
  );
  const fks = q(
    `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION), k.REFERENCED_TABLE_NAME,
            GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION), r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = '${db}' AND k.REFERENCED_TABLE_NAME IS NOT NULL
      GROUP BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE`,
  ).map(([t, , cols, ref, refCols, rule]) => `${t}(${cols})->${ref}(${refCols}) ${rule}`);

  let commentsOk = 0;
  let commentsAll = 0;
  for (const t of schema.tables) {
    commentsAll++;
    if ((tableComments.get(t.name) ?? null) === (t.comment?.value ?? '')) commentsOk++;
    else
      check(
        false,
        `table comment of ${t.name}: MySQL has ${JSON.stringify(tableComments.get(t.name))}`,
      );
    for (const c of t.columns) {
      commentsAll++;
      const m = columnComments.get(`${t.name}.${c.name}`);
      if (m && m.comment === (c.comment?.value ?? '')) commentsOk++;
      else
        check(
          false,
          `column comment of ${t.name}.${c.name}: MySQL has ${JSON.stringify(m?.comment)}`,
        );
      if (c.generated) {
        const want = c.generated.storage === 'STORED' ? 'STORED GENERATED' : 'VIRTUAL GENERATED';
        check(
          m?.extra === want && (m?.gen ?? '') !== '',
          `generated column ${t.name}.${c.name} is ${want}`,
        );
      }
    }
  }
  const japanese = schema.tables
    .flatMap((t) => [t.comment?.value ?? '', ...t.columns.map((c) => c.comment?.value ?? '')])
    .some((text) => JAPANESE.test(text));
  check(
    commentsOk === commentsAll,
    `${commentsOk}/${commentsAll} table and column comments read back identically${japanese ? ' (Japanese included)' : ''}`,
  );

  const checkCount = Object.fromEntries(checks.map(([t, n]) => [t, Number(n)]));
  for (const t of schema.tables) {
    check(
      (checkCount[t.name] ?? 0) === t.checks.length,
      `${t.name}: ${t.checks.length} CHECK constraint(s)`,
    );
  }

  const expected = schema.tables.flatMap((t) =>
    t.foreignKeys
      .filter((f) => f.origin === 'table')
      .map(
        (f) =>
          `${t.name}(${f.columns.parts.map((p) => p.column).join(',')})->${f.ref.table.name}(${f.ref.columns?.parts.map((p) => p.column).join(',')}) ${f.ref.onDelete ?? 'NO ACTION'}`,
      ),
  );
  for (const e of expected) check(fks.includes(e), `foreign key ${e}`);
  check(
    fks.length === expected.length,
    `MySQL has exactly the ${expected.length} foreign keys dbdialog drew`,
  );
  mysql(`DROP DATABASE ${db};`);
}

process.stdout.write('Starting MySQL 8.0 (docker compose up -d --wait)…\n');
execFileSync('docker', ['compose', 'up', '-d', '--wait', 'db'], { stdio: 'inherit' });
process.stdout.write(`MySQL ${mysql('SELECT VERSION();').trim()}\n`);

const out = join(tmpdir(), 'dbdialog-verify');
mkdirSync(out, { recursive: true });
for (const [name, ops] of Object.entries(EDITS)) {
  const original = fixture(name);
  verify(`${name} as written`, original);
  const edited = applyOps(original, ops);
  writeFileSync(join(out, `edited-${name}`), edited);
  verify(
    `${name} after ${ops.length} diagram edits (saved to ${join(out, `edited-${name}`)})`,
    edited,
  );
}

// Foreign key rules: each case must fail in MySQL exactly when DBdialog reports an error for it.
process.stdout.write('\n# foreign key rules (MySQL refuses exactly what DBdialog reports)\n');
const FK_CODES = new Set([
  'fk-type-mismatch',
  'fk-blob-column',
  'fk-virtual-column',
  'fk-generated-action',
  'fk-generated-base-action',
]);
for (const c of FK_CASES) {
  const caseDb = `dbdialog_verify_fk_${Date.now()}`;
  mysql(`CREATE DATABASE ${caseDb};`);
  let error: number | null = null;
  try {
    mysql(caseSql(c), caseDb);
  } catch (e) {
    const m = /ERROR (\d+)/.exec(String((e as { stderr?: string }).stderr ?? ''));
    error = m ? Number(m[1]) : -1;
  }
  mysql(`DROP DATABASE ${caseDb};`);
  const reported = lint(parseSchema(caseSql(c))).find((d) => FK_CODES.has(d.code))?.code ?? null;
  check(
    error === c.mysqlError && reported === c.lint,
    `${c.name}: MySQL ${error === null ? 'accepts' : `error ${error}`}, DBdialog ${reported ?? 'reports nothing'}`,
  );
}

// The warning about inline REFERENCES: MySQL 8.0 really creates no foreign key.
process.stdout.write('\n# inline REFERENCES\n');
const inline = 'CREATE TABLE p (id INT PRIMARY KEY); CREATE TABLE c (p_id INT REFERENCES p (id));';
const db = `dbdialog_verify_inline_${Date.now()}`;
mysql(`CREATE DATABASE ${db};`);
mysql(inline, db);
const created = rows(
  `SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '${db}'`,
  db,
)[0]?.[0];
mysql(`DROP DATABASE ${db};`);
check(created === '0', 'MySQL 8.0 accepted the inline REFERENCES and created no foreign key');
check(
  lint(parseSchema(inline)).some((d) => d.code === 'inline-references-ignored'),
  'dbdialog warns about it',
);

process.stdout.write(
  `\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
