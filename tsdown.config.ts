import { defineConfig } from 'tsdown';

// The CLI is bundled into one ESM file. Vite is only imported in --dev mode,
// so it stays external and is never required at runtime.
export default defineConfig({
  entry: { cli: 'src/server/cli.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: false,
  dts: false,
  deps: { neverBundle: ['vite', '@vitejs/plugin-react'] },
});
