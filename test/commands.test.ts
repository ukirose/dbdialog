import { describe, expect, it } from 'vitest';
import { lintCommand, mermaidCommand } from '../src/server/commands';
import { fixture } from './helpers';

describe('dbdialog lint', () => {
  it('passes a clean schema with exit code 0', () => {
    const r = lintCommand('marketplace.sql', fixture('marketplace.sql'), false);
    expect(r.exitCode).toBe(0);
    // SET statements are notes, which never fail the check.
    expect(r.output.trim().split('\n').at(-1)).toBe('No problems.');
  });

  it('reports problems with file:line:column and exits with 1', () => {
    const r = lintCommand('edge-cases.sql', fixture('edge-cases.sql'), false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(
      /^edge-cases\.sql:\d+:\d+ {2}warning {2}inline-references-ignored {2}MySQL 8\.0 ignores/m,
    );
    expect(r.output.trim().split('\n').at(-1)).toMatch(/^1 error, 1 warning\.$/);
  });

  it('gives agents JSON', () => {
    const sql =
      'CREATE TABLE p (id BIGINT UNSIGNED PRIMARY KEY);\nCREATE TABLE c (pid BIGINT, FOREIGN KEY (pid) REFERENCES p (id));\n';
    const r = lintCommand('schema.sql', sql, true);
    const body = JSON.parse(r.output) as {
      errors: number;
      diagnostics: { code: string; line: number; message: string }[];
    };
    expect(r.exitCode).toBe(1);
    expect(body.errors).toBe(1);
    expect(body.diagnostics[0]).toMatchObject({ code: 'fk-type-mismatch', line: 2 });
    expect(body.diagnostics[0]?.message).toContain('differ in UNSIGNED');
  });
});

describe('dbdialog mermaid', () => {
  it('draws cardinality from the DDL', () => {
    const out = mermaidCommand(fixture('library.sql')).output;
    expect(out.startsWith('erDiagram\n')).toBe(true);
    // delivery_method_id may be NULL, so a loan has zero or one delivery method (MATCH SIMPLE).
    expect(out).toContain(
      'delivery_methods |o..o{ loans : "tenant_id, delivery_method_id, delivery_kind"',
    );
    expect(out).toContain('tenants ||..o{ members : "tenant_id"');
    // Types are rewritten to what mermaid accepts.
    expect(out).toContain('    BIGINT_UNSIGNED ID PK');
    expect(out).toContain('    DECIMAL(15-0) fee');
  });

  it('leaves out an inline REFERENCES, which creates no foreign key', () => {
    const out = mermaidCommand(fixture('edge-cases.sql')).output;
    expect(out).not.toMatch(/other .* "my table"/);
    expect(out).toContain('"my table" {');
  });
});
