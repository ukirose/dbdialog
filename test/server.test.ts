import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, listen } from '../src/server/http';
import type { State } from '../src/server/state';
import { SchemaFile } from '../src/server/state';
import { watchFile } from '../src/server/watch';

describe('HTTP API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbdialog-test-'));
  const path = join(dir, 'schema.sql');
  copyFileSync(fileURLToPath(new URL('./fixtures/marketplace.sql', import.meta.url)), path);
  const original = readFileSync(path, 'utf8');
  const file = new SchemaFile(path, 'schema.sql');
  const app = createApp({ file, host: '127.0.0.1', port: 0, webRoot: null });
  let base = '';
  let stopWatching = () => {};

  beforeAll(async () => {
    const port = await listen(app.server, '127.0.0.1', 0);
    base = `http://127.0.0.1:${port}`;
    stopWatching = watchFile(path, () => file.reload(), 10);
  });
  afterAll(() => {
    stopWatching();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (ops: unknown, headers: Record<string, string> = { 'X-Dbdialog': '1' }) =>
    fetch(`${base}/api/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ ops }),
    });

  it('serves the parsed schema', async () => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as State;
    expect(state.schema.tables.map((t) => t.name)).toContain('purchases');
    expect(state.missing).toBe(false);
  });

  it('refuses writes without the X-Dbdialog header (other web pages cannot send it)', async () => {
    const res = await post([{ op: 'table.setComment', table: 'tenants', comment: 'x' }], {});
    expect(res.status).toBe(403);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    const status = await new Promise<number>((ok) => {
      const u = new URL(base);
      request(
        {
          host: u.hostname,
          port: u.port,
          path: '/api/state',
          headers: { Host: `evil.example:${u.port}` },
        },
        (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        },
      ).end();
    });
    expect(status).toBe(403);
  });

  it('writes an edit into the file and answers with the new state', async () => {
    const res = await post([
      {
        op: 'column.update',
        table: 'purchases',
        column: 'status',
        set: { comment: 'State of the purchase' },
        expect: { comment: 'Status' },
      },
    ]);
    expect(res.status).toBe(200);
    const state = (await res.json()) as State;
    const status = state.schema.tables
      .find((t) => t.name === 'purchases')
      ?.columns.find((c) => c.name === 'status');
    expect(status?.comment).toBe('State of the purchase');
    expect(readFileSync(path, 'utf8')).toBe(
      original.replace("COMMENT 'Status'", "COMMENT 'State of the purchase'"),
    );
  });

  it('answers 409 when the diagram was looking at an older file', async () => {
    const res = await post([
      {
        op: 'column.update',
        table: 'purchases',
        column: 'status',
        set: { comment: 'x' },
        expect: { comment: 'Status' },
      },
    ]);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('pushes a new state over SSE when someone else edits the file', async () => {
    const res = await fetch(`${base}/api/events`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const states: State[] = [];
    const next = async () => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6)) as State;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    states.push(await next());
    // An agent (or a person in an editor) changes the file directly.
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace("COMMENT='Shipments'", "COMMENT='Shipments (by carrier)'"),
    );
    states.push(await next());
    await reader.cancel();
    expect(states[1]?.schema.version).toBeGreaterThan(states[0]?.schema.version ?? 0);
    expect(states[1]?.schema.tables.find((t) => t.name === 'shipments')?.comment).toBe(
      'Shipments (by carrier)',
    );
  });

  it('stores box positions next to the schema, sorted, without touching schema.sql', async () => {
    const before = readFileSync(path, 'utf8');
    const res = await fetch(`${base}/api/layout`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Dbdialog': '1' },
      body: JSON.stringify({
        tables: { sellers: { x: 10.4, y: 20 }, purchases: { x: 300, y: 40 }, gone: { x: 1, y: 1 } },
      }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(path, 'utf8')).toBe(before);
    const layout = JSON.parse(readFileSync(`${path}.layout.json`, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    expect(Object.keys(layout.tables)).toEqual(['purchases', 'sellers']);
    expect(layout.tables.sellers).toEqual({ x: 10, y: 20 });
  });

  it('moves the position when the diagram renames a table', async () => {
    const res = await post([{ op: 'table.rename', table: 'sellers', to: 'suppliers' }]);
    const state = (await res.json()) as State;
    expect(state.layout.tables.suppliers).toEqual({ x: 10, y: 20 });
    expect(state.layout.tables.sellers).toBeUndefined();
  });

  it('keeps the notation in the layout file, and ignores one it does not know', async () => {
    const put = (body: unknown) =>
      fetch(`${base}/api/layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Dbdialog': '1' },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<State>);
    expect((await put({ notation: 'idef1x' })).layout.notation).toBe('idef1x');
    expect((await put({ notation: 'uml' })).layout.notation).toBe('idef1x');
    const layout = JSON.parse(readFileSync(`${path}.layout.json`, 'utf8')) as {
      notation: string;
      tables: Record<string, unknown>;
    };
    expect(layout.notation).toBe('idef1x');
    // Box positions stay as they were.
    expect(layout.tables.suppliers).toEqual({ x: 10, y: 20 });
  });
});

describe('the page the server serves', () => {
  it('stays the one it started with when dist/ is rebuilt under it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbdialog-web-'));
    const web = join(dir, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), 'page 1');
    writeFileSync(join(web, 'assets', 'app-1.js'), 'code 1');
    const schema = join(dir, 'schema.sql');
    writeFileSync(schema, '');
    const app = createApp({
      file: new SchemaFile(schema, 'schema.sql'),
      host: '127.0.0.1',
      port: 0,
      webRoot: web,
    });
    const port = await listen(app.server, '127.0.0.1', 0);
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.text());
    try {
      // A rebuild replaces the page and its script.
      writeFileSync(join(web, 'index.html'), 'page 2');
      rmSync(join(web, 'assets', 'app-1.js'));
      expect(await get('/')).toBe('page 1');
      expect(await get('/assets/app-1.js')).toBe('code 1');
      // Other addresses get the page; nothing outside it is served.
      expect(await get('/tables/purchases')).toBe('page 1');
      expect(await get('/schema.sql')).toBe('page 1');
    } finally {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
