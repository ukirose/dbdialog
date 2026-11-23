import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSchema } from '../src/core/parser';
import { describeSelection, selectionSpot } from '../src/core/selection';
import { selectionContext } from '../src/server/hook';
import { createApp, listen } from '../src/server/http';
import { announce, announced } from '../src/server/registry';
import { SchemaFile } from '../src/server/state';
import { fixture } from './helpers';

describe('a selection on the diagram, as lines of the file', () => {
  const schema = parseSchema(fixture('library.sql'));
  const lines = (text: string) => text.split('\n');

  it('covers a whole table', () => {
    const spot = selectionSpot(schema, { table: 'loan_files', column: null, fkId: null });
    expect(spot?.label).toBe('table loan_files');
    expect(lines(spot?.text ?? '')[0]).toBe('CREATE TABLE loan_files (');
    expect(lines(spot?.text ?? '').at(-1)).toBe(');');
    const [a, b] = spot?.lines ?? [0, 0];
    expect(b - a + 1).toBe(lines(spot?.text ?? '').length);
  });

  it('covers the line of a column, or of a foreign key', () => {
    const column = selectionSpot(schema, {
      table: 'loan_files',
      column: 'LOAN_ID',
      fkId: null,
    });
    expect(column?.label).toBe('column loan_id of table loan_files');
    expect(column?.text).toBe('  loan_id   BIGINT UNSIGNED NOT NULL,');
    expect(column?.lines[0]).toBe(column?.lines[1]);
    const fk = schema.tables.find((t) => t.name === 'loan_files')?.foreignKeys[0];
    const line = selectionSpot(schema, {
      table: 'loan_files',
      column: null,
      fkId: fk?.id ?? '',
    });
    expect(line?.label).toBe(
      'foreign key (tenant_id, loan_id) → loans (tenant_id, ID) of table loan_files',
    );
    expect(line?.text).toContain('ON DELETE CASCADE');
  });

  it('is told with the path and the lines, as an editor selection is', () => {
    const spot = {
      label: 'table t',
      lines: [3, 5] as [number, number],
      text: 'CREATE TABLE t (\n);',
    };
    expect(describeSelection(spot, 'docs/schema.sql')).toBe(
      'Selected in DBdialog: docs/schema.sql lines 3-5 (table t)\n```sql\nCREATE TABLE t (\n);\n```\n',
    );
  });
});

describe('dbdialog hook', () => {
  const home = mkdtempSync(join(tmpdir(), 'dbdialog-home-'));
  const project = join(home, 'project');
  const file = join(project, 'docs', 'schema.sql');
  let base = '';
  let close = () => {};
  let unannounce = () => {};

  beforeAll(async () => {
    process.env.DBDIALOG_HOME = join(home, '.dbdialog');
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(file, fixture('library.sql'));
    const app = createApp({
      file: new SchemaFile(file, 'docs/schema.sql'),
      host: '127.0.0.1',
      port: 0,
      webRoot: null,
    });
    const port = await listen(app.server, '127.0.0.1', 0);
    base = `http://127.0.0.1:${port}`;
    close = app.close;
    unannounce = announce('127.0.0.1', port, file);
  });
  afterAll(() => {
    unannounce();
    close();
    delete process.env.DBDIALOG_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const select = (sel: unknown) =>
    fetch(`${base}/api/selection`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Dbdialog': '1' },
      body: JSON.stringify(sel),
    });

  it('tells each agent session about a selection once, with the path from its folder', async () => {
    await select({ table: 'loans', column: 'status', fkId: null });
    const first = await selectionContext({ cwd: project, session_id: 'a' });
    expect(first.split('\n')[0]).toMatch(
      /^Selected in DBdialog: docs\/schema\.sql line \d+ \(column status of table loans\)$/,
    );
    expect(await selectionContext({ cwd: project, session_id: 'a' })).toBe('');
    // Another session has not been told yet.
    expect(await selectionContext({ cwd: project, session_id: 'b' })).toBe(first);
    // A new selection is told again; nothing selected tells nothing.
    await select({ table: 'tenants', column: null, fkId: null });
    expect(await selectionContext({ cwd: project, session_id: 'a' })).toContain('(table tenants)');
    await select(null);
    expect(await selectionContext({ cwd: project, session_id: 'c' })).toBe('');
  });

  it('asks only the servers showing a schema inside the session folder', async () => {
    await select({ table: 'tenants', column: null, fkId: null });
    expect(await selectionContext({ cwd: join(home, 'elsewhere'), session_id: 'd' })).toBe('');
  });

  it('forgets servers that are gone', () => {
    const dead = join(process.env.DBDIALOG_HOME as string, 'servers', '1.json');
    writeFileSync(dead, JSON.stringify({ pid: 2 ** 22 + 7, host: '127.0.0.1', port: 1, file }));
    expect(announced().map((a) => a.port)).not.toContain(1);
  });
});
