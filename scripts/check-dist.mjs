import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { credentialPattern, inspectResources, requireProductionPolicy } from './runtime-checks.mjs';

const files = [];
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${path}`);
    if (entry.isDirectory()) await inspect(path);
    else {
      const publicPath = relative('dist', path).replace(/\\/g, '/');
      // The reviewed demo is inlined into the app bundle; no standalone documents are public.
      if (!/^(?:index\.html|THIRD_PARTY_NOTICES\.txt|manifest\.webmanifest|icons\/(?:icon-192|icon-512|icon-maskable-512|apple-touch-icon)\.png|assets\/(?:index|document\.worker)-[A-Za-z0-9_-]+\.(?:js|css))$/.test(publicPath)) {
        throw new Error(`Unexpected public file: ${path}`);
      }
      if (/(?:\.env|package-lock|README|PRD|ACCEPTANCE|TASKS|AGENTS|test-results|golden)/i.test(path)) {
        throw new Error(`Development artifact in dist: ${path}`);
      }
      const text = await readFile(path, 'utf8');
      if (credentialPattern.test(text) || /sourceMappingURL/.test(text)) {
        throw new Error(`Source map or credential-shaped value in dist: ${path}`);
      }
      inspectResources(text, extname(path), path);
      files.push(path);
    }
  }
}
await inspect('dist');
const html = await readFile('dist/index.html', 'utf8');
if (!/<script[^>]+type="module"/.test(html)) throw new Error('Missing built module entry.');
requireProductionPolicy(html);
if (!files.some((path) => /document\.worker.*\.js$/.test(path))) throw new Error('Missing bundled document Worker.');
console.log(`Static dist checked: ${files.length} files, bundled Worker, no source maps or development documents.`);
