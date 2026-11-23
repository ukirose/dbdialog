#!/usr/bin/env node
// dbdialog <schema.sql>: serves a live ER diagram of the file and writes the
// diagram's edits back into it. `dbdialog lint` and `dbdialog mermaid` are
// the same model for agents and CI; `dbdialog snapshot` saves the agent view
// (the graph of the tables) as a picture; `dbdialog hook` tells an agent what
// is selected on the diagram.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import { lintCommand, mermaidCommand } from './commands';
import { selectionContext } from './hook';
import { createApp, listen, readTree, TYPES } from './http';
import { announce } from './registry';
import { findChrome, snapshot } from './snapshot';
import { SchemaFile } from './state';
import { watchFile } from './watch';

const HELP = `Usage:
  dbdialog <schema.sql> [options]      Open the live diagram of the file
  dbdialog lint <schema.sql> [--json]  Check the file; exits with 1 on errors or warnings
  dbdialog mermaid <schema.sql>        Print a Mermaid erDiagram of the file
  dbdialog snapshot <schema.sql>       Save the agent view as a PNG: the graph of the
                                       tables, their primary keys and where the pattern
                                       breaks (types, NULL and constraints are left to the
                                       SQL), and print what it shows and how to read it
  dbdialog hook                        For Claude Code's UserPromptSubmit hook: prints
                                       what is selected on the diagram, once per selection

Edits made in the diagram are written back to the file, changing only what was
edited; edits made to the file (by you or an agent) show up in the diagram at once.

Options:
  -p, --port <n>   Port to listen on (default 4321; the next free one is used)
      --host <h>   Address to listen on (default 127.0.0.1)
      --open       Open the diagram in the default browser
      --lang <l>   Language of the page: en (default), ja, or auto (the browser's)
      --json       With lint: print the result as JSON
  -o, --out <f>    With snapshot: the PNG to write (default: a file in the temp folder)
      --focus <t>  With snapshot: only table t and the tables next to it
      --width <n>  With snapshot: the window in CSS pixels (default 1600 × 1000;
      --height <n>   the picture is cut to what it holds), at --scale device pixels
      --scale <n>    per CSS pixel (default 1.25: at most 2000 × 1250 pixels)
  -h, --help       Show this help
  -v, --version    Show the version
`;

const VERSION = pkg.version;

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: '4321' },
      host: { type: 'string', default: '127.0.0.1' },
      open: { type: 'boolean', default: false },
      lang: { type: 'string', default: 'en' },
      json: { type: 'boolean', default: false },
      out: { type: 'string', short: 'o' },
      focus: { type: 'string' },
      width: { type: 'string', default: '1600' },
      height: { type: 'string', default: '1000' },
      scale: { type: 'string', default: '1.25' },
      dev: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const [command, target] = positionals;
  if (command === 'hook') {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse((await readStdin()) || '{}') as Record<string, unknown>;
    } catch {
      // No usable input: the folder this runs in stands for the session's.
    }
    const text = await selectionContext(input);
    // Exit at once: the prompt waits for this command.
    process.stdout.write(text, () => process.exit(0));
    return;
  }
  if (command === 'lint' || command === 'mermaid') {
    if (!target) throw new Error(`usage: dbdialog ${command} <schema.sql>`);
    const path = resolve(target);
    if (!existsSync(path)) throw new Error(`${target} does not exist`);
    const src = readFileSync(path, 'utf8');
    const result = command === 'lint' ? lintCommand(target, src, values.json) : mermaidCommand(src);
    process.stdout.write(result.output);
    process.exit(result.exitCode);
  }

  // Check every option before touching the file system.
  const lang = values.lang;
  if (lang !== 'en' && lang !== 'ja' && lang !== 'auto') {
    throw new Error(`--lang must be en, ja or auto (got "${lang}")`);
  }
  if (command === 'snapshot') {
    if (!target) throw new Error('usage: dbdialog snapshot <schema.sql> [-o out.png]');
    await snapshotCommand(target, { ...values, lang });
    return;
  }
  const path = resolve(positionals[0] as string);
  if (!existsSync(path)) {
    writeFileSync(path, '');
    process.stdout.write(`dbdialog: created an empty ${relative(process.cwd(), path) || path}\n`);
  }
  // Show the path as typed when the file is under the current folder, otherwise in full.
  const rel = relative(process.cwd(), path);
  const file = new SchemaFile(path, rel && !rel.startsWith('..') ? rel : path, { lang });

  let devMiddleware:
    | ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)
    | undefined;
  const app = createApp({
    file,
    host: values.host,
    port: Number(values.port),
    webRoot: values.dev ? null : fileURLToPath(new URL('./web/', import.meta.url)),
    devMiddleware: (req, res, next) => (devMiddleware ? devMiddleware(req, res, next) : next()),
  });

  if (values.dev) {
    // Development only: Vite serves the app from src/web with hot reload.
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
      server: { middlewareMode: true, hmr: { server: app.server } },
      appType: 'spa',
    });
    devMiddleware = vite.middlewares;
  }

  const port = await listen(app.server, values.host, Number(values.port));
  const host = values.host.includes(':') ? `[${values.host}]` : values.host;
  const url = `http://${host}:${port}/`;
  const stopWatching = watchFile(path, () => file.reload());
  // So that `dbdialog hook` can find this server.
  const unannounce = announce(values.host, port, path);
  process.on('exit', unannounce);

  process.stdout.write(`dbdialog: watching ${file.displayName}\n        ${url}\n`);
  if (values.open) openBrowser(url);

  const stop = () => {
    stopWatching();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * The agent view of the file, as a PNG. The page and the state of the file
 * are handed to Chrome from here: no server, no port, nothing announced, and
 * nothing written next to the schema.
 */
async function snapshotCommand(
  target: string,
  o: {
    lang: 'en' | 'ja' | 'auto';
    out?: string;
    focus?: string;
    width: string;
    height: string;
    scale: string;
  },
): Promise<void> {
  const path = resolve(target);
  if (!existsSync(path)) throw new Error(`${target} does not exist`);
  const [width, height, scale] = [Number(o.width), Number(o.height), Number(o.scale)];
  if (![width, height, scale].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error('--width, --height and --scale must be positive numbers');
  }
  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      'Chrome was not found. Set CHROME_PATH to a Chrome, Chromium or Edge executable.',
    );
  }
  const name = basename(path, extname(path));
  const out = resolve(
    o.out ?? join(tmpdir(), 'dbdialog', `${name}${o.focus ? `-${o.focus}` : ''}.png`),
  );
  mkdirSync(dirname(out), { recursive: true });
  const rel = relative(process.cwd(), path);
  const file = new SchemaFile(path, rel && !rel.startsWith('..') ? rel : path, { lang: o.lang });
  const pages = readTree(fileURLToPath(new URL('./web/', import.meta.url)));
  const state = Buffer.from(JSON.stringify(file.state()));
  const query = new URLSearchParams({ view: 'agent' });
  if (o.lang !== 'auto') query.set('lang', o.lang);
  if (o.focus) query.set('focus', o.focus);
  const shot = await snapshot({
    query: query.toString(),
    serve: (p) => {
      if (p === '/api/state') return { type: TYPES['.json'] as string, body: state };
      const asked = p === '/' ? '/index.html' : p;
      const body = pages.get(asked);
      return body ? { type: TYPES[extname(asked)] ?? 'application/octet-stream', body } : null;
    },
    out,
    width,
    height,
    scale,
    chrome,
  });
  process.stdout.write(`dbdialog: wrote ${out} (${shot.width} × ${shot.height})\n${shot.text}\n`);
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((done) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += chunk;
    });
    process.stdin.on('end', () => done(text));
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`dbdialog: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
