// Box positions live next to the schema in <schema>.layout.json, so moving a
// box never changes schema.sql. The notation of the diagram is kept there too:
// it belongs to the drawing of this schema, not to one person's browser.

import { readFileSync, writeFileSync } from 'node:fs';
import type { LayoutRoute, Notation, ServerState } from '../core/index';

export type Layout = ServerState['layout'];

/** What a client sends for one box. */
export interface LayoutInput {
  x: number;
  y: number;
  w?: number | null;
}

export class LayoutStore {
  private data: Layout = { tables: {} };

  constructor(readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Layout>;
      if (parsed && typeof parsed.tables === 'object' && parsed.tables)
        this.data = { tables: parsed.tables };
      if (parsed && typeof parsed.routes === 'object' && parsed.routes)
        this.data.routes = parsed.routes;
      if (parsed && isNotation(parsed.notation)) this.data.notation = parsed.notation;
    } catch {
      // No layout yet: the diagram places the boxes.
    }
  }

  get(): Layout {
    return {
      tables: { ...this.data.tables },
      ...(this.data.routes ? { routes: { ...this.data.routes } } : {}),
      ...(this.data.notation ? { notation: this.data.notation } : {}),
    };
  }

  /**
   * Merges positions; when `keep` is given, positions of other tables are dropped.
   * A box keeps the width it has unless `w` is sent: a number sets it, 0 or null removes it.
   */
  update(
    tables: Record<string, LayoutInput>,
    keep: string[] | null,
    routes?: Record<string, LayoutRoute>,
    notation?: Notation,
  ): void {
    const next: Layout['tables'] = { ...this.data.tables };
    for (const [name, p] of Object.entries(tables)) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
      const entry: Layout['tables'][string] = { x: Math.round(p.x), y: Math.round(p.y) };
      const w = 'w' in p ? p.w : next[name]?.w;
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) entry.w = Math.round(w);
      next[name] = entry;
    }
    if (keep) {
      for (const name of Object.keys(next)) if (!keep.includes(name)) delete next[name];
    }
    // Lines come whole from one automatic layout: a new set replaces the old one.
    const nextRoutes = routes ?? this.data.routes;
    const nextNotation = notation ?? this.data.notation;
    this.data = {
      tables: next,
      ...(nextRoutes ? { routes: nextRoutes } : {}),
      ...(nextNotation ? { notation: nextNotation } : {}),
    };
    this.write();
  }

  rename(from: string, to: string): void {
    const p = this.data.tables[from];
    if (!p || from === to) return;
    delete this.data.tables[from];
    this.data.tables[to] = p;
    this.write();
  }

  private write(): void {
    // Sorted keys keep the file's git diff small and stable.
    const sort = <T>(o: Record<string, T>) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const routes = this.data.routes;
    const body = {
      version: 1,
      ...(this.data.notation ? { notation: this.data.notation } : {}),
      tables: sort(this.data.tables),
      ...(routes && Object.keys(routes).length ? { routes: sort(routes) } : {}),
    };
    writeFileSync(this.path, `${JSON.stringify(body, null, 2)}\n`);
  }
}

export const isNotation = (v: unknown): v is Notation => v === 'ie' || v === 'idef1x';
