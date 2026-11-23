import {
  AlertIcon,
  KebabHorizontalIcon,
  PlusIcon,
  TableIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react';
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Notation, ViewColumn, ViewTable } from '../../core/view';
import { t } from '../i18n';
import { type ColumnValues, type DiagramActions, DiagramContext, type EditField } from './context';
import { boxRows, listedKeys } from './geometry';
import { allowsNull, ColumnMarks, KeyMark, NullMark, OptionalNote } from './marks';
import { alternateKeys, columnAlternateKeys, isDependent } from './notation';

export interface TableNodeData extends Record<string, unknown> {
  table: ViewTable;
  notation: Notation;
  /** Lower-cased column name → colors of the foreign keys the column belongs to. */
  fkColors: Record<string, number[]>;
  /** Lower-cased column name → background of a row being pointed at. */
  highlight: Record<string, string>;
  /** Unrelated to the table or line under the pointer. */
  dim: boolean;
  problems: number;
  showComments: boolean;
  /** Tooltips are translated: a new language must re-render the box. */
  lang: string;
  /** A width the user set by dragging; null fits the box to its content. */
  width: number | null;
  /** The cell being edited in this box. */
  editing: { field: EditField; column: string | null } | null;
  /** A new column being typed in this box: after which column (null: at the end). */
  draft: { after: string | null } | null;
  /** While a key is being made: its kind and the columns picked, in order. */
  picking: { kind: 'unique' | 'index'; columns: string[] } | null;
  /** The column whose details the sidebar shows. */
  chosen: string | null;
}

export type TableNodeType = Node<TableNodeData, 'table'>;

/** Text width in half-width units (CJK counts twice), for sizing inputs. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return w;
}

/** An input in place of a cell. Enter or leaving it writes, Esc cancels, Tab moves on. */
export function CellInput(props: {
  value: string;
  onDone: (value: string | null, move: 1 | -1 | 0) => void;
  mono?: boolean;
  placeholder?: string;
  label: string;
  list?: string;
}) {
  const [v, setV] = useState(props.value);
  const done = useRef(false);
  const finish = (value: string | null, move: 1 | -1 | 0) => {
    if (done.current) return;
    done.current = true;
    props.onDone(value, move);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // keys belong to the input, not to the diagram
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(v, 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(null, 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      finish(v, e.shiftKey ? -1 : 1);
    }
  };
  return (
    <input
      className={`cell-input nodrag nopan${props.mono ? ' is-mono' : ''}`}
      // biome-ignore lint/a11y/noAutofocus: the input appears because the user asked to edit this cell
      autoFocus
      aria-label={props.label}
      placeholder={props.placeholder}
      list={props.list}
      value={v}
      style={{ width: `${Math.max(textWidth(v || props.placeholder || ''), 6) + 3}ch` }}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={onKeyDown}
      onBlur={() => finish(v, 0)}
    />
  );
}

/** The row where a new column is typed. Enter writes it and clears the row for the next one. */
function ColumnDraftRow(props: {
  table: string;
  after: string | null;
  showComments: boolean;
  /** First under the primary key: the line runs above it. */
  afterKey: boolean;
  act: DiagramActions;
}) {
  const blank: ColumnValues = { name: '', type: 'VARCHAR(255)', comment: '', nullable: false };
  const [v, setV] = useState<ColumnValues>(blank);
  const nameRef = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (!v.name.trim() || !v.type.trim()) return;
    if (await props.act.addColumn(props.table, props.after, v)) {
      setV({ ...blank, type: v.type, nullable: v.nullable });
      nameRef.current?.focus();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.act.closeColumnDraft();
    }
  };
  const input = (field: 'name' | 'type' | 'comment', label: string, placeholder?: string) => (
    <input
      ref={field === 'name' ? nameRef : undefined}
      className={`cell-input nodrag nopan${field === 'comment' ? '' : ' is-mono'}`}
      // biome-ignore lint/a11y/noAutofocus: the row appears because the user asked to add a column
      autoFocus={field === 'name'}
      aria-label={label}
      placeholder={placeholder}
      list={field === 'type' ? 'dbdialog-types' : undefined}
      value={v[field]}
      style={{ width: `${Math.max(textWidth(v[field] || placeholder || ''), 6) + 3}ch` }}
      onChange={(e) => setV({ ...v, [field]: e.target.value })}
      onKeyDown={onKeyDown}
    />
  );
  return (
    <div className={`trow is-draft${props.afterKey ? ' is-after-key' : ''}`}>
      <span className="cell cell-name">{input('name', t('column.name'), t('draft.name'))}</span>
      <span className="cell cell-marks" />
      <span className="cell cell-comment">
        {props.showComments && input('comment', t('column.comment'), t('draft.comment'))}
      </span>
      <span className="cell cell-type">{input('type', t('column.type'))}</span>
      <span className="cell cell-null">
        <button
          type="button"
          className={`mark mark-toggle nodrag${v.nullable ? ' is-on' : ''}`}
          aria-pressed={v.nullable}
          onClick={() => setV({ ...v, nullable: !v.nullable })}
        >
          {v.nullable ? 'NULL' : 'NOT NULL'}
        </button>
      </span>
      <span className="cell cell-menu">
        <button
          type="button"
          className="icon-button nodrag"
          aria-label={t('common.cancel')}
          onClick={props.act.closeColumnDraft}
        >
          <XIcon size={14} />
        </button>
      </span>
    </div>
  );
}

function Row(props: {
  tbl: ViewTable;
  c: ViewColumn;
  data: TableNodeData;
  act: DiagramActions;
  /** First under the primary key: the line runs above it. */
  afterKey: boolean;
  /** The alternate keys (IDEF1X) the column belongs to. */
  aks: number[];
}) {
  const { tbl, c, data, act } = props;
  const key = c.name.toLowerCase();
  const hl = data.highlight[key];
  const editing = data.editing?.column === c.name ? data.editing.field : null;
  const picked = data.picking ? data.picking.columns.indexOf(c.name) : -1;
  const checks = tbl.checks.filter((x) => x.columns.includes(c.name));
  const classes = ['trow'];
  if (props.afterKey) classes.push('is-after-key');
  if (hl) classes.push('is-hl');
  if (data.chosen === c.name) classes.push('is-chosen');
  if (data.picking) classes.push('is-picking');
  if (picked >= 0) classes.push('is-picked');
  const cell = (field: EditField, text: string | null, mono: boolean) =>
    editing === field ? (
      <CellInput
        value={text ?? ''}
        mono={mono}
        label={t(`column.${field === 'name' ? 'name' : field}`)}
        list={field === 'type' ? 'dbdialog-types' : undefined}
        onDone={(value, move) => act.finishEdit(tbl.name, field, c.name, value, move)}
      />
    ) : (
      text
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut; the "…" button of the row opens the same menu
    <div
      className={classes.join(' ')}
      data-column={c.name}
      style={hl ? { background: hl } : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        act.openMenu(e.currentTarget, tbl.name, c.name);
      }}
    >
      {/* While a line is being drawn, the whole row takes it. */}
      <Handle
        type="target"
        position={Position.Left}
        id={`t:${c.name}`}
        className="trow-drop"
        isConnectableStart={false}
      />
      <Handle type="source" position={Position.Left} id={`l:${c.name}`} className="thandle" />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut; the "…" menu and Tab reach the same edit */}
      <span
        className={`cell cell-name${c.primaryKey ? ' is-pk' : ''}`}
        onDoubleClick={() => act.edit(tbl.name, 'name', c.name)}
      >
        {picked >= 0 && <span className="pick-no">{picked + 1}</span>}
        {cell('name', c.name, false)}
      </span>
      <span className="cell cell-marks">
        <ColumnMarks
          c={c}
          colors={data.fkColors[key] ?? []}
          checks={checks}
          notation={data.notation}
          aks={props.aks}
        />
      </span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut; the "…" menu and Tab reach the same edit */}
      <span
        className="cell cell-comment"
        data-tip-overflow={editing === 'comment' ? undefined : (c.comment ?? undefined)}
        onDoubleClick={() => act.edit(tbl.name, 'comment', c.name)}
      >
        {editing === 'comment' ? cell('comment', c.comment, false) : data.showComments && c.comment}
      </span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut; the "…" menu and Tab reach the same edit */}
      <span className="cell cell-type" onDoubleClick={() => act.edit(tbl.name, 'type', c.name)}>
        {cell('type', c.type, true)}
      </span>
      <span className="cell cell-null">
        {allowsNull(c) && (data.notation === 'idef1x' ? <OptionalNote /> : <NullMark />)}
      </span>
      <span className="cell cell-menu">
        <button
          type="button"
          className="icon-button row-menu nodrag"
          aria-label={t('menu.column', { column: c.name })}
          onClick={(e) => act.openMenu(e.currentTarget, tbl.name, c.name)}
        >
          <KebabHorizontalIcon size={14} />
        </button>
      </span>
      <Handle type="source" position={Position.Right} id={`r:${c.name}`} className="thandle" />
    </div>
  );
}

function KeysSection(props: {
  tbl: ViewTable;
  data: TableNodeData;
  selected: boolean;
  act: DiagramActions;
}) {
  const { tbl, data, act } = props;
  const keys = listedKeys(tbl);
  const aks = alternateKeys(tbl);
  if (keys.length === 0 && !data.picking && !props.selected) return null;
  return (
    <div className="tkeys">
      {keys.map((k) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointing at a key lights up its columns; nothing to activate
        <div
          className="tkey"
          key={`${k.id}:${k.text}`}
          onMouseEnter={() => act.hoverKey(tbl.name, k)}
          onMouseLeave={() => act.hoverKey(tbl.name, null)}
        >
          <KeyMark kind={k.kind} notation={data.notation} ak={aks.get(k.id)} />
          <span className="tkey-cols">{k.columns.join(', ')}</span>
          {k.name && <span className="tkey-name">{k.name}</span>}
          {k.kind !== 'primary' && (
            <button
              type="button"
              className="icon-button tkey-delete nodrag"
              aria-label={t('key.deleteNamed', { columns: k.columns.join(', ') })}
              onClick={() => act.deleteKey(tbl.name, k)}
            >
              <TrashIcon size={12} />
            </button>
          )}
        </div>
      ))}
      {data.picking ? (
        <div className="tkey is-picking">
          <KeyMark kind={data.picking.kind} notation={data.notation} />
          <span className="tkey-cols">
            {data.picking.columns.length ? data.picking.columns.join(', ') : t('pick.hint')}
          </span>
          <button
            type="button"
            className="text-button nodrag is-primary"
            disabled={data.picking.columns.length === 0}
            onClick={() => act.finishPick(true)}
          >
            {t('pick.create')}
          </button>
          <button
            type="button"
            className="text-button nodrag"
            onClick={() => act.finishPick(false)}
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        props.selected && (
          <div className="tkey-add">
            <button
              type="button"
              className="text-button nodrag"
              onClick={() => act.startPick(tbl.name, 'unique')}
            >
              <PlusIcon size={12} />
              UNIQUE
            </button>
            <button
              type="button"
              className="text-button nodrag"
              onClick={() => act.startPick(tbl.name, 'index')}
            >
              <PlusIcon size={12} />
              {t('key.index')}
            </button>
          </div>
        )
      )}
    </div>
  );
}

/**
 * Where the row for a new column shows. The column is written after `after`
 * in the table (null: at the end); on the box it is one of the columns under
 * the line, after the last of them that comes before it in the table.
 * Null: first under the line.
 */
function draftAnchor(tbl: ViewTable, rest: ViewColumn[], after: string | null): string | null {
  const end =
    after === null ? tbl.columns.length - 1 : tbl.columns.findIndex((c) => c.name === after);
  let anchor: string | null = null;
  for (const c of rest) if (tbl.columns.indexOf(c) <= end) anchor = c.name;
  return anchor;
}

/**
 * A table: one row per column, its cells lined up in columns across the rows,
 * never wrapped (the box grows instead). The primary key columns come first,
 * above a line, as IE and IDEF1X draw an entity. A connection point sits on
 * each side of every row, so lines start at the key itself.
 */
export const TableNode = memo(function TableNode({ data, selected }: NodeProps<TableNodeType>) {
  const act = useContext(DiagramContext) as DiagramActions;
  const tbl = data.table;
  const box = useRef<HTMLDivElement>(null);
  const classes = ['tnode'];
  // Rounded corners: a dependent entity (the child of an identifying relationship).
  if (isDependent(tbl)) classes.push('is-dependent');
  if (selected) classes.push('is-selected');
  if (data.dim) classes.push('is-dim');
  if (tbl.hasErrors) classes.push('has-errors');
  if (data.width) classes.push('has-width');
  if (data.picking) classes.push('is-picking');
  const editing = data.editing?.column === null ? data.editing.field : null;

  // While picking the columns of a new key: Enter makes it, Esc gives up.
  useEffect(() => {
    if (!data.picking) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Enter') act.finishPick(true);
      else if (e.key === 'Escape') act.finishPick(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data.picking, act]);

  const onResize = (e: PointerEvent<HTMLDivElement>) => {
    const el = box.current;
    if (!el) return;
    e.stopPropagation();
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const zoom = act.zoom();
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width / zoom;
    let w = startW;
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.max(160, startW + (ev.clientX - startX) / zoom);
      el.style.width = `${w}px`;
      el.classList.add('has-width');
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      if (Math.abs(w - startW) >= 1) act.setWidth(tbl.name, Math.round(w));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  const { key, rest } = boxRows(tbl);
  const aks = data.notation === 'idef1x' ? columnAlternateKeys(tbl) : null;
  const row = (c: ViewColumn, afterKey: boolean) => (
    <Row
      key={c.name}
      tbl={tbl}
      c={c}
      data={data}
      act={act}
      afterKey={afterKey}
      aks={aks?.get(c.name.toLowerCase()) ?? []}
    />
  );
  // Above the line: the primary key, or a note that there is none.
  const rows: React.ReactNode[] =
    key.length === 0
      ? [
          <div key="(no primary key)" className="trow trow-nokey" data-tip={t('box.noKeyTip')}>
            <span className="cell cell-nokey">{t('box.noKey')}</span>
          </div>,
        ]
      : key.map((c) => row(c, false));
  // Under the line: the other columns, and the row for a new one where it will show.
  const below: React.ReactNode[] = [];
  const draft = data.draft;
  const anchor = draft ? draftAnchor(tbl, rest, draft.after) : undefined;
  const draftRow = (afterKey: boolean) =>
    draft && (
      <ColumnDraftRow
        key="(new column)"
        table={tbl.name}
        after={draft.after}
        showComments={data.showComments}
        afterKey={afterKey}
        act={act}
      />
    );
  if (anchor === null) below.push(draftRow(true));
  for (const c of rest) {
    below.push(row(c, below.length === 0));
    if (anchor === c.name) below.push(draftRow(false));
  }
  // Every column is in the primary key: the line still closes the key, over an empty part.
  if (below.length === 0) below.push(<div key="(none)" className="trow-spacer is-after-key" />);
  rows.push(...below);

  return (
    <div
      ref={box}
      className={classes.join(' ')}
      style={data.width ? { width: data.width } : undefined}
    >
      <div className="thead">
        <div className="thead-title">
          <TableIcon size={14} className="thead-icon" />
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut; the "…" menu and Tab reach the same edit */}
          <span className="thead-name" onDoubleClick={() => act.edit(tbl.name, 'table-name')}>
            {editing === 'table-name' ? (
              <CellInput
                value={tbl.name}
                mono
                label={t('table.name')}
                onDone={(v, move) => act.finishEdit(tbl.name, 'table-name', null, v, move)}
              />
            ) : (
              tbl.name
            )}
          </span>
          {data.problems > 0 && (
            <span className="thead-problems" data-tip={t('toolbar.problems', { n: data.problems })}>
              <AlertIcon size={12} />
              {data.problems}
            </span>
          )}
          <button
            type="button"
            className="icon-button thead-menu nodrag"
            aria-label={t('menu.table', { table: tbl.name })}
            onClick={(e) => act.openMenu(e.currentTarget, tbl.name, null)}
          >
            <KebabHorizontalIcon size={14} />
          </button>
        </div>
        {editing === 'table-comment' ? (
          <div className="thead-comment is-editing">
            <CellInput
              value={tbl.comment ?? ''}
              label={t('table.comment')}
              placeholder={t('draft.comment')}
              onDone={(v, move) => act.finishEdit(tbl.name, 'table-comment', null, v, move)}
            />
          </div>
        ) : (
          tbl.comment && (
            // biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut; the "…" menu and Tab reach the same edit
            <div
              className="thead-comment"
              onDoubleClick={() => act.edit(tbl.name, 'table-comment')}
            >
              {tbl.comment}
            </div>
          )
        )}
      </div>
      {rows}
      {selected && !data.draft && (
        <div className="tadd">
          <button
            type="button"
            className="text-button nodrag"
            onClick={() => act.openColumnDraft(tbl.name, null)}
          >
            <PlusIcon size={12} />
            {t('table.addColumn')}
          </button>
        </div>
      )}
      <KeysSection tbl={tbl} data={data} selected={selected} act={act} />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle for the mouse; the width can also be reset from the box menu */}
      <div
        className="tresize nodrag nopan"
        data-tip={t('box.resize')}
        onPointerDown={onResize}
        onDoubleClick={() => act.setWidth(tbl.name, null)}
      />
    </div>
  );
});
