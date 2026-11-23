// `dbdialog snapshot`: the agent view as a PNG, for agents that read pictures
// but drive no browser. The page is opened in headless Chrome over the
// DevTools protocol on a pipe, and Chrome's requests are answered from the
// pipe too (the page, and the state of the file), so no port is opened at
// all. Once the page says it is drawn, it is saved at the size it asks for,
// with the words it carries (what the picture holds and how to read it).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/** The page's own address; requests to it never leave Chrome (.invalid is reserved, RFC 2606). */
export const ORIGIN = 'http://dbdialog.invalid';

/** A response to a request of the page, by path; null for "not found". */
export type Serve = (path: string) => { type: string; body: Buffer } | null;

export interface SnapshotOptions {
  /** The query of the agent view: "view=agent&lang=ja…". */
  query: string;
  serve: Serve;
  /** Where the PNG goes. */
  out: string;
  /** The window, in CSS pixels. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel. */
  scale: number;
  chrome: string;
  /** How long the page may take to draw, in milliseconds. */
  timeout?: number;
}

export interface SnapshotResult {
  /** The PNG's size in pixels. */
  width: number;
  height: number;
  /** What the page says as text. */
  text: string;
}

/** Chrome, Chromium or Edge: CHROME_PATH, or where they are usually installed. */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  const installed =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : platform === 'win32'
        ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].flatMap((root) =>
            root
              ? [
                  join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                  join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                ]
              : [],
          )
        : [];
  for (const path of installed) if (existsSync(path)) return path;
  const names =
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const path = join(dir, name);
      if (dir && existsSync(path)) return path;
    }
  }
  return null;
}

/** The DevTools protocol over Chrome's pipe: JSON messages, each ended by a NUL. */
class DevTools {
  private next = 0;
  private buffer = '';
  private readonly waiting = new Map<
    number,
    { ok: (v: unknown) => void; fail: (e: Error) => void }
  >();
  private readonly events = new Map<string, (params: Record<string, unknown>) => void>();
  private closed: Error | null = null;

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf('\0'); end >= 0; end = this.buffer.indexOf('\0')) {
        const msg = JSON.parse(this.buffer.slice(0, end)) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
          method?: string;
          params?: Record<string, unknown>;
        };
        this.buffer = this.buffer.slice(end + 1);
        if (msg.method) this.events.get(msg.method)?.(msg.params ?? {});
        const w = msg.id === undefined ? undefined : this.waiting.get(msg.id);
        if (!w || msg.id === undefined) continue;
        this.waiting.delete(msg.id);
        if (msg.error) w.fail(new Error(msg.error.message));
        else w.ok(msg.result);
      }
    });
  }

  on(method: string, handle: (params: Record<string, unknown>) => void): void {
    this.events.set(method, handle);
  }

  /** Every call still waiting fails, and so does every later one. */
  close(e: Error): void {
    this.closed = e;
    for (const w of this.waiting.values()) w.fail(e);
    this.waiting.clear();
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.next;
    this.input.write(
      `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
    );
    return new Promise((ok, fail) =>
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail }),
    );
  }
}

/** Read on the page: null until it is drawn, then the picture's size and the page's words. */
const READ = `(() => {
  const v = document.querySelector('.agent-view');
  if (!v || v.dataset.ready !== 'true') return null;
  return JSON.stringify({
    width: Number(v.dataset.width),
    height: Number(v.dataset.height),
    text: document.querySelector('.agent-text')?.textContent ?? '',
  });
})()`;

export async function snapshot(o: SnapshotOptions): Promise<SnapshotResult> {
  // A profile of its own, thrown away after: nothing of the user's Chrome is touched.
  const profile = mkdtempSync(join(tmpdir(), 'dbdialog-chrome-'));
  const child = spawn(
    o.chrome,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
      '--hide-scrollbars',
      '--mute-audio',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const tools = new DevTools(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.once('error', (e) => tools.close(e));
  child.once('exit', () => tools.close(new Error('Chrome stopped before the picture was taken')));
  try {
    const { targetId } = await tools.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await tools.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = <T>(method: string, params: object = {}) =>
      tools.send<T>(method, params, sessionId);
    await page('Emulation.setDeviceMetricsOverride', {
      width: o.width,
      height: o.height,
      deviceScaleFactor: o.scale,
      mobile: false,
    });
    await page('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    // Every request of the page is answered here, before it reaches the network.
    tools.on('Fetch.requestPaused', (p) => {
      const request = p.request as { url: string };
      const found = o.serve(new URL(request.url).pathname);
      page('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: found ? 200 : 404,
        responseHeaders: [
          { name: 'Content-Type', value: found?.type ?? 'text/plain' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: (found?.body ?? Buffer.from('not found')).toString('base64'),
      }).catch(() => {});
    });
    await page('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] });
    const nav = await page<{ errorText?: string }>('Page.navigate', {
      url: `${ORIGIN}/?${o.query}`,
    });
    if (nav.errorText) throw new Error(`could not open the page: ${nav.errorText}`);
    const deadline = Date.now() + (o.timeout ?? 30_000);
    type Drawn = { width: number; height: number; text: string };
    let drawn: Drawn | null = null;
    while (!drawn) {
      const { result } = await page<{ result: { value?: string | null } }>('Runtime.evaluate', {
        expression: READ,
        returnByValue: true,
      });
      if (result.value) drawn = JSON.parse(result.value) as Drawn;
      else if (Date.now() > deadline) throw new Error('the page did not finish drawing in time');
      else await new Promise((r) => setTimeout(r, 100));
    }
    const { data } = await page<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: drawn.width, height: drawn.height, scale: 1 },
    });
    writeFileSync(o.out, Buffer.from(data, 'base64'));
    return {
      width: Math.round(drawn.width * o.scale),
      height: Math.round(drawn.height * o.scale),
      text: drawn.text,
    };
  } finally {
    await tools.send('Browser.close').catch(() => {});
    // unref: a timer left after Chrome is gone must not keep this process up.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    if (child.exitCode === null) child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
}
