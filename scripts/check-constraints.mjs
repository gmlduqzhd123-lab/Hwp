import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { credentialPattern, inspectResources } from './runtime-checks.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const allowedRuntime = new Set(['@zip.js/zip.js', 'react', 'react-dom', 'saxes']);
for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (!allowedRuntime.has(name)) throw new Error(`Unreviewed runtime dependency: ${name}`);
}
const checks = [
  [/\b(?:localStorage|sessionStorage|indexedDB|WebSocket|EventSource)\b/, 'document persistence or networking API'],
  [/navigator\.serviceWorker|dangerouslySetInnerHTML|\beval\s*\(/, 'unapproved execution API'],
  [credentialPattern, 'credential-shaped value'],
];
let files = 0;
async function inspectFile(path) {
  const text = await readFile(path, 'utf8');
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) throw new Error(`Constraint violation (${label}): ${path}`);
  }
  inspectResources(text, extname(path), path);
  files += 1;
}
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink not supported: ${path}`);
    if (entry.isDirectory()) await inspect(path);
    else await inspectFile(path);
  }
}
await inspect('src');
await inspectFile('index.html');
if ((await readdir('.')).includes('public')) await inspect('public');
for (const entry of await readdir('.')) {
  if (/^(?:vercel|netlify|firebase)\.|^supabase$/.test(entry)) {
    throw new Error(`Unsupported deployment configuration: ${entry}`);
  }
}
console.log(`Constraints checked: ${files} source files, ${allowedRuntime.size} permitted runtime dependencies.`);
