// The marks of a column: always an icon and its text, never the icon alone.
// In IDEF1X, the notes of the standard take their place: (FK), (AK1), (O).
// Octicons where GitHub has the symbol; Lucide (ISC) for the two it lacks.
// `data-tip` is shown by the page's tooltip layer (Tip.tsx) when pointed at.

import {
  KeyIcon,
  LinkIcon,
  ListOrderedIcon,
  ShieldCheckIcon,
  SkipIcon,
} from '@primer/octicons-react';
import { Fingerprint, Sigma } from 'lucide-react';
import type { KeyKind } from '../../core/model';
import type { Notation, ViewCheck, ViewColumn } from '../../core/view';
import { t } from '../i18n';
import { fkColor } from './colors';

export function PkMark({ tip }: { tip?: string }) {
  return (
    <span className="mark mark-pk" data-tip={tip ?? t('mark.pk')}>
      <KeyIcon size={12} />
      PK
    </span>
  );
}

/** One dot per foreign key the column belongs to, in the color of that key's lines. */
export function FkMark({ colors }: { colors: number[] }) {
  return (
    <span className="mark mark-fk" data-tip={t('mark.fk')}>
      <LinkIcon size={12} />
      FK
      {[...new Set(colors)].map((color) => (
        <i key={color} className="mark-dot" style={{ background: fkColor(color) }} />
      ))}
    </span>
  );
}

export function UqMark({ tip }: { tip?: string }) {
  return (
    <span className="mark mark-uq" data-tip={tip ?? t('mark.uq')}>
      <Fingerprint size={12} strokeWidth={2.25} />
      UQ
    </span>
  );
}

export function IndexMark({ tip }: { tip?: string }) {
  return (
    <span className="mark mark-idx" data-tip={tip ?? t('mark.index')}>
      <ListOrderedIcon size={12} />
      IDX
    </span>
  );
}

export function GenMark({ tip }: { tip?: string }) {
  return (
    <span className="mark mark-gen" data-tip={tip ?? t('legend.gen')}>
      <Sigma size={12} strokeWidth={2.25} />
      AS
    </span>
  );
}

/** On every column a CHECK constraint mentions; the tooltip shows the expressions. */
export function CheckMark({ checks }: { checks: ViewCheck[] }) {
  const tip = checks.length ? checks.map((c) => `CHECK (${c.expr})`).join('\n') : t('legend.check');
  return (
    <span className="mark mark-check" data-tip={tip}>
      <ShieldCheckIcon size={12} />
      CHECK
    </span>
  );
}

export function NullMark() {
  return (
    <span className="mark mark-null" data-tip={t('mark.null')}>
      <SkipIcon size={12} />
      NULL
    </span>
  );
}

// IDEF1X writes what a column is after its name, in parentheses (FIPS PUB 184).

/** IDEF1X "(FK)", with the dots of its lines' colors as on the FK mark. */
export function FkNote({ colors }: { colors: number[] }) {
  return (
    <span className="note note-fk" data-tip={t('mark.fk')}>
      (FK)
      {[...new Set(colors)].map((color) => (
        <i key={color} className="mark-dot" style={{ background: fkColor(color) }} />
      ))}
    </span>
  );
}

/** IDEF1X "(AK1)" or "(AK1, AK2)": the alternate keys (UNIQUE keys) the column is in. */
export function AkNote({ numbers }: { numbers: number[] }) {
  return (
    <span className="note note-ak" data-tip={t('mark.ak')}>
      ({numbers.map((n) => `AK${n}`).join(', ')})
    </span>
  );
}

/** IDEF1X "(O)": an optional attribute, one that may be NULL. */
export function OptionalNote() {
  return (
    <span className="note note-o" data-tip={t('mark.null')}>
      (O)
    </span>
  );
}

/**
 * The mark of a key listed under the columns of a box. IDEF1X names a UNIQUE
 * key by its alternate key number (`ak`; none yet while one is being made).
 */
export function KeyMark(props: { kind: KeyKind; notation: Notation; ak?: number }) {
  const { kind } = props;
  if (kind === 'primary') return <PkMark />;
  if (kind === 'unique') {
    if (props.notation === 'idef1x')
      return (
        <span className="note note-ak" data-tip={t('mark.ak')}>
          AK{props.ak ?? ''}
        </span>
      );
    return <UqMark />;
  }
  return <IndexMark tip={kind === 'index' ? undefined : kind.toUpperCase()} />;
}

/** A primary key column is NOT NULL whatever its definition says. */
export const allowsNull = (c: ViewColumn) => c.nullable !== false && !c.primaryKey;

/**
 * `colors`: the foreign keys MySQL creates (inline REFERENCES are ignored, so
 * they get no mark). `aks`: the column's alternate key numbers (IDEF1X).
 * No mark for the primary key: its columns are the rows above the line.
 */
export function ColumnMarks(props: {
  c: ViewColumn;
  colors: number[];
  checks: ViewCheck[];
  notation: Notation;
  aks: number[];
}) {
  const { c } = props;
  const idef = props.notation === 'idef1x';
  return (
    <span className="marks">
      {props.colors.length > 0 &&
        (idef ? <FkNote colors={props.colors} /> : <FkMark colors={props.colors} />)}
      {idef
        ? props.aks.length > 0 && <AkNote numbers={props.aks} />
        : c.unique && !c.primaryKey && <UqMark />}
      {c.generated && (
        <GenMark tip={t('mark.gen', { storage: c.generated.storage, expr: c.generated.expr })} />
      )}
      {props.checks.length > 0 && <CheckMark checks={props.checks} />}
    </span>
  );
}
