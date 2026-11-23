// `dbdialog hook`, for Claude Code's UserPromptSubmit hook: tells the agent
// what the user selected on the diagram, the way an editor tells it about the
// selected lines. It takes the hook's input (JSON on stdin: the session id and
// its folder), asks every running DBdialog server whose schema is inside that
// folder for a selection this session has not been told about, and returns the
// newest. Claude Code adds what the hook prints to the prompt; when there is
// nothing new, it prints nothing.

import { isAbsolute, relative } from 'node:path';
import { describeSelection } from '../core/index';
import { announced } from './registry';
import type { SelectionAnswer } from './state';

const inside = (file: string, dir: string) => {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The address to reach a server at, from the address it listens on. */
function reach(host: string): string {
  if (host === '' || host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

export async function selectionContext(input: {
  cwd?: unknown;
  session_id?: unknown;
}): Promise<string> {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : '-';
  const answers = await Promise.all(
    announced()
      .filter((s) => inside(s.file, cwd))
      .map(async (s) => {
        try {
          const res = await fetch(`http://${reach(s.host)}:${s.port}/api/selection/take`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Dbdialog': '1' },
            body: JSON.stringify({ session }),
            // The prompt waits for the hook: a server that does not answer is skipped.
            signal: AbortSignal.timeout(1500),
          });
          return res.ok ? ((await res.json()) as SelectionAnswer | null) : null;
        } catch {
          return null;
        }
      }),
  );
  const newest = answers
    .filter((a): a is SelectionAnswer => a !== null)
    .sort((a, b) => b.at - a.at)[0];
  return newest ? describeSelection(newest, relative(cwd, newest.file)) : '';
}
