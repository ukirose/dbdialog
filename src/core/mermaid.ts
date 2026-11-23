// Mermaid erDiagram text for a schema (`dbdialog mermaid schema.sql`). Only
// what MySQL creates is drawn: inline REFERENCES, which MySQL 8.0 ignores, is
// left out. Checked against mermaid 11.12's parser: types may not contain
// spaces or commas, so BIGINT UNSIGNED becomes BIGINT_UNSIGNED and
// DECIMAL(15,2) becomes DECIMAL(15-2).

import { cardinality } from './cardinality';
import type { ColumnDef, Schema } from './model';

const lower = (s: string) => s.toLowerCase();

function entity(name: string): string {
  return /^[\p{L}\p{N}_-]+$/u.test(name) ? name : `"${name.replace(/"/g, "'")}"`;
}

function attributeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_\-()[\]]/gu, '_');
}

function attributeType(c: ColumnDef): string {
  let text = c.type.text.replace(/\s+(?:character set|charset)\s+\S+/gi, '').trim();
  // ENUM('a','b') and SET(…) keep only their name; the member list cannot be written.
  text = text.replace(/^(enum|set)\s*\(.*\)/i, '$1');
  return text
    .replace(/\s*,\s*/g, '-')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_\-()[\]]/gu, '');
}

const text = (s: string) => s.replace(/"/g, "'").replace(/\s*\n\s*/g, ' ');

export function toMermaid(schema: Schema): string {
  const lines = ['erDiagram'];
  for (const t of schema.tables) {
    const pk = new Set((t.primaryKey?.columns.parts ?? []).map((p) => lower(p.column ?? '')));
    const fk = new Set(
      t.foreignKeys
        .filter((f) => f.origin === 'table')
        .flatMap((f) => f.columns.parts.map((p) => lower(p.column ?? ''))),
    );
    const uk = new Set(
      t.keys
        .filter((k) => k.kind === 'unique')
        .flatMap((k) => k.columns.parts.map((p) => lower(p.column ?? ''))),
    );
    lines.push(`  ${entity(t.name)} {`);
    for (const c of t.columns) {
      const name = lower(c.name);
      const keys = [pk.has(name) && 'PK', fk.has(name) && 'FK', uk.has(name) && 'UK']
        .filter(Boolean)
        .join(', ');
      const comment = c.comment ? ` "${text(c.comment.value)}"` : '';
      lines.push(
        `    ${attributeType(c)} ${attributeName(c.name)}${keys ? ` ${keys}` : ''}${comment}`,
      );
    }
    lines.push('  }');
  }
  for (const t of schema.tables) {
    for (const f of t.foreignKeys) {
      if (f.origin !== 'table') continue;
      const k = cardinality(t, f);
      const parentEnd = k.parent === 'one' ? '||' : '|o';
      const childEnd = k.child === 'zeroOrOne' ? 'o|' : 'o{';
      const label = f.constraintName?.name ?? f.columns.parts.map((p) => p.column).join(', ');
      lines.push(
        `  ${entity(f.ref.table.name)} ${parentEnd}${k.identifying ? '--' : '..'}${childEnd} ${entity(t.name)} : "${text(label)}"`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
