import { describe, expect, it } from 'vitest';
import { lint } from '../src/core/lint';
import { parseSchema } from '../src/core/parser';
import { caseSql, FK_CASES } from './fixtures/fk-cases';

const FK_RULES = [
  'fk-type-mismatch',
  'fk-blob-column',
  'fk-virtual-column',
  'fk-generated-action',
  'fk-generated-base-action',
];

describe('foreign key rules match what MySQL 8.0 does', () => {
  it.each(FK_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const found = lint(parseSchema(caseSql(c)))
      .filter((d) => FK_RULES.includes(d.code))
      .map((d) => d.code);
    if (c.lint === null) expect(found).toEqual([]);
    else expect([...new Set(found)]).toEqual([c.lint]);
    // Every rule here is a refusal by MySQL, so it is an error, never a warning.
    if (c.lint)
      expect(lint(parseSchema(caseSql(c))).find((d) => d.code === c.lint)?.severity).toBe('error');
  });

  it('says which side of a mismatch is which, and why', () => {
    const d = lint(parseSchema(caseSql(FK_CASES[0] as (typeof FK_CASES)[0]))).find(
      (x) => x.code === 'fk-type-mismatch',
    );
    expect(d?.params).toMatchObject({
      column: 'pid',
      type: 'BIGINT',
      refTable: 'p',
      refColumn: 'id',
      refType: 'BIGINT UNSIGNED',
      reason: 'sign',
    });
  });

  it('finds nothing in the fixtures, which MySQL accepts', async () => {
    const { fixture } = await import('./helpers');
    for (const name of ['library.sql', 'marketplace.sql']) {
      expect(lint(parseSchema(fixture(name))).filter((d) => FK_RULES.includes(d.code))).toEqual([]);
    }
  });
});
