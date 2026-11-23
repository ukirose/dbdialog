// The schema file as the server sees it: its text, the parsed view, and the
// box positions. Edits are applied one at a time to the latest text on disk.
// It also keeps what the user selected on the diagram, for `dbdialog hook`.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  applyOps,
  type LayoutRoute,
  type Notation,
  type Op,
  OpError,
  parseSchema,
  type Schema,
  type Selection,
  type SelectionSpot,
  type ServerState,
  selectionSpot,
  toView,
  type ViewSchema,
} from '../core/index';
import { type LayoutInput, LayoutStore } from './layout';

export type State = ServerState;

export type Listener = (state: State) => void;

/** A selection as `dbdialog hook` gets it: where it is, in which file, and when it was made. */
export type SelectionAnswer = SelectionSpot & { file: string; at: number };

export class SchemaFile {
  private text = '';
  private version = 0;
  private schema: Schema;
  private view: ViewSchema;
  private missing = false;
  private readonly listeners = new Set<Listener>();
  readonly layout: LayoutStore;
  private selection: { sel: Selection; seq: number; at: number } | null = null;
  private selectionSeq = 0;
  /** Session id → the selection it was last told about. */
  private readonly told = new Map<string, number>();

  constructor(
    readonly path: string,
    readonly displayName: string,
    readonly ui: State['ui'] = { lang: 'en' },
  ) {
    this.layout = new LayoutStore(`${path}.layout.json`);
    this.schema = parseSchema('');
    this.view = toView(this.schema, displayName, 0);
    this.reload();
  }

  /** What the diagram has selected now; null when nothing is. */
  select(sel: Selection | null): void {
    this.selectionSeq++;
    this.selection = sel ? { sel, seq: this.selectionSeq, at: Date.now() } : null;
  }

  /**
   * The selection, once per agent session: a session that was told about it
   * gets null until something else is selected. Lines are read from the file
   * as it is now, so they are right even after edits.
   */
  takeSelection(session: string): SelectionAnswer | null {
    const s = this.selection;
    if (!s || (this.told.get(session) ?? 0) >= s.seq) return null;
    this.told.set(session, s.seq);
    const spot = selectionSpot(this.schema, s.sel);
    return spot ? { ...spot, file: this.path, at: s.at } : null;
  }

  state(): State {
    return { schema: this.view, layout: this.layout.get(), missing: this.missing, ui: this.ui };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  private read(): string | null {
    try {
      return readFileSync(this.path, 'utf8');
    } catch {
      return null;
    }
  }

  private setText(text: string): void {
    const before = this.view.tables.map((t) => t.name);
    this.text = text;
    this.version++;
    this.schema = parseSchema(text);
    this.view = toView(this.schema, this.displayName, this.version);
    const after = this.view.tables.map((t) => t.name);
    // A table renamed in the file (by an agent or an editor) keeps its box position.
    const gone = before.filter((n) => !after.includes(n));
    const added = after.filter((n) => !before.includes(n));
    if (gone.length === 1 && added.length === 1)
      this.layout.rename(gone[0] as string, added[0] as string);
  }

  /** Re-reads the file; returns true when something changed. */
  reload(): boolean {
    const text = this.read();
    if (text === null) {
      if (this.missing) return false;
      this.missing = true;
      this.emit();
      return true;
    }
    if (!this.missing && text === this.text && this.version > 0) return false;
    this.missing = false;
    this.setText(text);
    this.emit();
    return true;
  }

  /** Applies edits from the diagram to the file. Throws OpError when refused. */
  apply(ops: Op[]): State {
    const current = this.read();
    if (current === null) throw new OpError('not-found', 'the schema file is missing');
    const next = applyOps(current, ops);
    if (next !== current) writeFileSync(this.path, next);
    for (const op of ops) {
      if (op.op === 'table.rename') this.layout.rename(op.table, op.to);
    }
    if (next !== this.text || this.missing) {
      this.missing = false;
      this.setText(next);
    }
    this.emit();
    return this.state();
  }

  saveLayout(
    tables: Record<string, LayoutInput>,
    routes?: Record<string, LayoutRoute>,
    notation?: Notation,
  ): State {
    const names = this.view.tables.map((t) => t.name);
    const hasErrors = this.view.diagnostics.some(
      (d) => d.severity === 'error' && d.code === 'parse-error',
    );
    this.layout.update(tables, hasErrors ? null : names, routes, notation);
    this.emit();
    return this.state();
  }
}
