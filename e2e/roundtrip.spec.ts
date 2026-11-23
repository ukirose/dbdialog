import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const file = process.env.DBDIALOG_E2E_FILE as string;
const original = readFileSync('test/fixtures/library.sql', 'utf8');
const read = () => readFileSync(file, 'utf8');

test.beforeEach(async ({ page }) => {
  // Every test starts from the fixture, whatever the previous one wrote, in IE.
  if (read() !== original) writeFileSync(file, original);
  await page.request.put('/api/layout', {
    headers: { 'X-Dbdialog': '1' },
    data: { notation: 'ie' },
  });
  await expect
    .poll(async () => {
      const state = await (await page.request.get('/api/state')).json();
      const tables = state.schema.tables as { sql: string }[];
      return tables.length === 7 && tables.every((t) => original.includes(t.sql));
    })
    .toBe(true);
  await page.goto('/');
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  // The first "fit view" moves every box; measure handles only after it.
  await expect(page.locator('.app[data-fitted="true"]')).toBeVisible();
});

const node = (page: Page, name: string) => page.locator(`.react-flow__node[data-id="${name}"]`);

async function drag(page: Page, from: string, fromHandle: string, to: string, toHandle: string) {
  const a = await node(page, from).locator(`[data-handleid="${fromHandle}"]`).boundingBox();
  const b = await node(page, to).locator(`[data-handleid="${toHandle}"]`).boundingBox();
  if (!a || !b) throw new Error('handle not found');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test('a comment typed in place rewrites only that part of schema.sql', async ({ page }) => {
  const before = read();
  const row = node(page, 'loans').locator('.trow[data-column="status"]');
  await row.locator('.cell-name').dblclick();
  await expect(row.locator('.cell-name .cell-input')).toBeFocused();
  // Tab goes from the name to the comment of the same row.
  await row.locator('.cell-name .cell-input').press('Tab');
  const comment = row.locator('.cell-comment .cell-input');
  await expect(comment).toBeFocused();
  await comment.fill('Stage of the loan');
  await comment.press('Enter');
  await expect
    .poll(read)
    .toBe(
      before.replace(
        "status             VARCHAR(6) NOT NULL DEFAULT 'new',",
        "status             VARCHAR(6) NOT NULL DEFAULT 'new' COMMENT 'Stage of the loan',",
      ),
    );
});

test('an edit made to the file shows up in the diagram without a reload', async ({ page }) => {
  writeFileSync(
    file,
    read().replace(
      '  name VARCHAR(100) NOT NULL,\n  PRIMARY KEY (ID)',
      '  name VARCHAR(100) NOT NULL,\n  created_at DATETIME NULL,\n  PRIMARY KEY (ID)',
    ),
  );
  await expect(node(page, 'tenants')).toContainText('created_at');
});

test('a line drawn from a column to the column it references writes the foreign key at once', async ({
  page,
}) => {
  const before = read();
  await drag(page, 'member_codes', 'r:tenant_id', 'tenants', 'l:ID');
  await expect
    .poll(read)
    .toBe(
      before.replace(
        '  UNIQUE KEY (tenant_id, code, alive)\n);',
        '  UNIQUE KEY (tenant_id, code, alive),\n  FOREIGN KEY (tenant_id) REFERENCES tenants (ID)\n);',
      ),
    );
  await expect(page.getByRole('status')).toContainText('tenants (ID)');
});

test('a line to one column of a composite key completes it by name, and Undo takes it back', async ({
  page,
}) => {
  const memoEnd = '  loan_id   BIGINT UNSIGNED NOT NULL,\n  PRIMARY KEY (ID)\n);\n';
  writeFileSync(
    file,
    `${read()}\nCREATE TABLE loan_notes (\n  ID         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n  tenant_id BIGINT UNSIGNED NOT NULL,\n${memoEnd}`,
  );
  await expect(page.locator('.react-flow__node')).toHaveCount(8);
  await page.getByRole('button', { name: 'Fit view' }).click();
  await page.waitForTimeout(500);
  const before = read();
  // Drawn backwards, from the referenced column: the direction is still right.
  await drag(page, 'loans', 'r:ID', 'loan_notes', 'l:loan_id');
  await expect
    .poll(read)
    .toBe(
      before.replace(
        memoEnd,
        '  loan_id   BIGINT UNSIGNED NOT NULL,\n  PRIMARY KEY (ID),\n  FOREIGN KEY (tenant_id, loan_id) REFERENCES loans (tenant_id, ID)\n);\n',
      ),
    );
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(read).toBe(before);
});

test('the menu of a row switches NULL and NOT NULL', async ({ page }) => {
  const before = read();
  await node(page, 'loans').locator('.trow[data-column="fee"]').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'Allow NULL' }).click();
  await expect
    .poll(read)
    .toBe(
      before.replace(
        '  fee                DECIMAL(15,0) NULL,',
        '  fee                DECIMAL(15,0) NOT NULL,',
      ),
    );
});

test('a key of several columns is made by clicking its columns in order', async ({ page }) => {
  const before = read();
  const box = node(page, 'member_addresses');
  await box.locator('.thead-name').click();
  await box.getByRole('button', { name: 'UNIQUE' }).click();
  await box.locator('.trow[data-column="address"]').click();
  await box.locator('.trow[data-column="tenant_id"]').click();
  await expect(box.locator('.tkey.is-picking')).toContainText('address, tenant_id');
  await box.getByRole('button', { name: 'Create' }).click();
  await expect.poll(read).toContain('UNIQUE KEY (address, tenant_id)');
  expect(read().replace(/,\n {2}UNIQUE KEY \(address, tenant_id\)/, '')).toBe(before);
});

test('a new table is written on the diagram with several columns, as one CREATE TABLE', async ({
  page,
}) => {
  const before = read();
  await page.getByRole('button', { name: 'Add table' }).click();
  const box = page.locator('.tnode.is-new');
  await expect(box).toBeVisible();
  await box.getByRole('textbox', { name: 'Table name' }).fill('notes');
  const row = (i: number) => box.locator(`[data-row="${i}"]`);
  await row(1).getByRole('textbox', { name: 'Name' }).fill('body');
  await row(1).getByRole('combobox', { name: 'Type' }).fill('TEXT');
  // Enter on the last row opens the next one.
  await row(1).getByRole('combobox', { name: 'Type' }).press('Enter');
  await row(2).getByRole('textbox', { name: 'Name' }).fill('created_at');
  await row(2).getByRole('combobox', { name: 'Type' }).fill('DATETIME');
  await box.getByRole('button', { name: 'Create' }).click();
  await expect.poll(read).toContain('CREATE TABLE notes');
  const added = read().slice(before.length);
  expect(read().startsWith(before)).toBe(true);
  expect(added.match(/CREATE TABLE/g)).toHaveLength(1);
  for (const part of ['id', 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', 'body', 'TEXT NOT NULL']) {
    expect(added).toContain(part);
  }
  expect(added).toContain('created_at');
  expect(added).toContain('PRIMARY KEY (id)');
  await expect(page.locator('.react-flow__node')).toHaveCount(8);
});

test('the page starts in English and remembers a switch to Japanese', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Add table' })).toBeVisible();
  await expect(node(page, 'members').locator('.mark-fk')).toHaveAttribute(
    'data-tip',
    /^Foreign key/,
  );
  await page.getByRole('combobox', { name: 'language' }).selectOption('ja');
  await expect(page.getByRole('button', { name: '表を追加' })).toBeVisible();
  // The boxes are re-drawn in the new language too.
  await expect(node(page, 'members').locator('.mark-fk')).toHaveAttribute('data-tip', /^外部キー/);
  await page.reload();
  await expect(page.getByRole('button', { name: '表を追加' })).toBeVisible();
  await page.getByRole('combobox', { name: 'language' }).selectOption('en');
});

/** Every row of every box: one line, and nothing sticking out of the box. */
async function expectRowsFit(page: Page, atLeast: number) {
  const rows = await page.locator('.trow').evaluateAll((els) =>
    els.map((el) => {
      const row = el.getBoundingClientRect();
      // The connection dots sit on the border on purpose; only the text parts must fit.
      const parts = [...el.children].filter((c) => !c.classList.contains('react-flow__handle'));
      return {
        text: el.textContent,
        height: row.height,
        overflows: parts.some((c) => c.getBoundingClientRect().right > row.right + 0.5),
      };
    }),
  );
  expect(rows.length).toBeGreaterThan(atLeast);
  for (const r of rows) {
    expect(r, r.text ?? '').toMatchObject({ overflows: false });
    expect(r.height, r.text ?? '').toBeLessThan(30);
  }
}

test('rows never wrap: every row is one line and fits inside its box', async ({ page }) => {
  await expectRowsFit(page, 30);
});

test('rows of Japanese names and comments fit their boxes too (East Asian characters are wide)', async ({
  page,
}) => {
  writeFileSync(file, readFileSync('test/fixtures/japanese.sql', 'utf8'));
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(node(page, '作品')).toContainText('書き上がったか');
  await expectRowsFit(page, 8);
});

test('a box is as wide in a narrow window as in a wide one', async ({ page }) => {
  // The automatic layout measures the boxes: their size must not depend on the window.
  const widths = () =>
    page
      .locator('.react-flow__node .tnode')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetWidth));
  const wide = await widths();
  await page.setViewportSize({ width: 480, height: 800 });
  await page.waitForTimeout(300);
  expect(await widths()).toEqual(wide);
});

test('the cells of a box line up in columns', async ({ page }) => {
  for (const name of ['loans', 'member_addresses', 'member_codes']) {
    const lefts = await node(page, name)
      .locator('.cell-type')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size, name).toBe(1);
  }
});

test('every mark is an icon with its text', async ({ page }) => {
  const box = node(page, 'loans');
  for (const [mark, text] of [
    ['.mark-fk', 'FK'],
    ['.mark-null', 'NULL'],
    ['.mark-check', 'CHECK'],
    ['.mark-uq', 'UQ'],
  ]) {
    const first = box.locator(mark as string).first();
    await expect(first).toHaveText(text as string);
    await expect(first.locator('svg')).toHaveCount(1);
  }
});

test('keys of several columns are listed under the columns; CHECK marks the columns it uses', async ({
  page,
}) => {
  const box = node(page, 'loans');
  await expect(box.locator('.tkey')).toHaveText([/tenant_id, number/, /tenant_id, ID/]);
  await expect(box.locator('.trow[data-column="status"] .mark-check')).toHaveCount(1);
  await expect(box.locator('.trow[data-column="number"] .mark-check')).toHaveCount(0);
});

test('lines start at the rows of the key columns, one per column pair', async ({ page }) => {
  // The first point of every line leaving loans, matched to the row it sits on.
  const rows = await page.evaluate(() => {
    const box = document.querySelector('.react-flow__node[data-id="loans"]');
    if (!box) return null;
    const rowAt = (y: number) =>
      [...box.querySelectorAll('.trow')]
        .find((r) => {
          const b = r.getBoundingClientRect();
          return y >= b.top && y <= b.bottom;
        })
        ?.getAttribute('data-column') ?? '(none)';
    const out: string[] = [];
    for (const g of document.querySelectorAll('.react-flow__edge')) {
      if (!(g.getAttribute('data-testid') ?? '').startsWith('rf__edge-loans\u0000')) continue;
      const path = g.querySelector<SVGPathElement>('path.react-flow__edge-path');
      const m = path?.getScreenCTM();
      if (!path || !m) continue;
      const p = path.getPointAtLength(0);
      out.push(rowAt(new DOMPoint(p.x, p.y).matrixTransform(m).y));
    }
    return out.sort();
  });
  // (tenant_id, member_id), (tenant_id, delivery_method_id, delivery_kind), (tenant_id, member_id, address_id)
  expect(rows).toEqual(
    [
      'tenant_id',
      'tenant_id',
      'tenant_id',
      'member_id',
      'member_id',
      'delivery_method_id',
      'delivery_kind',
      'address_id',
    ].sort(),
  );
});

test('the sidebar widens to the left, and the browser remembers its width', async ({ page }) => {
  const panel = page.locator('aside.panel');
  const width = async () => Math.round((await panel.boundingBox())?.width ?? 0);
  const w0 = await width();
  const edge = await page.locator('.panel-resizer').boundingBox();
  if (!edge) throw new Error('no resize edge');
  await page.mouse.move(edge.x + 2, edge.y + 300);
  await page.mouse.down();
  await page.mouse.move(edge.x - 148, edge.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect.poll(width).toBe(w0 + 150);
  await page.reload();
  await expect.poll(width).toBe(w0 + 150);
});

test('the sidebar closes, stays closed after a reload, and opens for the details', async ({
  page,
}) => {
  const panel = page.locator('aside.panel');
  const canvasWidth = async () => (await page.locator('.canvas').boundingBox())?.width ?? 0;
  const before = await canvasWidth();
  await page.getByRole('button', { name: 'Close the sidebar' }).click();
  await expect(panel).toBeHidden();
  // The diagram takes the room.
  await expect.poll(canvasWidth).toBeGreaterThan(before + 200);
  await page.reload();
  await expect(page.locator('.app[data-fitted="true"]')).toBeVisible();
  await expect(panel).toBeHidden();
  // Asking for the details of a column opens it again.
  await node(page, 'loans').locator('.trow[data-column="status"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open details' }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close the sidebar' })).toBeVisible();
});

test('a box keeps the width it is dragged to, in the layout file', async ({ page }) => {
  const box = node(page, 'tenants');
  await box.locator('.thead-name').click();
  const grip = await box.locator('.tresize').boundingBox();
  if (!grip) throw new Error('no width grip');
  const w0 = (await box.locator('.tnode').boundingBox())?.width ?? 0;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2, { steps: 8 });
  await page.mouse.up();
  const layout = `${file}.layout.json`;
  await expect
    .poll(() =>
      existsSync(layout) ? JSON.parse(readFileSync(layout, 'utf8')).tables.tenants?.w : 0,
    )
    .toBeGreaterThan(w0);
});

/** Points along every line that fall inside a box (its border excluded), as "line in box". */
async function linesBehindBoxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((n) => ({
      name: n.getAttribute('data-id') ?? '',
      r: n.getBoundingClientRect(),
    }));
    const found = new Set<string>();
    for (const g of document.querySelectorAll('.react-flow__edge')) {
      const path = g.querySelector<SVGPathElement>('path.react-flow__edge-path');
      const m = path?.getScreenCTM();
      if (!path || !m) continue;
      const total = path.getTotalLength();
      for (let s = 0; s <= total; s += 3) {
        const p = new DOMPoint(
          path.getPointAtLength(s).x,
          path.getPointAtLength(s).y,
        ).matrixTransform(m);
        for (const b of boxes) {
          const inside =
            p.x > b.r.left + 3 && p.x < b.r.right - 3 && p.y > b.r.top + 3 && p.y < b.r.bottom - 3;
          if (inside) found.add(`${g.getAttribute('data-testid')} in ${b.name}`);
        }
      }
    }
    return [...found];
  });
}

test('the automatic layout routes every line around the boxes, and keeps it after a reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Auto layout' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Auto layout' }).click();
  const layout = `${file}.layout.json`;
  await expect
    .poll(() =>
      existsSync(layout)
        ? Object.keys(JSON.parse(readFileSync(layout, 'utf8')).routes ?? {}).length
        : 0,
    )
    .toBeGreaterThan(10);
  await page.waitForTimeout(600);
  expect(await linesBehindBoxes(page)).toEqual([]);
  await page.reload();
  await expect(page.locator('.app[data-fitted="true"]')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await linesBehindBoxes(page)).toEqual([]);
});

/** How the first line of a foreign key of `child` is drawn: dashes, ends, and IDEF1X's "Z". */
function lineOf(page: Page, child: string) {
  return page.evaluate((c) => {
    const g = [...document.querySelectorAll('.react-flow__edge')].find((e) =>
      (e.getAttribute('data-testid') ?? '').startsWith(`rf__edge-${c}\u0000`),
    );
    const path = g?.querySelector<SVGPathElement>('path.react-flow__edge-path');
    return {
      dashed: (path?.style.strokeDasharray ?? '') !== '',
      start: path?.getAttribute('marker-start')?.replace(/^url\(#dbd-(\w+)-.*$/, '$1') ?? null,
      end: path?.getAttribute('marker-end')?.replace(/^url\(#dbd-(\w+)-.*$/, '$1') ?? null,
      z: g?.querySelector('.fk-card')?.textContent ?? null,
    };
  }, child);
}

test('a box shows its primary key above a line, and the notation switches between IE and IDEF1X', async ({
  page,
}) => {
  writeFileSync(file, `${read()}\n${readFileSync('test/fixtures/orders.sql', 'utf8')}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(12);
  const items = node(page, 'order_items');
  // The key (order_id, line_no) first, in its own order, then the line.
  expect(
    await items
      .locator('.trow[data-column]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-column'))),
  ).toEqual(['order_id', 'line_no', 'quantity']);
  await expect(items.locator('.trow.is-after-key')).toHaveAttribute('data-column', 'quantity');
  await expect(node(page, 'logs').locator('.trow-nokey')).toHaveText('No primary key');
  // A dependent entity has rounded corners; its identifying relationship is solid.
  await expect(items.locator('.tnode')).toHaveClass(/is-dependent/);
  await expect(node(page, 'orders').locator('.tnode')).not.toHaveClass(/is-dependent/);
  expect(await lineOf(page, 'order_items')).toEqual({
    dashed: false,
    start: 'zeroOrMany',
    end: 'one',
    z: null,
  });
  expect(await lineOf(page, 'orders')).toMatchObject({ dashed: true, end: 'zeroOrOne' });

  await page.getByRole('button', { name: 'IDEF1X' }).click();
  expect(await lineOf(page, 'order_items')).toEqual({
    dashed: false,
    start: 'dot',
    end: null,
    z: null,
  });
  // A foreign key that may be NULL: a diamond at the parent. One note per order at most: "Z".
  expect(await lineOf(page, 'orders')).toMatchObject({
    dashed: true,
    start: 'dot',
    end: 'diamond',
  });
  expect(await lineOf(page, 'order_notes')).toMatchObject({ start: 'dot', z: 'Z' });
  await expect(items.locator('.trow[data-column="order_id"] .note-fk')).toHaveText('(FK)');
  await expect(node(page, 'customers').locator('.trow[data-column="code"] .note-ak')).toHaveText(
    '(AK1)',
  );
  await expect(node(page, 'orders').locator('.trow[data-column="customer_id"] .note-o')).toHaveText(
    '(O)',
  );
  // Kept in the layout file: the same notation after a reload.
  await expect
    .poll(() => JSON.parse(readFileSync(`${file}.layout.json`, 'utf8')).notation)
    .toBe('idef1x');
  await page.reload();
  await expect(items.locator('.trow[data-column="order_id"] .note-fk')).toHaveText('(FK)');
});

test("a line's label shows above the boxes, on a part of the line no box covers", async ({
  page,
}) => {
  await node(page, 'loan_files').locator('.thead-name').click();
  await page.locator('.item-summary', { hasText: '→ loans' }).first().click();
  await expect(page.locator('.fk-label')).toHaveText('ON DELETE CASCADE');
  const r = await page.evaluate(() => {
    const label = document.querySelector('.fk-label')?.getBoundingClientRect();
    const layer = document.querySelector('.react-flow__edgelabel-renderer');
    if (!label || !layer) return null;
    const nodes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')];
    const top = Math.max(...nodes.map((n) => Number(getComputedStyle(n).zIndex) || 0));
    const [x, y] = [label.x + label.width / 2, label.y + label.height / 2];
    return {
      above: Number(getComputedStyle(layer).zIndex) > top,
      under: nodes
        .filter((n) => {
          const b = n.getBoundingClientRect();
          return x > b.left && x < b.right && y > b.top && y < b.bottom;
        })
        .map((n) => n.dataset.id),
    };
  });
  expect(r).toEqual({ above: true, under: [] });
});

test('what is clicked on the diagram is what `dbdialog hook` tells the agent', async ({ page }) => {
  const take = async (session: string) =>
    (
      await page.request.post('/api/selection/take', {
        headers: { 'X-Dbdialog': '1' },
        data: { session },
      })
    ).json();
  await node(page, 'loans').locator('.trow[data-column="status"] .cell-name').click();
  await expect.poll(async () => (await take('e2e-1'))?.label).toBe('column status of table loans');
  // A line: its foreign key.
  await node(page, 'loan_files').locator('.thead-name').click();
  await page.locator('.item-summary', { hasText: '→ loans' }).first().click();
  await expect
    .poll(async () => (await take('e2e-2'))?.label)
    .toBe('foreign key (tenant_id, loan_id) → loans (tenant_id, ID) of table loan_files');
});

test('choosing a column lights up every line that carries its values, across tables', async ({
  page,
}) => {
  await node(page, 'loan_files').locator('.trow[data-column="tenant_id"] .cell-name').click();
  // tenants ← members, delivery_methods ← … ← loan_files: every pair of tenant columns.
  await expect(page.locator('.fk-edge.is-flow')).toHaveCount(7);
  await expect(page.locator('.flow-path')).toHaveText(
    'tenants.ID ← members.tenant_id ← loans.tenant_id ← loan_files.tenant_id',
  );
  // member_codes has a tenant_id that no foreign key joins: it fades.
  await page.mouse.move(5, 300, { steps: 4 });
  await expect(node(page, 'member_codes').locator('.tnode')).toHaveClass(/is-dim/);
  await expect(node(page, 'tenants').locator('.tnode')).not.toHaveClass(/is-dim/);
});

test('the agent view draws the graph of the tables and where its pattern breaks, says how to read it, and writes nothing', async ({
  page,
}) => {
  const layout = `${file}.layout.json`;
  const before = existsSync(layout) ? readFileSync(layout, 'utf8') : null;
  await page.goto('/?view=agent&lang=en');
  await expect(page.locator('.agent-view[data-ready="true"]')).toBeVisible();
  // Every table as a box with its name, its primary key and how many lines it has;
  // no other columns, no types.
  await expect(page.locator('.agent-place')).toHaveCount(7);
  const purchases = page.locator('.agent-place[aria-label="loans: refs 3 · referenced 1"]');
  await expect(purchases).toContainText('PK ID');
  await expect(page.locator('.agent-canvas')).not.toContainText('BIGINT');
  await expect(page.locator('.agent-canvas')).not.toContainText('fee');
  // The example table has a tenant column but no foreign key: its line runs to "?".
  await expect(page.locator('.astub')).toHaveText(['member_codes.tenant_id → ?']);
  // A line for every foreign key, nothing on anything, and how to read it.
  await expect(page.locator('.agent-lines g:not(.is-stub)')).toHaveCount(7);
  await expect(page.locator('.agent-lines g.is-stub')).toHaveCount(1);
  const header = page.locator('.agent-header');
  await expect(header).toContainText(
    '7 tables · 7 foreign keys · cycles 0 · unconnected tables 1 · overlaps 0 · lines behind boxes 0',
  );
  await expect(header).toContainText(
    'ID columns with no foreign key 1 · foreign keys without tenant_id 0 (7 of 7 foreign keys carry tenant_id)',
  );
  await expect(header).toContainText('types, NULL and constraints: read the SQL');
  // The same as text, for agents reading the page.
  await expect(page.locator('.agent-text')).toContainText('Unconnected tables: member_codes');
  expect(existsSync(layout) ? readFileSync(layout, 'utf8') : null).toBe(before);
});

test('the agent view can show one table and the tables next to it', async ({ page }) => {
  await page.goto(`/?view=agent&lang=en&focus=${encodeURIComponent('members')}`);
  await expect(page.locator('.agent-view[data-ready="true"]')).toBeVisible();
  // members references tenants; member_addresses and loans reference members.
  await expect(page.locator('.agent-place')).toHaveCount(4);
  await expect(page.locator('.agent-header')).toContainText('members and the tables next to it');
});

test('`dbdialog snapshot` saves the agent view as a PNG and prints how to read it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbdialog-snapshot-'));
  const schema = join(dir, 'schema.sql');
  copyFileSync('test/fixtures/marketplace.sql', schema);
  const out = join(dir, 'er.png');
  const r = spawnSync(
    process.execPath,
    ['dist/cli.mjs', 'snapshot', schema, '-o', out, '--lang', 'en'],
    { encoding: 'utf8' },
  );
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^dbdialog: wrote .*er\.png \(\d+ × \d+\)/);
  expect(r.stdout).toContain('Foreign keys closing a cycle: purchases → shipments');
  expect(r.stdout).toContain(
    'foreign keys without tenant_id 0 (7 of 7 foreign keys carry tenant_id)',
  );
  expect(readFileSync(out).subarray(1, 4).toString()).toBe('PNG');
  // Nothing is written next to the schema.
  expect(readdirSync(dir).sort()).toEqual(['er.png', 'schema.sql']);
});
