// Small inputs that write back only when an edit is finished (Enter or
// leaving the field), never on every keystroke.

import { XIcon } from '@primer/octicons-react';
import { IconButton, Select, Textarea, TextInput, Token } from '@primer/react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { RefAction } from '../../core/model';
import { t } from '../i18n';

export function EditText(props: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  label?: string;
  list?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(props.value);
  }, [props.value]);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      setDraft(props.value);
      (e.target as HTMLElement).blur();
    } else if (
      e.key === 'Enter' &&
      (!props.multiline || e.metaKey || e.ctrlKey) &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
  };
  const common = {
    value: draft,
    placeholder: props.placeholder,
    'aria-label': props.label,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onKeyDown,
  };
  return props.multiline ? (
    <Textarea
      rows={2}
      block
      resize="vertical"
      className={props.mono ? 'is-mono' : undefined}
      {...common}
    />
  ) : (
    <TextInput size="small" block monospace={props.mono} list={props.list} {...common} />
  );
}

/** An ordered list of column names, as tokens, with a picker to append one. */
export function ColumnList(props: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
  label?: string;
}) {
  const rest = props.options.filter((o) => !props.value.includes(o));
  return (
    <fieldset className="chips" aria-label={props.label}>
      {props.value.map((c, i) => (
        <Token
          key={c}
          text={c}
          size="medium"
          onRemove={() => props.onChange(props.value.filter((_, k) => k !== i))}
        />
      ))}
      {rest.length > 0 && (
        <Select
          size="small"
          className="chip-add"
          value=""
          aria-label={t('key.addColumn')}
          onChange={(e) => e.target.value && props.onChange([...props.value, e.target.value])}
        >
          <Select.Option value="">{t('key.addColumn')}</Select.Option>
          {rest.map((o) => (
            <Select.Option key={o} value={o}>
              {o}
            </Select.Option>
          ))}
        </Select>
      )}
    </fieldset>
  );
}

export const ACTIONS: RefAction[] = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];

export function ActionSelect(props: {
  value: RefAction | null;
  onChange: (v: RefAction | null) => void;
  label: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <Select
        size="small"
        block
        value={props.value ?? ''}
        onChange={(e) => props.onChange((e.target.value || null) as RefAction | null)}
      >
        <Select.Option value="">{t('fk.none')}</Select.Option>
        {ACTIONS.map((a) => (
          <Select.Option key={a} value={a}>
            {a}
          </Select.Option>
        ))}
      </Select>
    </label>
  );
}

export const COMMON_TYPES = [
  'BIGINT UNSIGNED',
  'INT',
  'INT UNSIGNED',
  'TINYINT',
  'DECIMAL(15,0)',
  'VARCHAR(255)',
  'VARCHAR(100)',
  'TEXT',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'JSON',
  'BOOLEAN',
];

export function TypeOptions() {
  return (
    <datalist id="dbdialog-types">
      {COMMON_TYPES.map((x) => (
        <option key={x} value={x} />
      ))}
    </datalist>
  );
}

/** The heading row of the side panel, with a close button when there is somewhere to go back to. */
export function PanelHeader(props: {
  icon: ReactNode;
  title: string;
  meta?: string;
  onClose?: () => void;
}) {
  return (
    <div className="panel-header">
      <span className="panel-header-icon">{props.icon}</span>
      <h2 className="panel-title" title={props.title}>
        {props.title}
      </h2>
      {props.meta && <span className="panel-meta">{props.meta}</span>}
      {props.onClose && (
        <IconButton
          icon={XIcon}
          aria-label={t('common.close')}
          size="small"
          variant="invisible"
          onClick={props.onClose}
        />
      )}
    </div>
  );
}
