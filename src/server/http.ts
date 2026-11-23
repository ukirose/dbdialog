// HTTP server: the diagram app, its state, a Server-Sent Events stream, and
// the edit API. It only listens on the loopback interface by default.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, posix, relative, sep } from 'node:path';
import type { LayoutRoute, Selection } from '../core/index';
import { type Op, OpError } from '../core/index';
import { isNotation, type LayoutInput } from './layout';
import type { SchemaFile, State } from './state';

export interface ServerOptions {
  file: SchemaFile;
  host: string;
  port: number;
  /** Folder with the built app (dist/web). */
  webRoot: string | null;
  /** Dev mode: requests that are not API calls go to Vite. */
  devMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
}

export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Every file under `root`, by its URL path ("/assets/index.js"). */
export function readTree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile())
        out.set(`/${relative(root, path).split(sep).join('/')}`, readFileSync(path));
    }
  };
  walk(root);
  return out;
}

const STATUS: Record<OpError['code'], number> = {
  conflict: 409,
  'not-found': 404,
  invalid: 422,
  referenced: 422,
  exists: 422,
};

const MAX_BODY = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

export function createApp(opts: ServerOptions): { server: Server; close: () => void } {
  const { file } = opts;
  const clients = new Set<ServerResponse>();

  const unsubscribe = file.subscribe((state: State) => {
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(payload);
  });
  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
  }, 25_000);

  // Only answer requests addressed to this machine (blocks DNS rebinding),
  // and only accept writes that carry our header (blocks other web pages).
  const allowedHost = (req: IncomingMessage): boolean => {
    const host = req.headers.host ?? '';
    const port = (server.address() as { port: number } | null)?.port;
    return [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      `${opts.host}:${port}`,
    ].includes(host);
  };

  // The page is read once, at start: a running server keeps serving the page
  // it came with even when dist/ is rebuilt under it. A newer page would not
  // match this server's API and would stop with an error (a blank page).
  const files = opts.webRoot && existsSync(opts.webRoot) ? readTree(opts.webRoot) : null;

  const serveStatic = (req: IncomingMessage, res: ServerResponse): void => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const asked = posix.normalize(urlPath === '/' ? '/index.html' : urlPath);
    // Anything else is the app's own address: the page handles it.
    const path = files?.has(asked) ? asked : '/index.html';
    const body = files?.get(path);
    if (!body) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!allowedHost(req)) {
      res.writeHead(403).end('forbidden host');
      return;
    }
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    if (!url.startsWith('/api/')) {
      if (opts.devMiddleware) opts.devMiddleware(req, res, () => serveStatic(req, res));
      else serveStatic(req, res);
      return;
    }
    if (req.method !== 'GET' && req.headers['x-dbdialog'] !== '1') {
      send(res, 403, { error: { code: 'forbidden', message: 'missing X-Dbdialog header' } });
      return;
    }

    if (req.method === 'GET' && url === '/api/state') {
      send(res, 200, file.state());
      return;
    }
    if (req.method === 'GET' && url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(file.state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url === '/api/ops') {
      let body: { ops?: Op[] };
      try {
        body = JSON.parse(await readBody(req)) as { ops?: Op[] };
      } catch {
        send(res, 400, { error: { code: 'bad-request', message: 'invalid JSON' } });
        return;
      }
      if (!Array.isArray(body.ops)) {
        send(res, 400, { error: { code: 'bad-request', message: 'expected {"ops": [...]}' } });
        return;
      }
      try {
        send(res, 200, file.apply(body.ops));
      } catch (e) {
        if (e instanceof OpError) {
          send(res, STATUS[e.code], {
            error: { code: e.code, message: e.message, params: e.params },
          });
        } else {
          send(res, 500, { error: { code: 'internal', message: String(e) } });
        }
      }
      return;
    }
    if (req.method === 'PUT' && url === '/api/layout') {
      try {
        const body = JSON.parse(await readBody(req)) as {
          tables?: Record<string, LayoutInput>;
          routes?: Record<string, LayoutRoute>;
          notation?: unknown;
        };
        const routes =
          body.routes && typeof body.routes === 'object' && !Array.isArray(body.routes)
            ? body.routes
            : undefined;
        const notation = isNotation(body.notation) ? body.notation : undefined;
        send(res, 200, file.saveLayout(body.tables ?? {}, routes, notation));
      } catch {
        send(res, 400, { error: { code: 'bad-request', message: 'invalid layout' } });
      }
      return;
    }
    // What the diagram has selected (the page sends it), and, for `dbdialog
    // hook`, the selection a given agent session has not been told about yet.
    if (req.method === 'PUT' && url === '/api/selection') {
      try {
        const body = JSON.parse(await readBody(req)) as Partial<Selection> | null;
        const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
        const table = text(body?.table);
        file.select(table ? { table, column: text(body?.column), fkId: text(body?.fkId) } : null);
        send(res, 200, { ok: true });
      } catch {
        send(res, 400, { error: { code: 'bad-request', message: 'invalid selection' } });
      }
      return;
    }
    if (req.method === 'POST' && url === '/api/selection/take') {
      try {
        const body = JSON.parse(await readBody(req)) as { session?: unknown };
        const session = typeof body.session === 'string' && body.session ? body.session : '-';
        send(res, 200, file.takeSelection(session));
      } catch {
        send(res, 400, { error: { code: 'bad-request', message: 'invalid request' } });
      }
      return;
    }
    send(res, 404, { error: { code: 'not-found', message: 'unknown API' } });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: String(e) } });
    });
  });

  return {
    server,
    close: () => {
      unsubscribe();
      clearInterval(keepAlive);
      for (const res of clients) res.end();
      server.close();
    },
  };
}

/** Listens on the first free port starting at `port` (0 picks any free port). */
export function listen(server: Server, host: string, port: number, tries = 20): Promise<number> {
  return new Promise((ok, fail) => {
    const attempt = (p: number, left: number) => {
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && left > 0 && p !== 0) attempt(p + 1, left - 1);
        else fail(e);
      };
      server.once('error', onError);
      server.listen(p, host, () => {
        server.off('error', onError);
        ok((server.address() as { port: number }).port);
      });
    };
    attempt(port, tries);
  });
}
