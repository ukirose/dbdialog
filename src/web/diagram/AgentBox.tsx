// A box of the agent view: the table's name, its primary key (the shape of the
// keys across the schema is a pattern a picture shows: every table on an
// ID of its own, or keys made of the parents' keys), and how many foreign keys
// it has to parents and how many reference it, so the lines on a box can be
// checked against text. Other columns, types and constraints are left to the
// SQL. Dependent entities are not drawn round as in the editor: in reading
// tests an agent took square boxes for round ones, and the solid line into a
// box says the same.

import { memo } from 'react';
import type { ViewTable } from '../../core/view';
import { t } from '../i18n';

export const AgentBox = memo(function AgentBox(props: {
  table: ViewTable;
  /** Foreign keys of the table, and foreign keys referencing it, in the whole file. */
  counts: { parents: number; children: number };
}) {
  return (
    <div className="abox">
      <div className="abox-name">{props.table.name}</div>
      <div className="abox-pk">
        {props.table.primaryKey
          ? t('agent.pk', { columns: props.table.primaryKey.columns.join(', ') })
          : t('box.noKey')}
      </div>
      <div className="abox-counts">{t('agent.counts', props.counts)}</div>
    </div>
  );
});
