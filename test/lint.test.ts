import { describe, expect, it } from 'vitest';
import { lint } from '../src/core/lint';
import { parseSchema } from '../src/core/parser';
import { toView } from '../src/core/view';
import { fixture } from './helpers';

// Errors and warnings; the notes (signs of antipatterns read from names) are tested on their own.
const codes = (sql: string) =>
  lint(parseSchema(sql))
    .filter((d) => d.severity !== 'info')
    .map((d) => `${d.severity}:${d.code}`);

describe('lint', () => {
  it('warns that MySQL 8.0 ignores REFERENCES written inside a column', () => {
    const d = lint(parseSchema(fixture('edge-cases.sql'))).filter(
      (x) => x.code === 'inline-references-ignored',
    );
    expect(d).toHaveLength(1);
    expect(d[0]?.params).toEqual({ table: 'my table', column: 'ref_id' });
  });

  it('finds nothing to say about the clean fixtures', () => {
    expect(codes(fixture('library.sql'))).toEqual([]);
    expect(codes(fixture('marketplace.sql'))).toEqual([]);
  });

  it('reports references that point nowhere', () => {
    const sql = `
      CREATE TABLE a (id INT, PRIMARY KEY (id, missing));
      CREATE TABLE b (
        a_id INT,
        x INT,
        FOREIGN KEY (a_id) REFERENCES nowhere (id),
        FOREIGN KEY (a_id, x) REFERENCES a (id),
        FOREIGN KEY (x) REFERENCES a (nope)
      );`;
    expect(codes(sql)).toEqual([
      'error:unknown-column',
      'warning:fk-unknown-table',
      'error:fk-column-count',
      'error:fk-unknown-column',
    ]);
  });

  it('warns about a full-width space hidden in a name', () => {
    // "name　 VARCHAR(10)": MySQL reads the full-width space (U+3000) as part of the name.
    const fw = String.fromCharCode(0x3000);
    const d = lint(parseSchema(`CREATE TABLE t (名前${fw} VARCHAR(10))`));
    expect(d.map((x) => `${x.severity}:${x.code}`)).toEqual(['warning:fullwidth-space-in-name']);
    expect(d[0]?.params.name).toBe(`名前${fw}`);
  });

  it('warns when no index of the referenced table starts with the referenced columns', () => {
    const sql = `
      CREATE TABLE sellers (id BIGINT PRIMARY KEY, tenant_id BIGINT NOT NULL);
      CREATE TABLE purchases (
        id BIGINT PRIMARY KEY,
        tenant_id BIGINT NOT NULL,
        seller_id BIGINT NOT NULL,
        FOREIGN KEY (tenant_id, seller_id) REFERENCES sellers (tenant_id, id)
      );`;
    // MySQL 8.0 rejects this foreign key: "Missing index for constraint".
    expect(codes(sql)).toEqual(['warning:fk-target-not-indexed']);
    // With UNIQUE (tenant_id, id) on sellers, the same foreign key is fine.
    const withKey = (key: string) =>
      sql.replace('tenant_id BIGINT NOT NULL);', `tenant_id BIGINT NOT NULL, ${key});`);
    expect(codes(withKey('UNIQUE KEY (tenant_id, id)'))).toEqual([]);
    // A plain index starting with those columns is enough; another order is not
    // (both as MySQL 8.0.46 does).
    expect(codes(withKey('name VARCHAR(10), KEY (tenant_id, id, name)'))).toEqual([]);
    expect(codes(withKey('UNIQUE KEY (id, tenant_id)'))).toEqual(['warning:fk-target-not-indexed']);
  });

  it('does not take an index with a prefix length for the one a foreign key needs', () => {
    const sql = `
      CREATE TABLE p (id BIGINT PRIMARY KEY, code VARCHAR(20) NOT NULL, KEY (code(5)));
      CREATE TABLE c (id BIGINT PRIMARY KEY, code VARCHAR(20), FOREIGN KEY (code) REFERENCES p (code));`;
    // MySQL 8.0.46: error 1822, "Missing index for constraint".
    expect(codes(sql)).toEqual(['warning:fk-target-not-indexed']);
  });

  it('reports duplicate tables and columns', () => {
    expect(codes('CREATE TABLE t (a INT, A INT); CREATE TABLE T (b INT);')).toEqual([
      'error:duplicate-table',
      'error:duplicate-column',
    ]);
  });
});

describe('lint: signs of SQL antipatterns', () => {
  const smell = (sql: string) =>
    lint(parseSchema(sql))
      .filter((d) =>
        [
          'id-column-without-fk',
          'fk-without-shared-column',
          'approximate-number-for-money',
          'numbered-columns',
        ].includes(d.code),
      )
      .map((d) => `${d.severity}:${d.code}:${Object.values(d.params).join('|')}`);

  it('notes a column named like a reference that no foreign key uses (Keyless Entry)', () => {
    const sql = `
      CREATE TABLE customers (id INT PRIMARY KEY);
      CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, ownerId INT, 担当者ID INT);`;
    expect(smell(sql)).toEqual([
      'info:id-column-without-fk:orders|customer_id',
      'info:id-column-without-fk:orders|ownerId',
      'info:id-column-without-fk:orders|担当者ID',
    ]);
    // With a foreign key, the same column is fine.
    expect(
      smell(
        `${sql.replace('担当者ID INT)', '担当者ID INT, FOREIGN KEY (customer_id) REFERENCES customers (id))')}`,
      ),
    ).toEqual([
      'info:id-column-without-fk:orders|ownerId',
      'info:id-column-without-fk:orders|担当者ID',
    ]);
  });

  it("does not take a table's own key, named after the table, for a reference", () => {
    expect(
      smell(`
        CREATE TABLE tenants (tenant_id INT PRIMARY KEY);
        CREATE TABLE companies (company_id INT PRIMARY KEY);
        CREATE TABLE purchase_files (purchase_file_id INT, tenantId INT, PRIMARY KEY (purchase_file_id),
          FOREIGN KEY (tenantId) REFERENCES tenants (tenant_id));
        CREATE TABLE tenants (tenant_id INT PRIMARY KEY);
        CREATE TABLE purchase_details (purchase_id INT PRIMARY KEY);
        CREATE TABLE users (id INT PRIMARY KEY, user_id INT);`),
    ).toEqual([
      // A primary key named after another table (a one-to-one table) still needs its key.
      'info:id-column-without-fk:purchase_details|purchase_id',
      // Named after its table but outside the primary key: not the table's own key.
      'info:id-column-without-fk:users|user_id',
    ]);
  });

  it('does not take id, uuid or paid for references, nor a column whose REFERENCES has its own warning', () => {
    expect(
      smell('CREATE TABLE t (id INT PRIMARY KEY, uuid CHAR(36), paid TINYINT, ID2 INT)'),
    ).toEqual([]);
    expect(smell(fixture('edge-cases.sql')).filter((x) => x.includes('ref_id'))).toEqual([]);
  });

  it('warns when a foreign key leaves out the column the others carry (a tenant_id)', () => {
    const sql = `
      CREATE TABLE tenants (id INT PRIMARY KEY);
      CREATE TABLE sellers (id INT PRIMARY KEY, tenant_id INT NOT NULL, UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (id));
      CREATE TABLE purchases (id INT PRIMARY KEY, tenant_id INT NOT NULL, seller_id INT NOT NULL,
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, seller_id) REFERENCES sellers (tenant_id, id));
      CREATE TABLE files (id INT PRIMARY KEY, tenant_id INT NOT NULL, purchase_id INT NOT NULL,
        FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases (tenant_id, id));
      CREATE TABLE notes (id INT PRIMARY KEY, tenant_id INT NOT NULL, purchase_id INT NOT NULL,
        FOREIGN KEY (purchase_id) REFERENCES purchases (id));`;
    // notes → purchases can point at an purchase of another tenant; notes.tenant_id
    // is in no foreign key at all.
    expect(smell(sql)).toEqual([
      'info:id-column-without-fk:notes|tenant_id',
      'warning:fk-without-shared-column:notes|purchases|tenant_id',
    ]);
    // With the tenant in the key, nothing to say.
    const fixed = sql.replace(
      'FOREIGN KEY (purchase_id) REFERENCES purchases (id)',
      'FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases (tenant_id, id)',
    );
    expect(smell(fixed)).toEqual([]);
  });

  it('finds the example table of the fixture that has a tenant column but no foreign key', () => {
    expect(smell(fixture('library.sql'))).toEqual([
      'info:id-column-without-fk:member_codes|tenant_id',
    ]);
    expect(smell(fixture('marketplace.sql'))).toEqual([]);
  });

  it('asks the shared column of both tables, and of keys of several columns', () => {
    // A key to a table without tenant_id (users are global) leaves nothing out.
    const global = `
      CREATE TABLE users (id INT PRIMARY KEY);
      CREATE TABLE a (id INT PRIMARY KEY, tenant_id INT, x_id INT, UNIQUE (tenant_id, id));
      CREATE TABLE b (id INT PRIMARY KEY, tenant_id INT, a_id INT, user_id INT,
        FOREIGN KEY (tenant_id, a_id) REFERENCES a (tenant_id, id),
        FOREIGN KEY (user_id) REFERENCES users (id));
      CREATE TABLE c (id INT PRIMARY KEY, tenant_id INT, a_id INT,
        FOREIGN KEY (tenant_id, a_id) REFERENCES a (tenant_id, id));`;
    expect(smell(global).filter((x) => x.includes('shared'))).toEqual([]);
    // Single-column keys that share a name (order_id) are not a tenant: none is composite.
    expect(smell(fixture('orders.sql')).filter((x) => x.includes('shared'))).toEqual([]);
  });

  it('warns about money in FLOAT, DOUBLE or REAL (Rounding Errors), whatever the case', () => {
    expect(
      smell(`CREATE TABLE t (price FLOAT, total_amount double precision, 金額 REAL(10,2),
        ratio FLOAT, cost DECIMAL(10,2))`),
    ).toEqual([
      'warning:approximate-number-for-money:t|price|FLOAT',
      'warning:approximate-number-for-money:t|total_amount|double precision',
      'warning:approximate-number-for-money:t|金額|REAL(10,2)',
    ]);
  });

  it('notes numbered columns (Multicolumn Attributes), but not one alone', () => {
    expect(smell('CREATE TABLE t (id INT, tag1 TEXT, tag2 TEXT, Tag3 TEXT, s3_key TEXT)')).toEqual([
      'info:numbered-columns:t|tag1, tag2, Tag3',
    ]);
    expect(smell('CREATE TABLE t (id INT, phone1 TEXT, s3 TEXT)')).toEqual([]);
  });
});

describe('toView', () => {
  it('gives every constraint an id and the text the server will look for', () => {
    const src = fixture('library.sql');
    const v = toView(parseSchema(src), 'library.sql', 1);
    const inv = v.tables.find((t) => t.name === 'loans');
    expect(inv?.foreignKeys.map((f) => f.id)).toEqual(['foreign:0', 'foreign:1', 'foreign:2']);
    expect(inv?.checks[1]).toMatchObject({ text: 'CHECK (fee > 0)', expr: 'fee > 0' });
    expect(inv?.columns.find((c) => c.name === 'member_id')).toMatchObject({
      foreignKey: true,
      primaryKey: false,
    });
    expect(inv?.line).toBe(37);
  });
});
