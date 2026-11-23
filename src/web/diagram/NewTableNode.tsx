import { KeyIcon, PlusIcon, TableIcon, XIcon } from '@primer/octicons-react';
import type { Node, NodeProps } from '@xyflow/react';
import { type KeyboardEvent, memo, useContext, useRef, useState } from 'react';
import { t } from '../i18n';
import { type DiagramActions, DiagramContext, type NewTableColumn } from './context';
import { textWidth } from './TableNode';

export interface NewTableNodeData extends Record<string, unknown> {
  lang: string;
}

export type NewTableNodeType = Node<NewTableNodeData, 'newTable'>;

const blank = (): NewTableColumn => ({
  name: '',
  type: 'VARCHAR(255)',
  comment: '',
  nullable: false,
  primaryKey: false,
});

/**
 * A table being written on the diagram: name, comment and any number of
 * columns. Nothing touches the file until "Create" writes one CREATE TABLE.
 */
export const NewTableNode = memo(function NewTableNode(_: NodeProps<NewTableNodeType>) {
  const act = useContext(DiagramContext) as DiagramActions;
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [rows, setRows] = useState<NewTableColumn[]>([
    { name: 'id', type: 'BIGINT UNSIGNED', comment: '', nullable: false, primaryKey: true },
    blank(),
  ]);
  const box = useRef<HTMLDivElement>(null);
  const filled = rows.filter((r) => r.name.trim() !== '');
  const ready = name.trim() !== '' && filled.length > 0;

  const create = async () => {
    if (ready) await act.createTable(name.trim(), comment, filled);
  };
  const set = (i: number, patch: Partial<NewTableColumn>) =>
    setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const focusRow = (i: number) =>
    requestAnimationFrame(() =>
      box.current?.querySelector<HTMLInputElement>(`[data-row="${i}"] input`)?.focus(),
    );
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, row: number | null) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) create();
    else if (row === null) focusRow(0);
    else if (row === rows.length - 1) {
      if (rows[row]?.name.trim()) {
        setRows([...rows, blank()]);
        focusRow(row + 1);
      }
    } else focusRow(row + 1);
  };
  const input = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    opts: {
      mono?: boolean;
      placeholder?: string;
      row: number | null;
      list?: string;
      focus?: boolean;
    },
  ) => (
    <input
      className={`cell-input nodrag nopan${opts.mono ? ' is-mono' : ''}`}
      // biome-ignore lint/a11y/noAutofocus: the box appears because the user asked to add a table
      autoFocus={opts.focus}
      aria-label={label}
      placeholder={opts.placeholder}
      list={opts.list}
      value={value}
      style={{ width: `${Math.max(textWidth(value || opts.placeholder || ''), 6) + 3}ch` }}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => onKeyDown(e, opts.row)}
    />
  );

  return (
    <div ref={box} className="tnode is-new is-selected">
      <div className="thead">
        <div className="thead-title">
          <TableIcon size={14} className="thead-icon" />
          {input(name, setName, t('newTable.name'), {
            mono: true,
            placeholder: t('newTable.namePlaceholder'),
            row: null,
            focus: true,
          })}
        </div>
        <div className="thead-comment is-editing">
          {input(comment, setComment, t('newTable.comment'), {
            placeholder: t('draft.comment'),
            row: null,
          })}
        </div>
      </div>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row being typed has no identity but its position
        <div className="trow is-draft" key={i} data-row={i}>
          <span className="cell cell-name">
            {input(r.name, (v) => set(i, { name: v }), t('column.name'), {
              mono: true,
              placeholder: t('draft.name'),
              row: i,
            })}
          </span>
          <span className="cell cell-marks">
            <button
              type="button"
              className={`mark mark-toggle nodrag${r.primaryKey ? ' is-on mark-pk' : ''}`}
              aria-pressed={r.primaryKey}
              onClick={() => set(i, { primaryKey: !r.primaryKey })}
            >
              <KeyIcon size={12} />
              PK
            </button>
          </span>
          <span className="cell cell-comment">
            {input(r.comment, (v) => set(i, { comment: v }), t('column.comment'), {
              placeholder: t('draft.comment'),
              row: i,
            })}
          </span>
          <span className="cell cell-type">
            {input(r.type, (v) => set(i, { type: v }), t('column.type'), {
              mono: true,
              row: i,
              list: 'dbdialog-types',
            })}
          </span>
          <span className="cell cell-null">
            {!r.primaryKey && (
              <button
                type="button"
                className={`mark mark-toggle nodrag${r.nullable ? ' is-on' : ''}`}
                aria-pressed={r.nullable}
                onClick={() => set(i, { nullable: !r.nullable })}
              >
                {r.nullable ? 'NULL' : 'NOT NULL'}
              </button>
            )}
          </span>
          <span className="cell cell-menu">
            <button
              type="button"
              className="icon-button nodrag"
              aria-label={t('newTable.removeColumn')}
              onClick={() => setRows(rows.length > 1 ? rows.filter((_, k) => k !== i) : [blank()])}
            >
              <XIcon size={14} />
            </button>
          </span>
        </div>
      ))}
      <div className="tadd">
        <button
          type="button"
          className="text-button nodrag"
          onClick={() => {
            setRows([...rows, blank()]);
            focusRow(rows.length);
          }}
        >
          <PlusIcon size={12} />
          {t('table.addColumn')}
        </button>
      </div>
      <div className="tnew-actions">
        <span className="hint">{t('newTable.hint')}</span>
        <button type="button" className="text-button nodrag" onClick={act.cancelNewTable}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="text-button nodrag is-primary"
          disabled={!ready}
          onClick={create}
        >
          {t('newTable.create')}
        </button>
      </div>
    </div>
  );
});
