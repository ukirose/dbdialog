// Talking to the dbdialog server: one SSE stream for the state, POST for edits.

import { useEffect, useState } from 'react';
import type { Op } from '../core/ops';
import type { ApiError, LayoutRoute, Notation, ServerState } from '../core/view';

export type Connection = 'connecting' | 'open' | 'closed';

/** The latest server state; EventSource reconnects by itself after a drop. */
export function useServerState(): {
  state: ServerState | null;
  connection: Connection;
  setState: (s: ServerState) => void;
} {
  const [state, setState] = useState<ServerState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      setState(JSON.parse((e as MessageEvent<string>).data) as ServerState);
      setConnection('open');
    });
    es.onopen = () => setConnection('open');
    es.onerror = () => setConnection('closed');
    return () => es.close();
  }, []);
  return { state, connection, setState };
}

export type OpResult = { ok: true; state: ServerState } | { ok: false; error: ApiError };

const HEADERS = { 'Content-Type': 'application/json', 'X-Dbdialog': '1' };

export async function sendOps(ops: Op[]): Promise<OpResult> {
  try {
    const res = await fetch('/api/ops', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ ops }),
    });
    const body = (await res.json()) as ServerState | { error: ApiError };
    if (res.ok) return { ok: true, state: body as ServerState };
    return { ok: false, error: (body as { error: ApiError }).error };
  } catch {
    return { ok: false, error: { code: 'network', message: 'network error' } };
  }
}

/**
 * Positions of moved boxes; `w` sets a box's width (0 fits it to its content
 * again). `routes` replaces the lines of the automatic layout. Resolves to the
 * new state, or null when the server could not be reached.
 */
export async function saveLayout(
  tables: Record<string, { x: number; y: number; w?: number }>,
  routes?: Record<string, LayoutRoute>,
): Promise<ServerState | null> {
  try {
    const res = await fetch('/api/layout', {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify(routes ? { tables, routes } : { tables }),
    });
    return res.ok ? ((await res.json()) as ServerState) : null;
  } catch {
    return null; // Positions stay in this page; they are sent again with the next move.
  }
}

/**
 * What is selected on the diagram (null: nothing), so `dbdialog hook` can tell
 * the agent the user talks to. Best effort: nothing is shown if it fails.
 */
export function saveSelection(
  sel: { table: string; column: string | null; fkId: string | null } | null,
): void {
  fetch('/api/selection', { method: 'PUT', headers: HEADERS, body: JSON.stringify(sel) }).catch(
    () => {},
  );
}

/** The notation of the diagram, kept in the layout file. Resolves to the new state, or null. */
export async function saveNotation(notation: Notation): Promise<ServerState | null> {
  try {
    const res = await fetch('/api/layout', {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({ notation }),
    });
    return res.ok ? ((await res.json()) as ServerState) : null;
  } catch {
    return null;
  }
}
