import { ArrowRightIcon, PlusIcon, XIcon } from '@primer/octicons-react';
import { Button, IconButton, Select } from '@primer/react';
import type { ViewTable } from '../../core/view';
import { t } from '../i18n';

/** The column pairs of a foreign key being re-pointed: (column of this table, referenced column). */
export interface FkDraft {
  table: string;
  refTable: string;
  pairs: [string, string][];
}

export function draftIsComplete(d: FkDraft): boolean {
  return d.refTable !== '' && d.pairs.length > 0 && d.pairs.every(([a, b]) => a !== '' && b !== '');
}

/** Changes which columns a foreign key joins. Saved with one button, as one edit. */
export function PairsEditor(props: {
  value: FkDraft;
  tables: ViewTable[];
  onChange: (v: FkDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  dirty: boolean;
}) {
  const d = props.value;
  const table = props.tables.find((x) => x.name === d.table);
  const ref = props.tables.find((x) => x.name === d.refTable);
  const setPair = (i: number, k: 0 | 1, v: string) =>
    props.onChange({
      ...d,
      pairs: d.pairs.map((p, j) =>
        j === i ? ((k === 0 ? [v, p[1]] : [p[0], v]) as [string, string]) : p,
      ),
    });
  const setRefTable = (name: string) => {
    // Point at the new table's primary key when the counts match.
    const pk = props.tables.find((x) => x.name === name)?.primaryKey?.columns ?? [];
    props.onChange({
      ...d,
      refTable: name,
      pairs: d.pairs.map(
        (p, i) => [p[0], pk.length === d.pairs.length ? (pk[i] ?? '') : ''] as [string, string],
      ),
    });
  };
  return (
    <div className="fk-editor">
      <label className="field">
        <span className="field-label">{t('fk.refTable')}</span>
        <Select size="small" block value={d.refTable} onChange={(e) => setRefTable(e.target.value)}>
          <Select.Option value="" />
          {props.tables.map((x) => (
            <Select.Option key={x.name} value={x.name}>
              {x.name}
            </Select.Option>
          ))}
        </Select>
      </label>
      <div className="field">
        <span className="field-label">{t('fk.pairs')}</span>
        {d.pairs.map(([a, b], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a pair being edited has no identity but its position
          <div className="fk-pair" key={i}>
            <Select
              size="small"
              block
              value={a}
              onChange={(e) => setPair(i, 0, e.target.value)}
              aria-label={t('fk.columns')}
            >
              <Select.Option value="" />
              {table?.columns.map((c) => (
                <Select.Option key={c.name} value={c.name}>
                  {c.name}
                </Select.Option>
              ))}
            </Select>
            <ArrowRightIcon size={16} className="fk-arrow" />
            <Select
              size="small"
              block
              value={b}
              onChange={(e) => setPair(i, 1, e.target.value)}
              aria-label={t('fk.refColumns')}
            >
              <Select.Option value="" />
              {ref?.columns.map((c) => (
                <Select.Option key={c.name} value={c.name}>
                  {c.name}
                </Select.Option>
              ))}
            </Select>
            <IconButton
              icon={XIcon}
              aria-label={t('fk.removePair')}
              size="small"
              variant="invisible"
              onClick={() => props.onChange({ ...d, pairs: d.pairs.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        <Button
          size="small"
          variant="invisible"
          leadingVisual={PlusIcon}
          className="add-link"
          onClick={() => props.onChange({ ...d, pairs: [...d.pairs, ['', '']] })}
        >
          {t('fk.addPair')}
        </Button>
      </div>
      <div className="actions">
        <Button
          size="small"
          variant="primary"
          disabled={!props.dirty || !draftIsComplete(d)}
          onClick={props.onSave}
        >
          {t('fk.save')}
        </Button>
        <Button size="small" onClick={props.onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
