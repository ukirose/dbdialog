// The sidebar for a chosen table: only what the box does not show, or what
// needs more room than a cell (DEFAULT, generated expressions, constraint
// names, ON DELETE, CHECK expressions, the SQL). The rest is edited on the box.

import {
  AlertIcon,
  ColumnsIcon,
  CopyIcon,
  PlusIcon,
  StopIcon,
  TableIcon,
  TrashIcon,
  XIcon,
} from '@primer/octicons-react';
import { Button, Checkbox, Flash, IconButton, Label, Select, TextInput } from '@primer/react';
import { useEffect, useRef, useState } from 'react';
import type { Op } from '../../core/ops';
import type {
  ViewCheck,
  ViewColumn,
  ViewDiagnostic,
  ViewForeignKey,
  ViewKey,
  ViewTable,
} from '../../core/view';
import { fkColor, fkKey } from '../diagram/colors';
import { t } from '../i18n';
import { highlightSql } from '../sqlHighlight';
import type { Flow } from '../valueFlow';
import { ActionSelect, ColumnList, EditText, PanelHeader } from './controls';
import { type FkDraft, PairsEditor } from './ForeignKeyEditor';

/** Sends edits; when the server says something still uses the target, `cascade` is offered. */
export type Run = (ops: Op[], cascade?: Op[]) => Promise<boolean>;

const ref = (x: { id: string; text: string }) => ({ id: x.id, text: x.text });
const lower = (s: string) => s.toLowerCase();

/** Diagnostics are rebuilt as a whole on every change; their content is their identity. */
export function diagnosticKey(d: ViewDiagnostic): string {
  return `${d.code}:${d.line}:${d.column}:${JSON.stringify(d.params)}`;
}

export function Diagnostics(props: {
  list: ViewDiagnostic[];
  diagText: (d: ViewDiagnostic) => string;
  onJump?: (d: ViewDiagnostic) => void;
}) {
  return (
    <>
      {props.list.map((d) => (
        <Flash
          key={diagnosticKey(d)}
          variant={
            d.severity === 'error' ? 'danger' : d.severity === 'warning' ? 'warning' : 'default'
          }
          className="note"
        >
          {d.severity === 'error' ? <StopIcon /> : <AlertIcon />}
          <span>
            {props.onJump && d.table ? (
              <button type="button" className="note-link" onClick={() => props.onJump?.(d)}>
                {d.table}
              </button>
            ) : null}{' '}
            <span className="hint">{t('table.line', { line: d.line })}</span> {props.diagText(d)}
          </span>
        </Flash>
      ))}
    </>
  );
}

/** What a column has that the box does not show. */
function detailChips(c: ViewColumn): string[] {
  const out: string[] = [];
  if (c.default !== null) out.push(`DEFAULT ${c.default}`);
  if (c.onUpdate !== null) out.push(`ON UPDATE ${c.onUpdate}`);
  if (c.autoIncrement) out.push('AUTO_INCREMENT');
  if (c.generated) out.push(`AS (…) ${c.generated.storage}`);
  if (c.collation) out.push(`COLLATE ${c.collation}`);
  return out;
}

/** Where the chosen column's values come from, the key first, and how far they go. */
function FlowText({ flow }: { flow: Flow }) {
  const tables = new Set(flow.columns.map((c) => c.table)).size;
  return (
    <div className="field">
      <span className="field-label">{t('details.flow')}</span>
      <div className="flow-path mono">
        {[...flow.path]
          .reverse()
          .map((c) => `${c.table}.${c.column}`)
          .join(' ← ')}
      </div>
      <div className="hint">{t('details.flowCount', { columns: flow.columns.length, tables })}</div>
    </div>
  );
}

function ColumnDetails(props: {
  table: ViewTable;
  column: ViewColumn;
  flow: Flow | null;
  run: Run;
  onClose: () => void;
  onFocusFk: (id: string) => void;
}) {
  const { table, column: c, run } = props;
  const update = (set: Record<string, unknown>, expect: Record<string, unknown>) =>
    run([{ op: 'column.update', table: table.name, column: c.name, set, expect }]);
  const [genOn, setGenOn] = useState(c.generated !== null);
  useEffect(() => setGenOn(c.generated !== null), [c.generated]);
  const inlineFk = table.foreignKeys.find((f) => f.origin === 'column' && f.columns[0] === c.name);
  const has = (cols: string[]) => cols.some((x) => lower(x) === lower(c.name));
  const keys = [...(table.primaryKey ? [table.primaryKey] : []), ...table.keys].filter((k) =>
    has(k.columns),
  );
  const fks = table.foreignKeys.filter((f) => has(f.columns));
  const checks = table.checks.filter((x) => x.columns.includes(c.name));
  return (
    <section className="section is-focused">
      <h3 className="section-title">
        <ColumnsIcon size={14} />
        {t('details.column', { column: c.name })}
        <span className="spacer" />
        <IconButton
          icon={XIcon}
          aria-label={t('common.close')}
          size="small"
          variant="invisible"
          onClick={props.onClose}
        />
      </h3>
      <div className="hint mono field">
        {c.name} {c.type}
      </div>
      {props.flow && <FlowText flow={props.flow} />}
      {!c.generated && (
        <label className="field">
          <span className="field-label">DEFAULT</span>
          <EditText
            value={c.default ?? ''}
            mono
            placeholder={t('column.defaultHint')}
            onCommit={(v) =>
              update({ default: v.trim() === '' ? null : v }, { default: c.default })
            }
          />
        </label>
      )}
      <div className="checks">
        <label className="check">
          <Checkbox
            checked={c.autoIncrement}
            onChange={(e) =>
              update({ autoIncrement: e.target.checked }, { autoIncrement: c.autoIncrement })
            }
          />
          AUTO_INCREMENT
        </label>
        <label className="check">
          <Checkbox
            checked={genOn}
            onChange={(e) => {
              if (e.target.checked) setGenOn(true);
              else if (c.generated) update({ generated: null }, { generated: c.generated });
              else setGenOn(false);
            }}
          />
          {t('column.generated')}
        </label>
      </div>
      {genOn && (
        <div className="gen field">
          <EditText
            value={c.generated?.expr ?? ''}
            mono
            label={t('column.generatedExpr')}
            placeholder="amount - tax_amount"
            onCommit={(v) => {
              if (v.trim() === '') return;
              update(
                { generated: { expr: v, storage: c.generated?.storage ?? 'STORED' } },
                { generated: c.generated },
              );
            }}
          />
          <Select
            size="small"
            aria-label="STORED / VIRTUAL"
            value={c.generated?.storage ?? 'STORED'}
            disabled={!c.generated}
            onChange={(e) =>
              c.generated &&
              update(
                { generated: { expr: c.generated.expr, storage: e.target.value } },
                { generated: c.generated },
              )
            }
          >
            <Select.Option value="STORED">STORED</Select.Option>
            <Select.Option value="VIRTUAL">VIRTUAL</Select.Option>
          </Select>
        </div>
      )}
      {c.collation && (
        <div className="hint field">{t('column.collation', { collation: c.collation })}</div>
      )}
      {inlineFk && (
        <Flash variant="warning" className="note">
          <p>{t('fk.inline')}</p>
          <Button
            size="small"
            onClick={() =>
              run([{ op: 'fk.makeTableLevel', table: table.name, target: ref(inlineFk) }])
            }
          >
            {t('column.makeFk')}
          </Button>
        </Flash>
      )}
      {(keys.length > 0 || fks.length > 0 || checks.length > 0) && (
        <div className="field">
          <span className="field-label">{t('details.usedBy')}</span>
          <ul className="uses">
            {keys.map((k) => (
              <li key={`${k.id}:${k.text}`} className="mono">
                {k.kind === 'primary' ? 'PRIMARY KEY' : k.kind.toUpperCase()} (
                {k.columns.join(', ')})
              </li>
            ))}
            {fks.map((f) => (
              <li key={`${f.id}:${f.text}`}>
                <button
                  type="button"
                  className="note-link mono"
                  onClick={() => props.onFocusFk(f.id)}
                >
                  ({f.columns.join(', ')}) → {f.refTable} ({f.refColumns.join(', ')})
                </button>
              </li>
            ))}
            {checks.map((x) => (
              <li key={`${x.id}:${x.text}`} className="mono">
                CHECK ({x.expr})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function KeyItem(props: { table: ViewTable; k: ViewKey; run: Run }) {
  const { table, k, run } = props;
  return (
    <div className="item">
      <div className="item-head">
        <Label variant={k.kind === 'unique' ? 'done' : 'secondary'}>{k.kind.toUpperCase()}</Label>
        {k.origin === 'table' ? (
          <EditText
            value={k.name ?? ''}
            mono
            placeholder={t('key.name')}
            onCommit={(v) =>
              run([{ op: 'key.update', table: table.name, target: ref(k), name: v.trim() || null }])
            }
          />
        ) : (
          <span className="hint">{t('key.inline')}</span>
        )}
        <IconButton
          icon={TrashIcon}
          aria-label={t('key.delete')}
          size="small"
          variant="invisible"
          onClick={() => run([{ op: 'key.delete', table: table.name, target: ref(k) }])}
        />
      </div>
      <ColumnList
        value={k.columns}
        options={table.columns.map((c) => c.name)}
        onChange={(v) =>
          v.length > 0 && run([{ op: 'key.update', table: table.name, target: ref(k), columns: v }])
        }
      />
    </div>
  );
}

function pairsOf(table: string, fk: ViewForeignKey): FkDraft {
  return {
    table,
    refTable: fk.refTable,
    pairs: fk.columns.map((c, i) => [c, fk.refColumns[i] ?? ''] as [string, string]),
  };
}

function FkItem(props: {
  table: ViewTable;
  tables: ViewTable[];
  fk: ViewForeignKey;
  color: number | undefined;
  run: Run;
  focused: boolean;
  onFocus: () => void;
  onHover: (on: boolean) => void;
}) {
  const { table, fk, run } = props;
  const [pairs, setPairs] = useState<FkDraft | null>(null);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.focused) el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [props.focused]);
  const update = (patch: Record<string, unknown>) =>
    run([{ op: 'fk.update', table: table.name, target: ref(fk), fk: patch }]);
  return (
    <div ref={el} className={`item${props.focused ? ' is-focused' : ''}`}>
      <button
        type="button"
        className="item-summary"
        onClick={props.onFocus}
        onMouseEnter={() => props.onHover(true)}
        onMouseLeave={() => props.onHover(false)}
      >
        <span
          className="swatch"
          style={{
            background: props.color === undefined ? 'var(--fgColor-danger)' : fkColor(props.color),
          }}
        />
        <span className="item-summary-text mono">
          ({fk.columns.join(', ')}) → {fk.refTable} ({fk.refColumns.join(', ')})
        </span>
      </button>
      {fk.origin === 'column' ? (
        <Flash variant="warning" className="note">
          <p>{t('fk.inline')}</p>
          <div className="actions">
            <Button
              size="small"
              onClick={() => run([{ op: 'fk.makeTableLevel', table: table.name, target: ref(fk) }])}
            >
              {t('column.makeFk')}
            </Button>
            <Button
              size="small"
              variant="danger"
              onClick={() => run([{ op: 'fk.delete', table: table.name, target: ref(fk) }])}
            >
              {t('key.delete')}
            </Button>
          </div>
        </Flash>
      ) : (
        <>
          <div className="field-row">
            <ActionSelect
              label="ON DELETE"
              value={fk.onDelete}
              onChange={(v) => update({ onDelete: v })}
            />
            <ActionSelect
              label="ON UPDATE"
              value={fk.onUpdate}
              onChange={(v) => update({ onUpdate: v })}
            />
          </div>
          <label className="field">
            <span className="field-label">{t('fk.name')}</span>
            <EditText
              value={fk.name ?? ''}
              mono
              onCommit={(v) => update({ name: v.trim() || null })}
            />
          </label>
          {pairs ? (
            <PairsEditor
              value={pairs}
              tables={props.tables}
              onChange={setPairs}
              dirty={JSON.stringify(pairs) !== JSON.stringify(pairsOf(table.name, fk))}
              onCancel={() => setPairs(null)}
              onSave={async () => {
                const ok = await update({
                  refTable: pairs.refTable,
                  columns: pairs.pairs.map((p) => p[0]),
                  refColumns: pairs.pairs.map((p) => p[1]),
                });
                if (ok) setPairs(null);
              }}
            />
          ) : (
            <div className="actions">
              <Button size="small" onClick={() => setPairs(pairsOf(table.name, fk))}>
                {t('fk.editPairs')}
              </Button>
              <Button
                size="small"
                variant="danger"
                leadingVisual={TrashIcon}
                onClick={() => run([{ op: 'fk.delete', table: table.name, target: ref(fk) }])}
              >
                {t('key.delete')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CheckItem(props: { table: ViewTable; c: ViewCheck; run: Run }) {
  const { table, c, run } = props;
  return (
    <div className="item">
      <div className="item-head">
        <Label variant="attention">CHECK</Label>
        {c.origin === 'table' ? (
          <EditText
            value={c.name ?? ''}
            mono
            placeholder={t('check.name')}
            onCommit={(v) =>
              run([
                { op: 'check.update', table: table.name, target: ref(c), name: v.trim() || null },
              ])
            }
          />
        ) : (
          <span className="hint">{t('check.column', { column: c.column ?? '' })}</span>
        )}
        <IconButton
          icon={TrashIcon}
          aria-label={t('key.delete')}
          size="small"
          variant="invisible"
          onClick={() => run([{ op: 'check.delete', table: table.name, target: ref(c) }])}
        />
      </div>
      <EditText
        value={c.expr}
        multiline
        mono
        label={t('check.expr')}
        onCommit={(v) =>
          v.trim() && run([{ op: 'check.update', table: table.name, target: ref(c), expr: v }])
        }
      />
      {c.enforced === false && <div className="hint">{t('check.enforcedOff')}</div>}
    </div>
  );
}

function NewCheck(props: { table: ViewTable; run: Run; onDone: () => void }) {
  const [expr, setExpr] = useState('');
  const [name, setName] = useState('');
  return (
    <div className="item is-new">
      <EditText value={expr} multiline mono label={t('check.expr')} onCommit={setExpr} />
      <TextInput
        size="small"
        block
        monospace
        placeholder={t('check.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="actions">
        <Button
          size="small"
          variant="primary"
          disabled={!expr.trim()}
          onClick={async () => {
            if (
              await props.run([
                { op: 'check.add', table: props.table.name, expr, name: name.trim() || null },
              ])
            )
              props.onDone();
          }}
        >
          {t('table.addCheck')}
        </Button>
        <Button size="small" onClick={props.onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

function SqlView({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sql-wrap">
      <pre className="sql">
        <code>
          {highlightSql(sql).map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the runs are rebuilt whole from the text
            <span key={i} className={`tok-${part.cls}`}>
              {part.text}
            </span>
          ))}
        </code>
      </pre>
      <IconButton
        icon={CopyIcon}
        aria-label={copied ? t('details.copied') : t('details.copy')}
        size="small"
        className="sql-copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // The page may not be allowed to write to the clipboard; nothing else to do.
          }
        }}
      />
    </div>
  );
}

export function TablePanel(props: {
  table: ViewTable;
  tables: ViewTable[];
  colors: Map<string, number>;
  diagnostics: ViewDiagnostic[];
  run: Run;
  column: string | null;
  onChooseColumn: (column: string | null) => void;
  flow: Flow | null;
  focusFk: string | null;
  onFocusFk: (id: string | null) => void;
  onHoverFk: (id: string | null) => void;
  onClose: () => void;
  onDelete: () => void;
  diagText: (d: ViewDiagnostic) => string;
}) {
  const { table, run } = props;
  const [addingCheck, setAddingCheck] = useState(false);
  const chosen = table.columns.find((c) => c.name === props.column) ?? null;
  const problems = props.diagnostics.filter((d) => d.table === table.name);
  const withDetails = table.columns.filter((c) => detailChips(c).length > 0);

  return (
    <div className="panel-inner">
      <PanelHeader
        icon={<TableIcon size={16} />}
        title={table.name}
        meta={t('table.line', { line: table.line })}
        onClose={props.onClose}
      />
      {chosen && (
        <ColumnDetails
          key={chosen.name}
          table={table}
          column={chosen}
          flow={props.flow}
          run={run}
          onClose={() => props.onChooseColumn(null)}
          onFocusFk={(id) => props.onFocusFk(id)}
        />
      )}

      <section className="section">
        <h3 className="section-title">{t('details.columns')}</h3>
        {withDetails.length === 0 ? (
          <p className="hint">{t('details.columnsNone')}</p>
        ) : (
          <ul className="detail-list">
            {withDetails.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  className={`detail-row${c.name === props.column ? ' is-chosen' : ''}`}
                  onClick={() => props.onChooseColumn(c.name)}
                >
                  <span className="detail-name">{c.name}</span>
                  <span className="detail-chips mono">{detailChips(c).join('  ·  ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h3 className="section-title">{t('table.primaryKey')}</h3>
        <ColumnList
          value={table.primaryKey?.columns ?? []}
          options={table.columns.map((c) => c.name)}
          onChange={(v) => run([{ op: 'key.setPrimary', table: table.name, columns: v }])}
        />
        {!table.primaryKey && <div className="hint">{t('key.none')}</div>}
      </section>

      {table.keys.length > 0 && (
        <section className="section">
          <h3 className="section-title">{t('table.keys')}</h3>
          {table.keys.map((k) => (
            <KeyItem key={`${k.id}:${k.text}`} table={table} k={k} run={run} />
          ))}
        </section>
      )}

      <section className="section">
        <h3 className="section-title">{t('table.foreignKeys')}</h3>
        {table.foreignKeys.length === 0 && <p className="hint">{t('details.fkNone')}</p>}
        {table.foreignKeys.map((fk) => (
          <FkItem
            key={`${fk.id}:${fk.text}`}
            table={table}
            tables={props.tables}
            fk={fk}
            color={props.colors.get(fkKey(table.name, fk.id))}
            run={run}
            focused={props.focusFk === fk.id}
            onFocus={() => props.onFocusFk(props.focusFk === fk.id ? null : fk.id)}
            onHover={(on) => props.onHoverFk(on ? fk.id : null)}
          />
        ))}
      </section>

      <section className="section">
        <h3 className="section-title">CHECK</h3>
        {table.checks.map((c) => (
          <CheckItem key={`${c.id}:${c.text}`} table={table} c={c} run={run} />
        ))}
        {addingCheck ? (
          <NewCheck table={table} run={run} onDone={() => setAddingCheck(false)} />
        ) : (
          <Button
            size="small"
            variant="invisible"
            leadingVisual={PlusIcon}
            className="add-link"
            onClick={() => setAddingCheck(true)}
          >
            {t('table.addCheck')}
          </Button>
        )}
      </section>

      {problems.length > 0 && (
        <section className="section">
          <h3 className="section-title">{t('table.problems')}</h3>
          <Diagnostics list={problems} diagText={props.diagText} />
        </section>
      )}

      <section className="section">
        <h3 className="section-title">{t('table.sql')}</h3>
        <SqlView sql={table.sql} />
        <div className="actions">
          <Button size="small" variant="danger" leadingVisual={TrashIcon} onClick={props.onDelete}>
            {t('table.delete')}
          </Button>
        </div>
      </section>
    </div>
  );
}
