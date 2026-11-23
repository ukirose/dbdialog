import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// elkjs (EPL-2.0) carries its copyright notices in comments, which minifying
// removes; they are put back at the top of its chunk. The license texts of
// everything the page bundles are in THIRD-PARTY-NOTICES.md (npm run notices).
function elkNotices(): Plugin {
  const file = createRequire(import.meta.url).resolve('elkjs/lib/elk.bundled.js');
  const comments = readFileSync(file, 'utf8').match(/\/\*[\s\S]*?\*\//g) ?? [];
  const notices = [...new Set(comments.filter((c) => c.includes('Copyright')))].join('\n');
  return {
    name: 'elk-notices',
    apply: 'build',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (
          chunk.type === 'chunk' &&
          chunk.moduleIds.some((id) => id.includes('/node_modules/elkjs/'))
        )
          chunk.code = `${notices}\n${chunk.code}`;
      }
    },
  };
}

// The browser app lives in src/web and is built into dist/web,
// which the CLI serves as static files.
export default defineConfig({
  root: 'src/web',
  plugins: [react(), elkNotices()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
