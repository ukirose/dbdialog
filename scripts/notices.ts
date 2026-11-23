// Writes THIRD-PARTY-NOTICES.md: the npm packages the page (dist/web) bundles,
// read from the source maps of a build, with the text of each one's license.
// The CLI (dist/cli.mjs) bundles none: the server uses Node.js built-ins only.
//
//   npm run notices              # rewrites the file
//   npm run notices -- --check   # exits with 1 when the file is out of date

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'THIRD-PARTY-NOTICES.md');

const MIT = (copyright: string) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Packages published without a license file: the copyright line of the
// LICENSE in their repository, which is the MIT License above.
const MIT_WITHOUT_FILE: Record<string, string> = {
  // https://github.com/primer/react/blob/main/LICENSE
  '@primer/react': 'Copyright (c) 2018 GitHub, Inc.',
  // https://github.com/primer/live-region-element/blob/main/LICENSE
  '@primer/live-region-element': 'Copyright (c) 2024 GitHub, Inc.',
};

// What a license asks to be said besides its text.
const NOTES: Record<string, (version: string) => string> = {
  elkjs: (version) =>
    `DBdialog uses elkjs, unmodified, under the EPL-2.0 (it is also available under GPL-3.0-or-later). Its source code is at https://github.com/kieler/elkjs and in the npm package \`elkjs@${version}\`. \`dist/web/assets/elk.bundled-*.js\` is that package's \`lib/elk.bundled.js\`, minified, with its copyright notices kept at the top.`,
};

interface Package {
  name: string;
  version: string;
  license: string;
  source: string;
  text: string;
}

/** The directories of the packages in the page's bundle. */
async function bundledPackages(): Promise<Set<string>> {
  const out = mkdtempSync(join(tmpdir(), 'dbdialog-notices-'));
  try {
    await build({
      configFile: join(root, 'vite.config.ts'),
      root: join(root, 'src/web'),
      logLevel: 'error',
      build: { outDir: out, emptyOutDir: true, sourcemap: true },
    });
    const dirs = new Set<string>();
    const assets = join(out, 'assets');
    for (const name of readdirSync(assets).filter((f) => f.endsWith('.map'))) {
      const map = JSON.parse(readFileSync(join(assets, name), 'utf8')) as { sources: string[] };
      for (const source of map.sources) {
        // The last node_modules: a nested copy is a package of its own.
        const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(resolve(assets, source));
        if (m?.[1]) dirs.add(m[1]);
      }
    }
    // Stylesheets imported from packages have no source map.
    const web = join(root, 'src/web');
    for (const file of readdirSync(web, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(file)) continue;
      const css = /^import '((?:@[^/']+\/)?[^./'][^/']*)\/[^']*\.css';$/gm;
      for (const m of readFileSync(join(web, file), 'utf8').matchAll(css)) {
        dirs.add(join(root, 'node_modules', m[1] as string));
      }
    }
    return dirs;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function describe(dir: string): Package {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string | { type: string };
    repository?: string | { url: string };
  };
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? '');
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  const source = repo
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1')
    .replace(/\.git$/, '');
  const file = readdirSync(dir).find((f) =>
    /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f),
  );
  const fallback = MIT_WITHOUT_FILE[pkg.name];
  let text: string;
  if (file) text = readFileSync(join(dir, file), 'utf8');
  else if (fallback) text = MIT(fallback);
  else throw new Error(`${pkg.name}: no license file; add its text to MIT_WITHOUT_FILE`);
  return {
    name: pkg.name,
    version: pkg.version,
    license,
    source,
    text: text.replace(/\r\n/g, '\n').trim(),
  };
}

function table(rows: string[][]): string {
  const widths = (rows[0] as string[]).map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  const [head, ...body] = rows as [string[], ...string[][]];
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const packages = [...(await bundledPackages())]
  .map(describe)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const text = `# Third-party notices

The page in \`dist/web\`, which the CLI serves, bundles the open-source packages below; the CLI itself (\`dist/cli.mjs\`) bundles none. Each package is used under its own license, whose text follows. This file is written by \`npm run notices\` from the source maps of a build.

${table([
  ['Package', 'Version', 'License', 'Source'],
  ...packages.map((p) => [p.name, p.version, p.license, p.source]),
])}
${packages
  .map((p) => {
    const note = NOTES[p.name]?.(p.version);
    return `\n## ${p.name} ${p.version}\n\n${note ? `${note}\n\n` : ''}${fenced(p.text)}\n`;
  })
  .join('')}`;

if (process.argv.includes('--check')) {
  const now = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (now !== text) {
    process.stderr.write('THIRD-PARTY-NOTICES.md is out of date: run `npm run notices`.\n');
    process.exit(1);
  }
  process.stdout.write(`THIRD-PARTY-NOTICES.md is up to date (${packages.length} packages).\n`);
} else {
  writeFileSync(target, text);
  process.stdout.write(`wrote THIRD-PARTY-NOTICES.md (${packages.length} packages)\n`);
}
