// The view for coding agents (/?view=agent): the graph of the tables, for an
// agent to take in from a screenshot. It shows what a picture shows best, how
// the tables hang together and where that pattern breaks, and leaves to the
// SQL what one statement says: no types, NULL or constraints. Parents stand
// left of their children; each foreign key is a line from the child to the
// parent, with an arrowhead at the parent, solid when it is identifying,
// dashed when not; a line that needs a look (it closes a cycle, or leaves out
// the column most keys carry) is red, with the reason on it; a column named
// like a reference with no foreign key runs to a "?". Each box gives its
// primary key. ELK places the boxes, the lines and the labels, so nothing covers
// anything. The header says what the picture holds and how to read it, and
// the page carries the same as text, for agents reading the page and for
// `dbdialog snapshot`. It only reads: the file and its layout stay as they are.
//
//   ?focus=<table>   that table and the tables next to it
//   ?lang=en|ja      instead of the browser's language

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServerState } from '../core/view';
import { AgentBox } from './diagram/AgentBox';
import {
  danglingColumns,
  degrees,
  focusTables,
  sharedColumn,
  structureChecks,
} from './diagram/agent';
import {
  type AgentScene,
  agentLayout,
  type LabelSize,
  pictureChecks,
  type Size,
} from './diagram/agentLayout';
import { AGENT_PALETTE, agentColor, assignFkColors, fkKey } from './diagram/colors';
import { cycleClosers } from './diagram/elkLayout';
import { applyDefault, setLangHere, t } from './i18n';

/**
 * Below this scale the page says the text is small. The smallest text (the
 * 12px counts) then falls under 12px in the default picture of
 * `dbdialog snapshot` (1600 × 1000 CSS pixels at 1.25). Reading tests: at
 * 11px and up agents read every token; at 8–10px they doubt digits.
 */
const MIN_ZOOM = 0.8;
/** Room around the scene, in CSS pixels (the canvas's padding). */
const MARGIN = 8;

const params = new URLSearchParams(window.location.search);

/** The arrowhead at the parent end: the way the foreign key points. */
function arrowAt(points: [number, number][]): string {
  const [ax, ay] = points[points.length - 2] ?? [0, 0];
  const [bx, by] = points[points.length - 1] ?? [0, 0];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
  const [cx, cy] = [bx - ux * 10, by - uy * 10];
  return `M ${bx} ${by} L ${cx - uy * 5} ${cy + ux * 5} L ${cx + uy * 5} ${cy - ux * 5} Z`;
}

function View({ state }: { state: ServerState }) {
  const all = state.schema.tables;
  const asked = params.get('focus');
  const focus = asked && all.some((x) => x.name === asked) ? asked : null;
  const tables = useMemo(() => (focus ? focusTables(all, focus) : all), [all, focus]);
  const counts = useMemo(() => degrees(all), [all]);
  const colors = useMemo(() => assignFkColors(all, AGENT_PALETTE.length), [all]);
  const byKey = useMemo(
    () =>
      new Map(
        tables.flatMap((x) => x.foreignKeys.map((fk) => [fkKey(x.name, fk.id), fk] as const)),
      ),
    [tables],
  );
  // Columns named like a reference with no foreign key: each runs to a "?".
  const stubs = useMemo(
    () => tables.flatMap((x) => danglingColumns(x).map((column) => ({ table: x.name, column }))),
    [tables],
  );
  // The column most foreign keys of the file carry, and the reason each line
  // needs a look, written on it: it closes a cycle, or it leaves that column out.
  const shared = useMemo(() => sharedColumn(all), [all]);
  const reasons = useMemo(() => {
    const closers = cycleClosers(tables);
    const out = new Map<string, string>();
    for (const x of tables) {
      for (const fk of x.foreignKeys) {
        const key = fkKey(x.name, fk.id);
        const why = [
          closers.has(key) ? t('agent.cycleLabel') : '',
          shared?.missing.has(key) ? t('agent.missingLabel', { column: shared.column }) : '',
        ].filter(Boolean);
        if (why.length > 0) out.set(key, why.join(' · '));
      }
    }
    return [...out];
  }, [tables, shared]);
  const [drawn, setDrawn] = useState<{ scene: AgentScene; zoom: number } | null>(null);
  const [shot, setShot] = useState<Size | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  const box = (name: string) => {
    const x = tables.find((y) => y.name === name);
    const c = counts.get(name) ?? { parents: 0, children: 0 };
    return x && <AgentBox table={x} counts={c} />;
  };

  // Measure the boxes as the browser draws them, then lay them out at a scale
  // that fits the window (never above 1).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await document.fonts.ready;
      const root = measureRef.current;
      const canvas = canvasRef.current;
      if (!root || !canvas || cancelled) return;
      const size = (el: Element): Size => {
        const r = el.getBoundingClientRect();
        return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
      };
      const measured: Record<string, Size> = {};
      for (const el of root.querySelectorAll<HTMLElement>('[data-table]'))
        measured[el.dataset.table ?? ''] = size(el);
      const sized = [...root.querySelectorAll('[data-stub]')].map(size);
      const labels: Record<string, LabelSize> = {};
      [...root.querySelectorAll('[data-label]')].forEach((el, i) => {
        const [key, text] = reasons[i] ?? [];
        if (key && text) labels[key] = { text, ...size(el) };
      });
      const scene = await agentLayout(tables, measured, {
        stubs: stubs.map((s, i) => ({ ...s, size: sized[i] ?? { width: 80, height: 24 } })),
        labels,
      });
      if (cancelled) return;
      const zoom = Math.min(
        1,
        (canvas.clientWidth - 2 * MARGIN) / scene.width,
        (canvas.clientHeight - 2 * MARGIN) / scene.height,
      );
      setDrawn({ scene, zoom });
    })();
    return () => {
      cancelled = true;
    };
  }, [tables, stubs, reasons]);

  // Once the scene is on the page: the size of a picture that holds it all.
  useEffect(() => {
    if (!drawn) return;
    const frame = requestAnimationFrame(() => {
      const header = headerRef.current;
      const text = header
        ? Math.max(
            ...[...header.querySelectorAll<HTMLElement>('.agent-line > span')].map(
              (s) => s.getBoundingClientRect().width,
            ),
          ) + 48
        : 0;
      setShot({
        width: Math.min(
          window.innerWidth,
          Math.ceil(Math.max(text, drawn.scene.width * drawn.zoom + 2 * MARGIN)),
        ),
        height: Math.min(
          window.innerHeight,
          Math.ceil((header?.offsetHeight ?? 0) + drawn.scene.height * drawn.zoom + 2 * MARGIN),
        ),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [drawn]);

  const checks = useMemo(() => structureChecks(tables), [tables]);
  const picture = drawn ? pictureChecks(drawn.scene) : null;
  const small = drawn !== null && drawn.zoom < MIN_ZOOM;
  const scope = [
    focus ? t('agent.focus', { table: focus }) : t('agent.whole'),
    drawn && drawn.zoom < 1 ? t('agent.zoom', { zoom: drawn.zoom.toFixed(2) }) : '',
  ].filter(Boolean);
  const smells = [
    t('agent.smells', { dangling: checks.dangling.length }),
    ...(checks.shared
      ? [
          t('agent.sharedSmell', {
            column: checks.shared.column,
            missing: checks.shared.missing.length,
            carried: checks.shared.carried,
            total: checks.shared.total,
          }),
        ]
      : []),
  ].join(' · ');
  const summary = picture
    ? t('agent.summary', {
        tables: checks.tables,
        relationships: checks.relationships,
        cycles: checks.cycles.length,
        isolated: checks.isolated.length,
        overlaps: picture.overlaps,
        behind: picture.behind,
      })
    : '';
  // The header as text, and what the picture shows as words: for agents
  // reading the page, and what `dbdialog snapshot` prints.
  const text = [
    `${t('agent.title')}: ${state.schema.file}`,
    [...scope, ...(small ? [t('agent.small')] : [])].join(' · '),
    summary,
    smells,
    t('agent.legend'),
    t('agent.legend2'),
    ...(checks.cycles.length > 0 ? [`${t('agent.cycles')}: ${checks.cycles.join(', ')}`] : []),
    ...(checks.isolated.length > 0
      ? [`${t('agent.isolated')}: ${checks.isolated.join(', ')}`]
      : []),
    ...(checks.dangling.length > 0
      ? [`${t('agent.danglingList')}: ${checks.dangling.join(', ')}`]
      : []),
    ...(checks.shared && checks.shared.missing.length > 0
      ? [
          `${t('agent.missingList', { column: checks.shared.column })}: ${checks.shared.missing.join(', ')}`,
        ]
      : []),
  ].join('\n');

  return (
    <main
      className="agent-view"
      data-ready={shot ? 'true' : 'false'}
      data-zoom={drawn ? drawn.zoom.toFixed(3) : undefined}
      data-width={shot?.width}
      data-height={shot?.height}
    >
      <header className="agent-header" ref={headerRef}>
        <div className="agent-line">
          <span>
            <b className="agent-file">{state.schema.file}</b>
            {scope.map((s) => (
              <span key={s}>{s}</span>
            ))}
            {small && <b className="agent-warn">{t('agent.small')}</b>}
          </span>
        </div>
        <div className="agent-line">
          <span>{summary}</span>
        </div>
        <div className="agent-line">
          <span>{smells}</span>
        </div>
        <div className="agent-line agent-legend">
          <span>{t('agent.legend')}</span>
        </div>
        <div className="agent-line agent-legend">
          <span>{t('agent.legend2')}</span>
        </div>
      </header>
      <div className="agent-canvas" ref={canvasRef}>
        {drawn ? (
          <div
            className="agent-scene"
            style={{
              width: drawn.scene.width * drawn.zoom,
              height: drawn.scene.height * drawn.zoom,
            }}
          >
            <div
              className="agent-scene-inner"
              style={{
                width: drawn.scene.width,
                height: drawn.scene.height,
                transform: `scale(${drawn.zoom})`,
              }}
            >
              <svg
                className="agent-lines"
                width={drawn.scene.width}
                height={drawn.scene.height}
                aria-hidden="true"
              >
                {drawn.scene.stubs.map((st) => (
                  <g key={`${st.table}.${st.column}`} className="is-stub">
                    <polyline
                      points={st.points.map((p) => p.join(',')).join(' ')}
                      fill="none"
                      stroke="var(--fgColor-muted)"
                      strokeDasharray="3 4"
                    />
                    <path d={arrowAt(st.points)} fill="var(--fgColor-muted)" />
                  </g>
                ))}
                {drawn.scene.lines.map((l) => {
                  const fk = byKey.get(l.key);
                  const color = colors.get(l.key);
                  const flagged = l.label !== null;
                  const stroke =
                    flagged || color === undefined ? 'var(--fgColor-danger)' : agentColor(color);
                  return (
                    <g key={l.key} className={flagged ? 'is-flagged' : undefined}>
                      <polyline
                        points={l.points.map((p) => p.join(',')).join(' ')}
                        fill="none"
                        stroke={stroke}
                        strokeDasharray={fk?.cardinality.identifying ? undefined : '7 5'}
                      />
                      <path d={arrowAt(l.points)} fill={stroke} />
                    </g>
                  );
                })}
              </svg>
              {drawn.scene.stubs.map((st) => (
                <span
                  key={`${st.table}.${st.column}`}
                  className="astub"
                  style={{
                    left: st.box.x,
                    top: st.box.y,
                    width: st.box.width,
                    height: st.box.height,
                  }}
                >
                  {t('agent.stub', { column: `${st.table}.${st.column}` })}
                </span>
              ))}
              {drawn.scene.lines.map((l) =>
                l.label ? (
                  <span
                    key={l.key}
                    className="alabel"
                    style={{
                      left: l.label.x,
                      top: l.label.y,
                      width: l.label.width,
                      height: l.label.height,
                    }}
                  >
                    {reasons.find(([key]) => key === l.key)?.[1]}
                  </span>
                ) : null,
              )}
              {tables.map((x) => {
                const b = drawn.scene.boxes[x.name];
                const c = counts.get(x.name) ?? { parents: 0, children: 0 };
                if (!b) return null;
                return (
                  <section
                    key={x.name}
                    className="agent-place"
                    style={{ left: b.x, top: b.y, width: b.width, height: b.height }}
                    aria-label={`${x.name}: ${t('agent.counts', c)}`}
                  >
                    {box(x.name)}
                  </section>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="agent-measure" ref={measureRef} aria-hidden="true">
            {tables.map((x) => (
              <div key={x.name} data-table={x.name}>
                {box(x.name)}
              </div>
            ))}
            {stubs.map((st) => (
              <span key={`${st.table}.${st.column}`} className="astub" data-stub="">
                {t('agent.stub', { column: `${st.table}.${st.column}` })}
              </span>
            ))}
            {reasons.map(([key, text]) => (
              <span key={key} className="alabel" data-label="">
                {text}
              </span>
            ))}
          </div>
        )}
      </div>
      <pre className="agent-text">{text}</pre>
    </main>
  );
}

export function AgentView() {
  const [state, setState] = useState<ServerState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // One read, no live updates: the picture is of the file as it is now.
    fetch('/api/state')
      .then((r) => r.json() as Promise<ServerState>)
      .then((s) => {
        const lang = params.get('lang');
        if (lang === 'en' || lang === 'ja') setLangHere(lang);
        else applyDefault(s.ui.lang);
        setState(s);
      })
      .catch(() => setFailed(true));
  }, []);
  if (!state)
    return <div className="splash">{failed ? t('app.offline') : t('app.connecting')}</div>;
  return <View state={state} />;
}
