import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineConfig } from '@playwright/test';

// The server edits a copy of the fixture. Workers read the config again, so
// the path is created once and handed down through the environment.
if (!process.env.DBDIALOG_E2E_FILE) {
  const file = join(mkdtempSync(join(tmpdir(), 'dbdialog-e2e-')), 'schema.sql');
  copyFileSync('test/fixtures/library.sql', file);
  process.env.DBDIALOG_E2E_FILE = file;
}
const PORT = 4399;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The installed Chrome: no browser download is needed.
    channel: 'chrome',
    viewport: { width: 1600, height: 1000 },
  },
  webServer: {
    command: `node dist/cli.mjs "${process.env.DBDIALOG_E2E_FILE}" --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/state`,
    reuseExistingServer: false,
    // The test server announces itself next to its file, not in ~/.dbdialog.
    env: { DBDIALOG_HOME: join(dirname(process.env.DBDIALOG_E2E_FILE), '.dbdialog') },
  },
});
