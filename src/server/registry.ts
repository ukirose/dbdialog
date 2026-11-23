// Running servers announce themselves, one small file per port, so that
// `dbdialog hook` can find the ones showing a schema of the agent's project:
// ~/.dbdialog/servers/<port>.json (DBDIALOG_HOME moves the folder, for tests).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Announced {
  pid: number;
  host: string;
  port: number;
  /** The schema file, as an absolute path. */
  file: string;
}

const folder = () => join(process.env.DBDIALOG_HOME ?? join(homedir(), '.dbdialog'), 'servers');

/** Announces a running server; the function returned takes the announcement back. */
export function announce(host: string, port: number, file: string): () => void {
  const path = join(folder(), `${port}.json`);
  try {
    mkdirSync(folder(), { recursive: true });
    const entry: Announced = { pid: process.pid, host, port, file };
    writeFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    return () => {}; // The diagram works all the same; only the hook cannot find it.
  }
  return () => rmSync(path, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The servers running now. The files of servers that are gone are removed. */
export function announced(): Announced[] {
  let names: string[];
  try {
    names = readdirSync(folder());
  } catch {
    return [];
  }
  const out: Announced[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(folder(), name);
    try {
      const a = JSON.parse(readFileSync(path, 'utf8')) as Announced;
      if (alive(a.pid)) out.push(a);
      else rmSync(path, { force: true });
    } catch {
      // Being written, or not one of ours.
    }
  }
  return out;
}
