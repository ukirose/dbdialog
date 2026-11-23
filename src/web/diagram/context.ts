// What a box on the diagram can ask the page to do. One stable object, passed
// by context, so the boxes (memoized) re-render only when their own data changes.

import { createContext } from 'react';
import type { ViewKey } from '../../core/view';

/** A cell that can be edited in place. */
export type EditField = 'table-name' | 'table-comment' | 'name' | 'comment' | 'type';

export interface ColumnValues {
  name: string;
  type: string;
  comment: string;
  nullable: boolean;
}

export interface NewTableColumn extends ColumnValues {
  primaryKey: boolean;
}

export interface DiagramActions {
  /** Starts editing a cell; the view moves to 100% first when it is zoomed out. */
  edit(table: string, field: EditField, column?: string | null): void;
  /**
   * Ends editing a cell and writes `value` when it changed. `move` goes on to
   * the next (1) or previous (-1) cell, as Tab and Shift+Tab do.
   */
  finishEdit(
    table: string,
    field: EditField,
    column: string | null,
    value: string | null,
    move: 1 | -1 | 0,
  ): void;
  /** The "…" menu of a row (column) or of the box itself (column null). */
  openMenu(anchor: HTMLElement, table: string, column: string | null): void;
  /** Opens the row for typing a new column, after `after` (null: at the end). */
  openColumnDraft(table: string, after: string | null): void;
  /** Writes a new column; resolves to true when it was written. */
  addColumn(table: string, after: string | null, values: ColumnValues): Promise<boolean>;
  closeColumnDraft(): void;
  togglePick(table: string, column: string): void;
  finishPick(create: boolean): void;
  startPick(table: string, kind: 'unique' | 'index'): void;
  hoverKey(table: string, key: ViewKey | null): void;
  deleteKey(table: string, key: ViewKey): void;
  /** A width set by dragging the right edge of a box; null fits it to its content again. */
  setWidth(table: string, width: number | null): void;
  createTable(name: string, comment: string, columns: NewTableColumn[]): Promise<boolean>;
  cancelNewTable(): void;
  zoom(): number;
}

export const DiagramContext = createContext<DiagramActions | null>(null);
