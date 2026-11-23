// Regenerates docs/screenshot.png from test/fixtures/marketplace.sql with the
// installed Chrome. Run `npm run build` first.
//
//   npx tsx scripts/screenshot.ts

import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = join(mkdtempSync(join(tmpdir(), 'dbdialog-shot-')), 'schema.sql');
copyFileSync(join(root, 'test/fixtures/marketplace.sql'), file);
const port = 4420;
const server = spawn(process.execPath, [join(root, 'dist/cli.mjs'), file, '--port', String(port)], {
  stdio: 'ignore',
});

try {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 760 },
    colorScheme: 'light',
    deviceScaleFactor: 2,
  });
  await page.addInitScript(() => localStorage.setItem('dbdialog.lang', 'en'));
  for (let i = 0; i < 50; i++) {
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await page.locator('.app[data-fitted="true"]').waitFor();
  await page.locator('.react-flow__node[data-id="purchases"] .thead-name').click();
  const fk = page.locator('.item-summary', { hasText: '→ sellers' });
  await fk.click();
  // The whole schema fits at about 40%, too small to read at the README's
  // width: two steps closer keep purchases and the tables around it.
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(250);
  }
  await fk.scrollIntoViewIfNeeded();
  // Leave the pointer on empty canvas: pointing at something fades the rest.
  await page.mouse.move(10, 750);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(root, 'docs/screenshot.png') });
  await browser.close();
  process.stdout.write('wrote docs/screenshot.png\n');
} finally {
  server.kill();
}
