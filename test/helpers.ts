import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TableDef } from '../src/core/model';
import { parseSchema } from '../src/core/parser';

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

export function table(src: string, name: string): TableDef {
  const t = parseSchema(src).tables.find((x) => x.name === name);
  if (!t) throw new Error(`table ${name} not found`);
  return t;
}

export const FIXTURES = [
  'library.sql',
  'marketplace.sql',
  'edge-cases.sql',
  'orders.sql',
  'antipatterns.sql',
  'japanese.sql',
] as const;
