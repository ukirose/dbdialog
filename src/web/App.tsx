import {
  AlertIcon,
  CheckCircleIcon,
  DatabaseIcon,
  DotFillIcon,
  PlusIcon,
  QuestionIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  StopIcon,
  TableIcon,
  XIcon,
} from '@primer/octicons-react';
import { AnchoredOverlay, Button, Flash, IconButton, Select, useConfirm } from '@primer/react';
import {
  Background,
  BackgroundVariant,
  type Connection,
  ConnectionMode,
  type EdgeMouseHandler,
  MiniMap,
  type NodeMouseHandler,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnSpec, Op } from '../core/ops';
import type {
  ApiError,
  LayoutRoute,
  Notation,
  Position,
  ViewDiagnostic,
  ViewKey,
  ViewTable,
} from '../core/view';
import { saveLayout, saveNotation, saveSelection, sendOps, useServerState } from './api';
import { BoxMenu, type MenuTarget } from './diagram/BoxMenu';
import { CanvasToolbar } from './diagram/CanvasToolbar';
import { assignFkColors, fkKey, fkMuted } from './diagram/colors';
import { type DiagramActions, DiagramContext, type EditField } from './diagram/context';
import {
  type Box,
  buildEdges,
  type Emphasis,
  FkEdge,
  type FkEdgeType,
  SelfLoopEdge,
} from './diagram/edges';
import { elkLayout, type Measured } from './diagram/elkLayout';
import { autoLayout, nodeSize, placeNew, rowCenter } from './diagram/geometry';
import { Markers } from './diagram/Markers';
import { NewTableNode, type NewTableNodeType } from './diagram/NewTableNode';
import { TableNode, type TableNodeType } from './diagram/TableNode';
import { inferForeignKey } from './fkInference';
import { applyDefault, chooseLang, getLang, type Lang, t } from './i18n';
import { TypeOptions } from './panel/controls';
import { Help, Overview } from './panel/Overview';
import { TablePanel } from './panel/TablePanel';
import { Search } from './Search';
import type { Hit } from './schemaSearch';
import { TipLayer } from './Tip';
import { valueFlow } from './valueFlow';

const nodeTypes = { table: TableNode, newTable: NewTableNode };
const edgeTypes = { fk: FkEdge, selfLoop: SelfLoopEdge };
const FIT = { padding: 0.15, duration: 300 };
/** The id of the box of a table being written; no table name can contain U+0000. */
const NEW_TABLE = '\u0000new table';
type AnyNode = TableNodeType | NewTableNodeType;

/** What the pointer is over: a table, one foreign key's lines, or a key listed in a box. */
type Hover =
  | { kind: 'table'; name: string }
  | { kind: 'fk'; table: string; fkId: string }
  | { kind: 'key'; table: string; key: ViewKey }
  | null;

interface Toast {
  text: string;
  tone: 'error' | 'info';
  action?: { label: string; run: () => void };
}

const SIDEBAR_KEY = 'dbdialog.sidebarWidth';
const SIDEBAR_DEFAULT = 380;

function storedSidebarWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_KEY));
    return Number.isFinite(n) && n >= 280 ? n : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT; // storage can be unavailable; the default still works
  }
}

/** Whether the sidebar is open; the browser remembers it, like the width. */
const SIDEBAR_OPEN_KEY = 'dbdialog.sidebarOpen';

function storedSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

const lower = (s: string) => s.toLowerCase();
const KEY_HIGHLIGHT: Record<string, string> = {
  primary: 'var(--bgColor-attention-muted)',
  unique: 'var(--bgColor-done-muted)',
};
const INTEGER = /^(tiny|small|medium|big)?int(eger)?\b/i;

/** A box as the page drew it (its rows included), or an estimate when it is not drawn. */
function measure(tbl: ViewTable, showComments: boolean): Measured {
  const el = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(tbl.name)}"] .tnode`,
  );
  if (el && el.offsetWidth > 0) {
    const rows: Record<string, number> = {};
    for (const r of el.querySelectorAll<HTMLElement>('.trow[data-column]')) {
      // offsetTop counts from inside the 1px border; positions count from outside it.
      rows[r.dataset.column ?? ''] = 1 + r.offsetTop + r.offsetHeight / 2;
    }
    return { width: el.offsetWidth, height: el.offsetHeight, rows };
  }
  const size = nodeSize(tbl, showComments);
  return {
    ...size,
    rows: Object.fromEntries(tbl.columns.map((c) => [c.name, rowCenter(tbl, c.name)])),
  };
}

function diagText(d: ViewDiagnostic): string {
  return t(`diag.${d.code}`, d.params);
}

function errorText(e: ApiError): string {
  if (e.code === 'conflict' || e.code === 'not-found' || e.code === 'network')
    return t(`error.${e.code}`);
  if (e.code === 'invalid' || e.code === 'referenced' || e.code === 'exists')
    return t(`error.${e.code}`, { message: e.message });
  return t('error.other', { message: e.message });
}

function Diagram() {
  const { state, connection, setState } = useServerState();
  const confirmDialog = useConfirm();
  const [lang, setLangState] = useState<Lang>(getLang());
  const uiLang = state?.ui?.lang;
  // The server says which language to start in (dbdialog --lang); a choice made
  // in this browser's top bar wins.
  useEffect(() => {
    if (uiLang) setLangState(applyDefault(uiLang));
  }, [uiLang]);
  const [selected, setSelected] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [focusFk, setFocusFk] = useState<{ table: string; fkId: string } | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState<{
    table: string;
    field: EditField;
    column: string | null;
  } | null>(null);
  const [colDraft, setColDraft] = useState<{ table: string; after: string | null } | null>(null);
  const [picking, setPicking] = useState<{
    table: string;
    kind: 'unique' | 'index';
    columns: string[];
  } | null>(null);
  const [newTableAt, setNewTableAt] = useState<Position | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const [widths, setWidths] = useState<Record<string, number | null>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const [showComments, setShowComments] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [sidebarOpen, setSidebarOpen] = useState(storedSidebarOpen);
  const setSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open);
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
    } catch {
      // Not remembered; it still applies to this page.
    }
  }, []);
  const [nodes, setNodes, onNodesChange] = useNodesState<AnyNode>([]);
  const flow = useReactFlow<AnyNode, FkEdgeType>();
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  /** A schema opened with no saved layout gets the automatic layout once. */
  const firstLayout = useRef<'pending' | 'auto' | 'done'>('pending');
  /** Lines just routed by the automatic layout, until the server's layout has them. */
  const [localRoutes, setLocalRoutes] = useState<Record<string, LayoutRoute> | null>(null);
  /** Where tables written from the diagram go, until the server's layout has them. */
  const pendingPos = useRef<Record<string, Position>>({});
  const altDown = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);
  const tables = useMemo(() => state?.schema.tables ?? [], [state]);
  const colors = useMemo(() => assignFkColors(tables), [tables]);

  useEffect(() => {
    if (state) document.title = `DBdialog — ${state.schema.file}`;
  }, [state]);

  // Forget what points at a table that is gone.
  useEffect(() => {
    const has = (name: string) => tables.some((x) => x.name === name);
    if (selected && !has(selected)) setSelected(null);
    if (focusFk && !has(focusFk.table)) setFocusFk(null);
    if (colDraft && !has(colDraft.table)) setColDraft(null);
    if (picking && !has(picking.table)) setPicking(null);
  }, [tables, selected, focusFk, colDraft, picking]);

  // Alt (Option) while dropping a line: a foreign key of that one column only.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      altDown.current = e.altKey;
    };
    const reset = () => {
      altDown.current = false;
    };
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', reset);
    };
  }, []);

  const run = useCallback(
    async function runOps(ops: Op[], cascade?: Op[]): Promise<boolean> {
      const r = await sendOps(ops);
      if (r.ok) {
        setState(r.state);
        return true;
      }
      if (
        r.error.code === 'referenced' &&
        cascade &&
        (await confirmDialog({
          title: t('cascade.title'),
          content: t('cascade.confirm', { message: r.error.message }),
          confirmButtonContent: t('cascade.ok'),
          confirmButtonType: 'danger',
        }))
      ) {
        return runOps(cascade);
      }
      setToast({ text: errorText(r.error), tone: 'error' });
      return false;
    },
    [setState, confirmDialog],
  );

  const widthOf = useCallback(
    (name: string): number | null =>
      name in widths ? (widths[name] ?? null) : (state?.layout.tables[name]?.w ?? null),
    [widths, state],
  );

  // The foreign key being pointed at: a hovered line wins over the chosen one.
  const pointed = hover?.kind === 'fk' ? hover : focusFk;

  // The selection, for the agent the user talks to (dbdialog hook): a table, a
  // column of it, or one of its foreign keys.
  const selectedFk = focusFk && focusFk.table === selected ? focusFk.fkId : null;
  const sentSelection = useRef(false);
  useEffect(() => {
    // A page just opened has nothing selected: it leaves another page's selection alone.
    if (!sentSelection.current && !selected) return;
    sentSelection.current = true;
    saveSelection(
      selected ? { table: selected, column: selectedFk ? null : chosen, fkId: selectedFk } : null,
    );
  }, [selected, chosen, selectedFk]);

  const serverRoutes = state?.layout.routes;
  useEffect(() => {
    if (serverRoutes) setLocalRoutes(null);
  }, [serverRoutes]);
  const routes = localRoutes ?? serverRoutes ?? null;

  // IE or IDEF1X, kept in the layout file; a switch shows at once, before the server answers.
  const [pickedNotation, setPickedNotation] = useState<Notation | null>(null);
  const serverNotation = state?.layout.notation ?? 'ie';
  useEffect(() => {
    if (pickedNotation === serverNotation) setPickedNotation(null);
  }, [pickedNotation, serverNotation]);
  const notation = pickedNotation ?? serverNotation;
  const changeNotation = useCallback(
    async (n: Notation) => {
      setPickedNotation(n);
      const saved = await saveNotation(n);
      if (saved) setState(saved);
    },
    [setState],
  );

  // The chosen column's values, followed through foreign keys across tables.
  const flowOf = useMemo(
    () => (selected && chosen ? valueFlow(tables, selected, chosen) : null),
    [tables, selected, chosen],
  );
  const flowTables = useMemo(() => new Set(flowOf?.columns.map((c) => c.table)), [flowOf]);

  // While the pointer is over a table or a line, everything unrelated to it fades.
  // A chosen column's flow is not undone by pointing at a table (the pointer is
  // usually still on the box just clicked); pointing at a line still is.
  const spot = useMemo(() => {
    if (!hover || hover.kind === 'key' || connecting) return null;
    if (flowOf && hover.kind === 'table') return null;
    const names = new Set<string>();
    const fks = new Set<string>();
    for (const x of tables) {
      for (const fk of x.foreignKeys) {
        const on =
          hover.kind === 'table'
            ? x.name === hover.name || fk.refTable === hover.name
            : x.name === hover.table && fk.id === hover.fkId;
        if (!on) continue;
        fks.add(fkKey(x.name, fk.id));
        names.add(x.name);
        names.add(fk.refTable);
      }
    }
    if (hover.kind === 'table') names.add(hover.name);
    return { names, fks };
  }, [hover, connecting, tables, flowOf]);

  // Turn the server state into boxes, keeping the positions the boxes already have.
  useEffect(() => {
    if (!state) return;
    const problems: Record<string, number> = {};
    for (const d of state.schema.diagnostics) {
      if (d.table && d.severity !== 'info') problems[d.table] = (problems[d.table] ?? 0) + 1;
    }
    const fkColorsOf = (name: string): Record<string, number[]> => {
      const out: Record<string, number[]> = {};
      const x = tables.find((u) => u.name === name);
      for (const fk of x?.foreignKeys ?? []) {
        const color = colors.get(fkKey(name, fk.id));
        if (color === undefined) continue;
        for (const c of fk.columns) out[lower(c)] = [...(out[lower(c)] ?? []), color];
      }
      return out;
    };
    const highlight = (name: string): Record<string, string> => {
      const out: Record<string, string> = {};
      if (hover?.kind === 'key') {
        if (hover.table === name) {
          const bg = KEY_HIGHLIGHT[hover.key.kind] ?? 'var(--bgColor-neutral-muted)';
          for (const c of hover.key.columns) out[lower(c)] = bg;
        }
        return out;
      }
      if (flowOf) {
        for (const c of flowOf.columns)
          if (c.table === name) out[lower(c.column)] = 'var(--bgColor-accent-muted)';
      }
      if (!pointed) return out;
      const owner = tables.find((x) => x.name === pointed.table);
      const fk = owner?.foreignKeys.find((f) => f.id === pointed.fkId);
      if (!fk) return out;
      const color = colors.get(fkKey(pointed.table, fk.id));
      const bg = color === undefined ? 'var(--bgColor-danger-muted)' : fkMuted(color);
      if (name === pointed.table) for (const c of fk.columns) out[lower(c)] = bg;
      if (name === fk.refTable) for (const c of fk.refColumns) out[lower(c)] = bg;
      return out;
    };
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const boxes = prev.filter((n) => n.id !== NEW_TABLE);
      const known: Record<string, Position> = Object.fromEntries(
        boxes.map((n) => [n.id, n.position]),
      );
      const gone = boxes.filter((n) => !tables.some((x) => x.name === n.id));
      const added = tables.filter((x) => !prevById.has(x.name));
      // A table renamed in the file keeps its place.
      if (gone.length === 1 && added.length === 1 && boxes.length > 0) {
        known[(added[0] as ViewTable).name] = (gone[0] as AnyNode).position;
      }
      let placed: Record<string, Position> = {};
      for (const x of tables) {
        const p = known[x.name] ?? pendingPos.current[x.name] ?? state.layout.tables[x.name];
        if (p) placed[x.name] = { x: p.x, y: p.y };
      }
      if (Object.keys(placed).length === 0) {
        placed = autoLayout(tables, showComments);
        if (firstLayout.current === 'pending' && tables.length > 0) firstLayout.current = 'auto';
      } else if (Object.keys(placed).length < tables.length)
        placed = placeNew(tables, placed, showComments);
      const out: AnyNode[] = tables.map(
        (x) =>
          ({
            ...(prevById.get(x.name) ?? {}),
            id: x.name,
            type: 'table',
            position: placed[x.name] ?? { x: 0, y: 0 },
            data: {
              table: x,
              notation,
              fkColors: fkColorsOf(x.name),
              highlight: highlight(x.name),
              // The table being worked on never fades; a hover spot comes before the flow.
              dim:
                x.name !== selected &&
                (spot ? !spot.names.has(x.name) : flowOf ? !flowTables.has(x.name) : false),
              problems: problems[x.name] ?? 0,
              showComments,
              lang,
              width: widthOf(x.name),
              editing:
                editing?.table === x.name ? { field: editing.field, column: editing.column } : null,
              draft: colDraft?.table === x.name ? { after: colDraft.after } : null,
              picking:
                picking?.table === x.name ? { kind: picking.kind, columns: picking.columns } : null,
              chosen: selected === x.name ? chosen : null,
            },
            selected: x.name === selected,
          }) as TableNodeType,
      );
      if (newTableAt) {
        const p = prevById.get(NEW_TABLE);
        out.push({
          ...(p ?? {}),
          id: NEW_TABLE,
          type: 'newTable',
          position: p?.position ?? newTableAt,
          data: { lang },
          selected: false,
        } as NewTableNodeType);
      }
      return out;
    });
  }, [
    state,
    tables,
    colors,
    selected,
    chosen,
    pointed,
    hover,
    spot,
    flowOf,
    flowTables,
    showComments,
    lang,
    notation,
    widthOf,
    editing,
    colDraft,
    picking,
    newTableAt,
    setNodes,
  ]);

  const layoutInputs = useRef({ tables, showComments });
  layoutInputs.current = { tables, showComments };
  /** The automatic layout (ELK): moves every box and routes the lines around them. */
  const layoutNow = useCallback(async () => {
    const { tables: all, showComments: comments } = layoutInputs.current;
    if (all.length === 0) return;
    try {
      const { positions, routes: next } = await elkLayout(all, (x) => measure(x, comments));
      setNodes((prev) => prev.map((n) => ({ ...n, position: positions[n.id] ?? n.position })));
      setLocalRoutes(next);
      const saved = await saveLayout(positions, next);
      if (saved) setState(saved);
    } catch {
      // ELK could not run: the simple layered layout still puts every box somewhere sensible.
      const auto = autoLayout(all, comments);
      setNodes((prev) => prev.map((n) => ({ ...n, position: auto[n.id] ?? n.position })));
      saveLayout(auto);
    }
  }, [setNodes, setState]);

  useEffect(() => {
    if (fitted.current || nodes.length === 0) return;
    fitted.current = true;
    const showAll = () =>
      setTimeout(() => {
        flow.fitView({ padding: 0.15 });
        setReady(true);
      }, 60);
    // Opened with no saved layout: lay it out properly once the boxes are measured.
    if (firstLayout.current === 'auto') setTimeout(() => layoutNow().finally(showAll), 80);
    else showAll();
    firstLayout.current = 'done';
  }, [nodes.length, flow, layoutNow]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.action ? 10000 : 7000);
    return () => clearTimeout(id);
  }, [toast]);

  // Where each box is and how big the browser drew it: lines leave from the facing side.
  const boxes = useMemo(() => {
    const out: Record<string, Box> = {};
    for (const n of nodes) {
      if (n.type !== 'table') continue;
      const guess = nodeSize(n.data.table, showComments);
      out[n.id] = {
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width ?? guess.width,
        height: n.measured?.height ?? guess.height,
      };
    }
    return out;
  }, [nodes, showComments]);
  const emphasis = useMemo<Emphasis>(
    () => ({
      active: new Set(pointed ? [fkKey(pointed.table, pointed.fkId)] : []),
      raised: new Set(focusFk ? [fkKey(focusFk.table, focusFk.fkId)] : []),
      spot: spot?.fks ?? null,
      near: selected,
      flow: flowOf?.edges ?? null,
    }),
    [pointed, focusFk, spot, selected, flowOf],
  );
  // Rebuilt on a language change too: the label of an ignored REFERENCES is translated.
  const edges = useMemo(
    () => (lang ? buildEdges(tables, boxes, colors, emphasis, routes, notation) : []),
    [tables, boxes, colors, emphasis, routes, notation, lang],
  );

  // The boxes call back through one stable object; it reads the latest state from here.
  const latest = useRef({ tables, showComments, picking, run, flow, newTableAt });
  latest.current = { tables, showComments, picking, run, flow, newTableAt };

  const actions = useMemo<DiagramActions>(() => {
    const now = () => latest.current;
    const toFullSize = (table: string) => {
      const f = now().flow;
      if (f.getZoom() < 0.9)
        f.fitView({ nodes: [{ id: table }], minZoom: 1, maxZoom: 1, duration: 200 });
    };
    /** The editable cells of a box in Tab order: left to right, top to bottom. */
    const cellsOf = (tbl: ViewTable): [EditField, string | null][] => {
      const order: EditField[] = now().showComments
        ? ['name', 'comment', 'type']
        : ['name', 'type'];
      return [
        ['table-name', null],
        ['table-comment', null],
        ...tbl.columns.flatMap((c) => order.map((f) => [f, c.name] as [EditField, string])),
      ];
    };
    return {
      edit(table, field, column = null) {
        toFullSize(table);
        setSelected(table);
        setEditing({ table, field, column });
      },
      finishEdit(table, field, column, value, move) {
        const { tables: all, run: send } = now();
        const tbl = all.find((x) => x.name === table);
        if (!tbl) {
          setEditing(null);
          return;
        }
        const c = column ? tbl.columns.find((x) => x.name === column) : undefined;
        let nextTable = table;
        let renamed: string | null = null;
        if (value !== null) {
          const v = field === 'comment' || field === 'table-comment' ? value : value.trim();
          if (field === 'table-name' && v && v !== tbl.name) {
            nextTable = v;
            send([{ op: 'table.rename', table, to: v }]).then((ok) => ok && setSelected(v));
          } else if (field === 'table-comment' && v !== (tbl.comment ?? '')) {
            send([
              {
                op: 'table.setComment',
                table,
                comment: v === '' ? null : v,
                expect: tbl.comment,
              },
            ]);
          } else if (c && field === 'name' && v && v !== c.name) {
            renamed = v;
            send([
              {
                op: 'column.update',
                table,
                column: c.name,
                set: { name: v },
                expect: { name: c.name },
              },
            ]);
          } else if (c && field === 'type' && v && v !== c.type) {
            send([
              {
                op: 'column.update',
                table,
                column: c.name,
                set: { type: v },
                expect: { type: c.type },
              },
            ]);
          } else if (c && field === 'comment' && v !== (c.comment ?? '')) {
            send([
              {
                op: 'column.update',
                table,
                column: c.name,
                set: { comment: v === '' ? null : v },
                expect: { comment: c.comment },
              },
            ]);
          }
        }
        if (value === null || move === 0) {
          setEditing(null);
          return;
        }
        const cells = cellsOf(tbl);
        const next = cells[cells.findIndex(([f, col]) => f === field && col === column) + move];
        if (!next) {
          setEditing(null);
          return;
        }
        // Tab after renaming a column goes on in the same row, under its new name.
        const nextColumn = renamed && next[1] === column ? renamed : next[1];
        setEditing({ table: nextTable, field: next[0], column: nextColumn });
      },
      openMenu(anchor, table, column) {
        menuAnchor.current = anchor;
        setMenu({ table, column });
      },
      openColumnDraft(table, after) {
        toFullSize(table);
        setSelected(table);
        setColDraft({ table, after });
      },
      async addColumn(table, after, v) {
        const column: ColumnSpec = {
          name: v.name.trim(),
          type: v.type.trim(),
          nullable: v.nullable,
          comment: v.comment.trim() === '' ? null : v.comment,
        };
        const ok = await now().run([{ op: 'column.add', table, column, after }]);
        // Inserting below a column: the next one goes below the one just written.
        if (ok && after !== null) setColDraft({ table, after: column.name });
        return ok;
      },
      closeColumnDraft() {
        setColDraft(null);
      },
      startPick(table, kind) {
        setSelected(table);
        setPicking({ table, kind, columns: [] });
      },
      togglePick(table, column) {
        setPicking((p) =>
          p && p.table === table
            ? {
                ...p,
                columns: p.columns.includes(column)
                  ? p.columns.filter((x) => x !== column)
                  : [...p.columns, column],
              }
            : p,
        );
      },
      finishPick(create) {
        const p = now().picking;
        setPicking(null);
        if (create && p && p.columns.length > 0)
          now().run([
            { op: 'key.add', table: p.table, kind: p.kind, columns: p.columns, name: null },
          ]);
      },
      hoverKey(table, key) {
        setHover(key ? { kind: 'key', table, key } : null);
      },
      deleteKey(table, key) {
        now().run([{ op: 'key.delete', table, target: { id: key.id, text: key.text } }]);
      },
      setWidth(table, width) {
        setWidths((w) => ({ ...w, [table]: width }));
        const n = now().flow.getNode(table);
        if (n) saveLayout({ [table]: { x: n.position.x, y: n.position.y, w: width ?? 0 } });
      },
      async createTable(name, comment, columns) {
        const pk = columns.filter((c) => c.primaryKey).map((c) => c.name.trim());
        const key = columns.find((c) => c.primaryKey);
        // One integer primary key: a surrogate key, numbered by MySQL.
        const auto = pk.length === 1 && key !== undefined && INTEGER.test(key.type.trim());
        const specs: ColumnSpec[] = columns.map((c) => ({
          name: c.name.trim(),
          type: c.type.trim(),
          nullable: c.primaryKey ? false : c.nullable,
          autoIncrement: auto && c.primaryKey,
          comment: c.comment.trim() === '' ? null : c.comment,
        }));
        const at = now().flow.getNode(NEW_TABLE)?.position ?? now().newTableAt ?? { x: 0, y: 0 };
        const ok = await now().run([
          {
            op: 'table.add',
            name,
            comment: comment.trim() === '' ? null : comment,
            columns: specs,
            primaryKey: pk,
          },
        ]);
        if (ok) {
          pendingPos.current[name] = at;
          saveLayout({ [name]: { x: at.x, y: at.y } });
          setNewTableAt(null);
          setSelected(name);
        }
        return ok;
      },
      cancelNewTable() {
        setNewTableAt(null);
      },
      zoom() {
        return now().flow.getZoom();
      },
    };
  }, []);

  const onConnect = useCallback(
    async (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      const all = latest.current.tables;
      const r = inferForeignKey(
        all,
        { table: c.source, column: c.sourceHandle.slice(2) },
        { table: c.target, column: c.targetHandle.slice(2) },
        altDown.current,
      );
      if (!r.ok) {
        if (r.reason === 'exists') setToast({ text: t('fk.exists'), tone: 'info' });
        return;
      }
      const before = new Set(
        all.find((x) => x.name === r.table)?.foreignKeys.map((f) => `${f.id}\u0000${f.text}`),
      );
      const res = await sendOps([{ op: 'fk.add', table: r.table, fk: r.fk }]);
      if (!res.ok) {
        setToast({ text: errorText(res.error), tone: 'error' });
        return;
      }
      setState(res.state);
      const made = res.state.schema.tables
        .find((x) => x.name === r.table)
        ?.foreignKeys.find((f) => !before.has(`${f.id}\u0000${f.text}`));
      setSelected(r.table);
      setChosen(null);
      setFocusFk(made ? { table: r.table, fkId: made.id } : null);
      setToast({
        text: t('fk.created', {
          fk: `${r.table} (${r.fk.columns.join(', ')}) → ${r.fk.refTable} (${r.fk.refColumns.join(', ')})`,
        }),
        tone: 'info',
        action: made
          ? {
              label: t('common.undo'),
              run: () => {
                setFocusFk(null);
                latest.current.run([
                  { op: 'fk.delete', table: r.table, target: { id: made.id, text: made.text } },
                ]);
              },
            }
          : undefined,
      });
    },
    [setState],
  );

  const select = useCallback((name: string | null, column: string | null = null) => {
    setSelected(name);
    setChosen(column);
    setFocusFk(null);
  }, []);
  const onNodeClick: NodeMouseHandler<AnyNode> = useCallback(
    (e, node) => {
      if (node.type !== 'table') return;
      const col = (e.target as HTMLElement).closest('.trow')?.getAttribute('data-column') ?? null;
      const p = latest.current.picking;
      if (p && p.table === node.id) {
        if (col) actions.togglePick(node.id, col);
        return;
      }
      select(node.id, col);
    },
    [actions, select],
  );
  const onEdgeClick: EdgeMouseHandler<FkEdgeType> = useCallback((_e, edge) => {
    if (!edge.data) return;
    setSelected(edge.data.table);
    setChosen(null);
    setFocusFk({ table: edge.data.table, fkId: edge.data.fk.id });
  }, []);
  const onNodeDragStop: OnNodeDrag<AnyNode> = useCallback((_e, _node, moved) => {
    const boxes = moved.filter((n) => n.type === 'table');
    if (boxes.length) saveLayout(Object.fromEntries(boxes.map((n) => [n.id, n.position])));
  }, []);

  const goTo = (table: string) =>
    flow.fitView({ nodes: [{ id: table }], duration: 300, maxZoom: 1.2, padding: 0.6 });

  const relayout = async () => {
    const ok = await confirmDialog({
      title: t('toolbar.relayout'),
      content: t('toolbar.relayoutConfirm'),
      confirmButtonContent: t('toolbar.relayout'),
    });
    if (!ok) return;
    await layoutNow();
    setTimeout(() => flow.fitView(FIT), 60);
  };

  const addTable = () => {
    if (!newTableAt) {
      const r = canvas.current?.getBoundingClientRect();
      const at = r
        ? flow.screenToFlowPosition({ x: r.left + r.width / 2 - 180, y: r.top + r.height / 4 })
        : { x: 0, y: 0 };
      select(null);
      setNewTableAt(at);
    }
    setTimeout(() => {
      if (flow.getZoom() < 0.9)
        flow.fitView({ nodes: [{ id: NEW_TABLE }], minZoom: 1, maxZoom: 1, duration: 200 });
    }, 60);
  };

  const deleteTable = async (name: string) => {
    const ok = await confirmDialog({
      title: t('table.delete'),
      content: t('table.deleteConfirm', { table: name }),
      confirmButtonContent: t('common.delete'),
      confirmButtonType: 'danger',
    });
    if (!ok) return;
    const op: Op = { op: 'table.delete', table: name };
    run([op], [{ ...op, cascade: true }]);
  };

  const onPick = (hit: Hit) => {
    select(hit.table, hit.column);
    goTo(hit.table);
  };

  const onJump = (d: ViewDiagnostic) => {
    if (!d.table) return;
    const tbl = tables.find((x) => x.name === d.table);
    const col = typeof d.params.column === 'string' ? d.params.column : null;
    select(d.table, tbl?.columns.find((c) => lower(c.name) === lower(col ?? ''))?.name ?? null);
    goTo(d.table);
  };

  const onSidebarResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = sidebarWidth;
    let w = startW;
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.round(
        Math.min(Math.max(280, startW + (startX - ev.clientX)), window.innerWidth * 0.7),
      );
      setSidebarWidth(w);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(SIDEBAR_KEY, String(w));
      } catch {
        // Not remembered; it still applies to this page.
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  if (!state) {
    return (
      <div className="splash">
        {connection === 'closed' ? t('app.offline') : t('app.connecting')}
      </div>
    );
  }
  const selectedTable = tables.find((x) => x.name === selected) ?? null;
  const problemCount = state.schema.diagnostics.filter((d) => d.severity !== 'info').length;
  const errorCount = state.schema.diagnostics.filter((d) => d.severity === 'error').length;
  const fileName = state.schema.file.split(/[\\/]/).pop();

  return (
    <DiagramContext.Provider value={actions}>
      <div className="app" data-lang={lang} data-fitted={ready ? 'true' : 'false'}>
        <TypeOptions />
        <header className="appbar">
          <span className="appbar-brand">
            <DatabaseIcon size={20} />
            DBdialog
          </span>
          <span className="appbar-file" data-tip={state.schema.file}>
            {fileName}
          </span>
          <span className="appbar-meta">{t('toolbar.tables', { n: tables.length })}</span>
          <span className={`sync is-${connection}`}>
            <DotFillIcon size={16} className="sync-dot" />
            {connection === 'open' ? t('toolbar.live') : t('toolbar.disconnected')}
          </span>
          <Search tables={tables} onPick={onPick} />
          <span className="spacer" />
          <Button
            size="small"
            variant="invisible"
            className={`problems${errorCount > 0 ? ' has-errors' : problemCount > 0 ? ' has-warnings' : ''}`}
            leadingVisual={problemCount > 0 ? AlertIcon : CheckCircleIcon}
            onClick={() => select(null)}
          >
            {t('toolbar.problems', { n: problemCount })}
          </Button>
          <AnchoredOverlay
            open={helpOpen}
            onOpen={() => setHelpOpen(true)}
            onClose={() => setHelpOpen(false)}
            width="large"
            align="end"
            renderAnchor={(p) => (
              <IconButton
                {...p}
                icon={QuestionIcon}
                aria-label={t('toolbar.help')}
                size="small"
                variant="invisible"
              />
            )}
          >
            <Help notation={notation} />
          </AnchoredOverlay>
          <Button size="small" leadingVisual={PlusIcon} onClick={addTable}>
            {t('toolbar.addTable')}
          </Button>
          <Select
            size="small"
            aria-label="language"
            value={lang}
            onChange={(e) => {
              chooseLang(e.target.value as Lang);
              setLangState(e.target.value as Lang);
            }}
          >
            <Select.Option value="en">English</Select.Option>
            <Select.Option value="ja">日本語</Select.Option>
          </Select>
          <IconButton
            icon={sidebarOpen ? SidebarCollapseIcon : SidebarExpandIcon}
            aria-label={t(sidebarOpen ? 'panel.close' : 'panel.open')}
            aria-expanded={sidebarOpen}
            aria-controls="dbdialog-panel"
            size="small"
            variant="invisible"
            onClick={() => setSidebar(!sidebarOpen)}
          />
        </header>
        {state.missing && (
          <Flash full variant="warning" className="banner">
            <AlertIcon />
            {t('app.missing', { file: state.schema.file })}
          </Flash>
        )}
        <main className="main">
          <div ref={canvas} className={`canvas${connecting ? ' is-connecting' : ''}`}>
            <Markers />
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onConnect={onConnect}
              onConnectStart={() => setConnecting(true)}
              onConnectEnd={() => setConnecting(false)}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={() => select(null)}
              onNodeDragStop={onNodeDragStop}
              onNodeMouseEnter={(_e, n) =>
                n.type === 'table' && setHover({ kind: 'table', name: n.id })
              }
              onNodeMouseLeave={() => setHover(null)}
              onEdgeMouseEnter={(_e, e) =>
                e.data && setHover({ kind: 'fk', table: e.data.table, fkId: e.data.fk.id })
              }
              onEdgeMouseLeave={() => setHover(null)}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={24}
              zoomOnDoubleClick={false}
              deleteKeyCode={null}
              minZoom={0.1}
              maxZoom={2}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
              <MiniMap
                pannable
                zoomable
                position="bottom-left"
                style={{ width: 160, height: 104 }}
              />
            </ReactFlow>
            {tables.length === 0 && !newTableAt && (
              <div className="empty">
                <TableIcon size={24} />
                <h2>{t('empty.title')}</h2>
                <p>{t('empty.body')}</p>
                <Button variant="primary" leadingVisual={PlusIcon} onClick={addTable}>
                  {t('toolbar.addTable')}
                </Button>
              </div>
            )}
            <CanvasToolbar
              showComments={showComments}
              onToggleComments={() => setShowComments((v) => !v)}
              onFit={() => flow.fitView(FIT)}
              onRelayout={relayout}
              notation={notation}
              onNotation={changeNotation}
            />
          </div>
          <aside
            id="dbdialog-panel"
            className="panel"
            style={{ width: sidebarWidth }}
            hidden={!sidebarOpen}
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle for the mouse; double-click puts the default width back */}
            <div
              className="panel-resizer"
              data-tip={t('panel.resize')}
              onPointerDown={onSidebarResize}
              onDoubleClick={() => {
                setSidebarWidth(SIDEBAR_DEFAULT);
                try {
                  localStorage.removeItem(SIDEBAR_KEY);
                } catch {
                  // Nothing remembered to forget.
                }
              }}
            />
            <div className="panel-scroll">
              {selectedTable ? (
                <TablePanel
                  key={selectedTable.name}
                  table={selectedTable}
                  tables={tables}
                  colors={colors}
                  diagnostics={state.schema.diagnostics}
                  run={run}
                  column={chosen}
                  onChooseColumn={setChosen}
                  flow={flowOf}
                  focusFk={focusFk?.table === selectedTable.name ? focusFk.fkId : null}
                  onFocusFk={(id) =>
                    setFocusFk(id ? { table: selectedTable.name, fkId: id } : null)
                  }
                  onHoverFk={(id) =>
                    setHover(id ? { kind: 'fk', table: selectedTable.name, fkId: id } : null)
                  }
                  onClose={() => select(null)}
                  onDelete={() => deleteTable(selectedTable.name)}
                  diagText={diagText}
                />
              ) : (
                <Overview schema={state.schema} diagText={diagText} onJump={onJump} />
              )}
            </div>
          </aside>
        </main>
        <BoxMenu
          target={menu}
          anchor={menuAnchor}
          tables={tables}
          width={menu ? widthOf(menu.table) : null}
          onClose={() => setMenu(null)}
          run={run}
          confirm={(title, content) =>
            confirmDialog({
              title,
              content,
              confirmButtonContent: t('common.delete'),
              confirmButtonType: 'danger',
            })
          }
          edit={actions.edit}
          addColumn={actions.openColumnDraft}
          details={(table, column) => {
            select(table, column);
            // Asked for the details: the sidebar is where they are.
            setSidebar(true);
          }}
          startPick={actions.startPick}
          setWidth={actions.setWidth}
        />
        {toast && (
          <div
            className={`toast is-${toast.tone}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            {toast.tone === 'error' ? (
              <StopIcon size={16} className="toast-icon" />
            ) : (
              <CheckCircleIcon size={16} className="toast-icon" />
            )}
            <span className="toast-text">{toast.text}</span>
            {toast.action && (
              <Button
                size="small"
                className="toast-action"
                onClick={() => {
                  toast.action?.run();
                  setToast(null);
                }}
              >
                {toast.action.label}
              </Button>
            )}
            <IconButton
              icon={XIcon}
              aria-label={t('common.close')}
              size="small"
              variant="invisible"
              className="toast-close"
              onClick={() => setToast(null)}
            />
          </div>
        )}
        <TipLayer />
      </div>
    </DiagramContext.Provider>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Diagram />
    </ReactFlowProvider>
  );
}
