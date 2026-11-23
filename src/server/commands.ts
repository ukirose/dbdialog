// The commands for agents and CI: `dbdialog lint` and `dbdialog mermaid`.
// They print the same diagnostics the diagram shows, in English.

import { lint, parseSchema, positionOf, toMermaid } from '../core/index';
import type { Severity } from '../core/model';
import { en, type Message } from '../locales/en';

export interface CommandResult {
  output: string;
  exitCode: number;
}

export interface LintEntry {
  line: number;
  column: number;
  severity: Severity;
  code: string;
  table: string | null;
  message: string;
}

const messages: Record<string, Message> = en;

function wording(code: string, params: Record<string, string | number>): string {
  const m = messages[`diag.${code}`];
  if (m === undefined) return code;
  return typeof m === 'function' ? m(params) : m;
}

export function lintEntries(src: string): LintEntry[] {
  const schema = parseSchema(src);
  return [...schema.diagnostics, ...lint(schema)]
    .map((d) => ({
      ...positionOf(src, d.span.start),
      severity: d.severity,
      code: d.code,
      table: d.table,
      message: wording(d.code, d.params),
    }))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Exit code 1 when there is an error or a warning; notes (info) never fail. */
export function lintCommand(file: string, src: string, json: boolean): CommandResult {
  const entries = lintEntries(src);
  const count = (s: Severity) => entries.filter((e) => e.severity === s).length;
  const errors = count('error');
  const warnings = count('warning');
  const exitCode = errors + warnings > 0 ? 1 : 0;
  if (json) {
    const body = { file, errors, warnings, notes: count('info'), diagnostics: entries };
    return { output: `${JSON.stringify(body, null, 2)}\n`, exitCode };
  }
  const lines = entries.map(
    (e) => `${file}:${e.line}:${e.column}  ${e.severity.padEnd(7)}  ${e.code}  ${e.message}`,
  );
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  lines.push(
    errors + warnings === 0
      ? 'No problems.'
      : `${plural(errors, 'error')}, ${plural(warnings, 'warning')}.`,
  );
  return { output: `${lines.join('\n')}\n`, exitCode };
}

export function mermaidCommand(src: string): CommandResult {
  return { output: toMermaid(parseSchema(src)), exitCode: 0 };
}
