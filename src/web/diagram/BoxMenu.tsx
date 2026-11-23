// The "…" menu of a box (and of each row; right-click opens the same one).
// Everything in it changes what the box shows, so it lives on the box.

import { ActionList, ActionMenu } from '@primer/react';
import type { RefObject } from 'react';
import type { Op } from '../../core/ops';
import type { ViewTable } from '../../core/view';
import { t } from '../i18n';
import type { Run } from '../panel/TablePanel';
import type { EditField } from './context';
import { allowsNull } from './marks';

export interface MenuTarget {
  table: string;
  column: string | null;
}

const ref = (x: { id: string; text: string }) => ({ id: x.id, text: x.text });
const lower = (s: string) => s.toLowerCase();
/**
 * After the menu has closed and given the focus back to its button: an input
 * opened before that would lose the focus at once.
 */
const later = (f: () => void) => setTimeout(f, 50);

export function BoxMenu(props: {
  target: MenuTarget | null;
  anchor: RefObject<HTMLElement | null>;
  tables: ViewTable[];
  width: number | null;
  onClose: () => void;
  run: Run;
  confirm: (title: string, content: string) => Promise<boolean>;
  edit: (table: string, field: EditField, column?: string | null) => void;
  addColumn: (table: string, after: string | null) => void;
  details: (table: string, column: string | null) => void;
  startPick: (table: string, kind: 'unique' | 'index') => void;
  setWidth: (table: string, width: number | null) => void;
}) {
  const target = props.target;
  const tbl = target ? props.tables.find((x) => x.name === target.table) : undefined;
  if (!target || !tbl) return null;
  const c = target.column ? tbl.columns.find((x) => x.name === target.column) : undefined;
  const run = props.run;

  const body = c ? (
    <ActionList>
      <ActionList.Group selectionVariant="multiple">
        <ActionList.Item
          selected={allowsNull(c)}
          disabled={c.primaryKey}
          onSelect={() =>
            run([
              {
                op: 'column.update',
                table: tbl.name,
                column: c.name,
                set: { nullable: !allowsNull(c) },
                expect: { nullable: c.nullable },
              },
            ])
          }
        >
          {t('menu.allowNull')}
        </ActionList.Item>
        <ActionList.Item
          selected={c.primaryKey}
          onSelect={() => {
            const pk = tbl.primaryKey?.columns ?? [];
            const ops: Op[] = [];
            if (c.primaryKey) {
              ops.push({
                op: 'key.setPrimary',
                table: tbl.name,
                columns: pk.filter((x) => lower(x) !== lower(c.name)),
              });
            } else {
              // A primary key column must be NOT NULL; MySQL refuses one declared NULL.
              if (c.nullable === true)
                ops.push({
                  op: 'column.update',
                  table: tbl.name,
                  column: c.name,
                  set: { nullable: false },
                  expect: { nullable: true },
                });
              ops.push({ op: 'key.setPrimary', table: tbl.name, columns: [...pk, c.name] });
            }
            run(ops);
          }}
        >
          {t('menu.primaryKey')}
        </ActionList.Item>
        <ActionList.Item
          selected={c.unique}
          disabled={c.primaryKey}
          onSelect={() => {
            const k = tbl.keys.find(
              (x) =>
                x.kind === 'unique' &&
                x.columns.length === 1 &&
                lower(x.columns[0] ?? '') === lower(c.name),
            );
            run([
              k
                ? { op: 'key.delete', table: tbl.name, target: ref(k) }
                : { op: 'key.add', table: tbl.name, kind: 'unique', columns: [c.name], name: null },
            ]);
          }}
        >
          UNIQUE
        </ActionList.Item>
        <ActionList.Item
          selected={c.autoIncrement}
          onSelect={() =>
            run([
              {
                op: 'column.update',
                table: tbl.name,
                column: c.name,
                set: { autoIncrement: !c.autoIncrement },
                expect: { autoIncrement: c.autoIncrement },
              },
            ])
          }
        >
          AUTO_INCREMENT
        </ActionList.Item>
      </ActionList.Group>
      <ActionList.Divider />
      <ActionList.Item onSelect={() => later(() => props.edit(tbl.name, 'comment', c.name))}>
        {t('menu.writeComment')}
      </ActionList.Item>
      <ActionList.Item onSelect={() => later(() => props.addColumn(tbl.name, c.name))}>
        {t('menu.insertBelow')}
      </ActionList.Item>
      <ActionList.Item onSelect={() => props.details(tbl.name, c.name)}>
        {t('menu.details')}
      </ActionList.Item>
      <ActionList.Divider />
      <ActionList.Item
        variant="danger"
        onSelect={async () => {
          if (
            !(await props.confirm(
              t('column.delete'),
              t('column.deleteConfirm', { column: c.name }),
            ))
          )
            return;
          const op: Op = { op: 'column.delete', table: tbl.name, column: c.name };
          run([op], [{ ...op, cascade: true }]);
        }}
      >
        {t('column.delete')}
      </ActionList.Item>
    </ActionList>
  ) : (
    <ActionList>
      <ActionList.Item onSelect={() => later(() => props.edit(tbl.name, 'table-name'))}>
        {t('menu.rename')}
      </ActionList.Item>
      <ActionList.Item onSelect={() => later(() => props.edit(tbl.name, 'table-comment'))}>
        {t('menu.writeComment')}
      </ActionList.Item>
      <ActionList.Item onSelect={() => later(() => props.addColumn(tbl.name, null))}>
        {t('table.addColumn')}
      </ActionList.Item>
      <ActionList.Item onSelect={() => props.startPick(tbl.name, 'unique')}>
        {t('menu.addUnique')}
      </ActionList.Item>
      <ActionList.Item onSelect={() => props.startPick(tbl.name, 'index')}>
        {t('menu.addIndex')}
      </ActionList.Item>
      {props.width !== null && (
        <ActionList.Item onSelect={() => props.setWidth(tbl.name, null)}>
          {t('menu.autoWidth')}
        </ActionList.Item>
      )}
      <ActionList.Item onSelect={() => props.details(tbl.name, null)}>
        {t('menu.details')}
      </ActionList.Item>
      <ActionList.Divider />
      <ActionList.Item
        variant="danger"
        onSelect={async () => {
          if (
            !(await props.confirm(t('table.delete'), t('table.deleteConfirm', { table: tbl.name })))
          )
            return;
          const op: Op = { op: 'table.delete', table: tbl.name };
          run([op], [{ ...op, cascade: true }]);
        }}
      >
        {t('table.delete')}
      </ActionList.Item>
    </ActionList>
  );

  return (
    <ActionMenu
      open
      anchorRef={props.anchor}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <ActionMenu.Overlay width="small">{body}</ActionMenu.Overlay>
    </ActionMenu>
  );
}
