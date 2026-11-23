// The sidebar when nothing is chosen: what to keep an eye on while an agent
// edits the file (warnings now; the changes since the start come later). The
// legend and how-to moved to the "?" in the top bar.

import { AlertIcon, CheckCircleIcon } from '@primer/octicons-react';
import type { Notation, ViewDiagnostic, ViewSchema } from '../../core/view';
import { type EndKind, markerId } from '../diagram/Markers';
import {
  AkNote,
  CheckMark,
  FkMark,
  FkNote,
  GenMark,
  IndexMark,
  NullMark,
  OptionalNote,
  UqMark,
} from '../diagram/marks';
import { t } from '../i18n';
import { PanelHeader } from './controls';
import { Diagnostics } from './TablePanel';

export function Overview(props: {
  schema: ViewSchema;
  diagText: (d: ViewDiagnostic) => string;
  onJump: (d: ViewDiagnostic) => void;
}) {
  const { schema } = props;
  const problems = schema.diagnostics.filter((d) => d.severity !== 'info');
  const notes = schema.diagnostics.filter((d) => d.severity === 'info');
  return (
    <div className="panel-inner">
      <PanelHeader
        icon={problems.length ? <AlertIcon size={16} /> : <CheckCircleIcon size={16} />}
        title={t('overview.title')}
        meta={problems.length ? String(problems.length) : undefined}
      />
      <section className="section">
        {problems.length === 0 && <p className="hint">{t('overview.noProblems')}</p>}
        <Diagnostics list={problems} diagText={props.diagText} onJump={props.onJump} />
      </section>
      {(notes.length > 0 || schema.otherStatements.length > 0) && (
        <section className="section">
          <h3 className="section-title">{t('overview.other')}</h3>
          <Diagnostics list={notes} diagText={props.diagText} onJump={props.onJump} />
          {schema.otherStatements.map((s) => (
            <div key={`${s.line}:${s.head}`} className="mono hint">
              {t('table.line', { line: s.line })}: {s.head}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * A short line as the diagram draws it, with the same markers: its end (as if
 * a box were on the right), dashed or dotted, and "Z" beside an IDEF1X dot.
 */
function LineSample(props: { end?: EndKind; dash?: 'dashed' | 'dotted'; z?: boolean }) {
  const color = props.dash === 'dotted' ? 'var(--fgColor-danger)' : 'var(--fgColor-muted)';
  return (
    <svg width="56" height="22" viewBox="0 0 56 22" aria-hidden="true" className="legend-line">
      <path
        d="M 2 14 L 54 14"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap={props.dash === 'dotted' ? 'round' : undefined}
        strokeDasharray={
          props.dash === 'dashed' ? '5 4' : props.dash === 'dotted' ? '1 4' : undefined
        }
        markerEnd={props.end ? `url(#${markerId(props.end, null)})` : undefined}
      />
      {props.z && (
        <text x="41" y="8" textAnchor="middle" className="fk-card" style={{ fill: color }}>
          Z
        </text>
      )}
    </svg>
  );
}

/** A box split by its line; rounded for a dependent entity. */
function BoxSample({ dependent }: { dependent?: boolean }) {
  return (
    <svg width="56" height="30" viewBox="0 0 56 30" aria-hidden="true" className="legend-line">
      <rect
        x="8"
        y="1"
        width="40"
        height="28"
        rx={dependent ? 8 : 1.5}
        fill="var(--bgColor-default)"
        stroke="var(--borderColor-emphasis)"
      />
      <path d="M 8 11 L 48 11" stroke="var(--borderColor-emphasis)" />
    </svg>
  );
}

function ArrowSample() {
  return (
    <svg width="56" height="16" viewBox="0 0 56 16" aria-hidden="true" className="legend-line">
      <path d="M 2 8 L 54 8" stroke="var(--fgColor-muted)" strokeWidth="1.5" />
      <path
        d="M 24 3.5 L 30.5 8 L 24 12.5"
        stroke="var(--fgColor-muted)"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}

/** What the marks and lines on the diagram mean, and how to edit. Opened from "?". */
export function Help({ notation }: { notation: Notation }) {
  const idef = notation === 'idef1x';
  const entry = (sample: React.ReactNode, text: string) => (
    <>
      <dt>{sample}</dt>
      <dd>{text}</dd>
    </>
  );
  return (
    <div className="help-body">
      <h3 className="section-title">
        {t('legend.title')} · {idef ? 'IDEF1X' : 'IE'}
      </h3>
      <dl className="legend">
        {entry(<BoxSample />, t('legend.keyLine'))}
        {entry(<BoxSample dependent />, t('legend.dependent'))}
        {entry(<LineSample />, t('legend.identifying'))}
        {entry(<LineSample dash="dashed" />, t('legend.nonIdentifying'))}
        {idef ? (
          <>
            {entry(<LineSample end="dot" />, t('legend.dot'))}
            {entry(<LineSample end="dot" z />, t('legend.dotZ'))}
            {entry(<LineSample end="diamond" dash="dashed" />, t('legend.diamond'))}
          </>
        ) : (
          <>
            {entry(<LineSample end="one" />, t('legend.one'))}
            {entry(<LineSample end="zeroOrOne" />, t('legend.zeroOrOne'))}
            {entry(<LineSample end="zeroOrMany" />, t('legend.many'))}
          </>
        )}
        {entry(<ArrowSample />, t('legend.arrow'))}
        {entry(<LineSample dash="dotted" />, t('legend.ignored'))}
        {idef ? (
          <>
            {entry(<FkNote colors={[0]} />, t('legend.fk'))}
            {entry(<AkNote numbers={[1]} />, t('legend.ak'))}
            {entry(<OptionalNote />, t('legend.null'))}
          </>
        ) : (
          <>
            {entry(<FkMark colors={[0]} />, t('legend.fk'))}
            {entry(<UqMark />, t('legend.uq'))}
            {entry(<NullMark />, t('legend.null'))}
          </>
        )}
        {entry(<IndexMark />, t('legend.index'))}
        {entry(<CheckMark checks={[]} />, t('legend.check'))}
        {entry(<GenMark />, t('legend.gen'))}
      </dl>
      <p className="hint legend-note">{t('legend.ddlOnly')}</p>
      <p className="hint legend-note">{t(idef ? 'legend.sourceIdef1x' : 'legend.sourceIe')}</p>
      <h3 className="section-title">{t('overview.howto')}</h3>
      <ul className="help">
        <li>{t('help.edit')}</li>
        <li>{t('help.menu')}</li>
        <li>{t('help.line')}</li>
        <li>{t('help.details')}</li>
        <li>{t('help.file')}</li>
      </ul>
    </div>
  );
}
