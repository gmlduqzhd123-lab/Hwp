import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const workspaces: string[] = [];
const csp = "default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39;; img-src &#39;self&#39; blob: data:; font-src &#39;self&#39;; worker-src &#39;self&#39; blob:; connect-src &#39;none&#39;; object-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;";

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), 'hwp-build-contract-'));
  workspaces.push(path);
  await mkdir(join(path, 'dist/assets'), { recursive: true });
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({
    private: true,
    dependencies: { react: '19.3.0', 'react-dom': '19.3.0', '@zip.js/zip.js': '2.22.0', saxes: '6.0.0' },
  }));
  await writeFile(join(path, 'src/main.ts'), 'export const ready = true;\n');
  await writeFile(join(path, 'index.html'), '<html><script type="module" src="/src/main.ts"></script></html>');
  await writeFile(join(path, 'dist/index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><script type="module" src="/Hwp/assets/index-abcdef12.js"></script><link rel="stylesheet" href="/Hwp/assets/index-abcdef12.css"></head></html>`);
  await writeFile(join(path, 'dist/assets/index-abcdef12.js'), 'const namespace = "http://www.hancom.co.kr/hwpml/2011/section";\nconsole.info(namespace);\n');
  await writeFile(join(path, 'dist/assets/index-abcdef12.css'), 'body { color: #123; }\n');
  await writeFile(join(path, 'dist/assets/document.worker-abcdef12.js'), 'self.onmessage = () => self.postMessage({ ready: true });\n');
  await writeFile(join(path, 'dist/THIRD_PARTY_NOTICES.txt'), 'License source: https://github.com/example/license\n');
  return path;
}

function check(path: string, script: string, environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [join(repository, 'scripts', script)], {
    cwd: path,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  return result;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('the public artifact checks enforce the runtime contract', () => {
  it('accepts local bundles, XML namespace strings, and informational license links', async () => {
    const result = check(await workspace(), 'check-dist.mjs');
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts the app favicon with a comma-delimited SVG data URL', async () => {
    const path = await workspace();
    const html = await readFile(join(path, 'dist/index.html'), 'utf8');
    await writeFile(join(path, 'dist/index.html'), html.replace('</head>', '<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E"></head>'));
    const result = check(path, 'check-dist.mjs');
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a script loaded from any external host', async () => {
    const path = await workspace();
    const html = await readFile(join(path, 'dist/index.html'), 'utf8');
    await writeFile(join(path, 'dist/index.html'), html.replace('</head>', '<script src="https://static.example.invalid/remote.js"></script></head>'));
    expect(check(path, 'check-dist.mjs').status).not.toBe(0);
  });

  it('rejects an external stylesheet import from any host', async () => {
    const path = await workspace();
    await writeFile(join(path, 'dist/assets/index-abcdef12.css'), '@import url("https://static.example.invalid/theme.css");');
    expect(check(path, 'check-dist.mjs').status).not.toBe(0);
  });

  it.each(['https&#58;//static.example.invalid/remote.js', 'https&colon;//static.example.invalid/remote.js'])
    ('rejects HTML-encoded external script resources (%s)', async (resource) => {
      const path = await workspace();
      const html = await readFile(join(path, 'dist/index.html'), 'utf8');
      await writeFile(join(path, 'dist/index.html'), html.replace('</head>', `<script src="${resource}"></script></head>`));
      expect(check(path, 'check-dist.mjs').status).not.toBe(0);
    });

  it('rejects a CSS-escaped external image resource', async () => {
    const path = await workspace();
    await writeFile(join(path, 'dist/assets/index-abcdef12.css'), 'body { background-image: url("https\\3a //static.example.invalid/image.png"); }');
    expect(check(path, 'check-dist.mjs').status).not.toBe(0);
  });

  it.each([
    'import("https://static.example.invalid/runtime.js")',
    'fetch("https://static.example.invalid/document")',
    'fetch(`https://static.example.invalid/document`)',
    'import("https\\u003a//static.example.invalid/runtime.js")',
  ])('rejects literal remote runtime requests and imports (%s)', async (source) => {
    const path = await workspace();
    await writeFile(join(path, 'dist/assets/index-abcdef12.js'), `${source};\n`);
    expect(check(path, 'check-dist.mjs').status).not.toBe(0);
  });

  it('rejects credential-shaped values in a public text artifact', async () => {
    const path = await workspace();
    await writeFile(join(path, 'dist/THIRD_PARTY_NOTICES.txt'), `Synthetic leakage canary: sk-${'Q'.repeat(28)}`);
    expect(check(path, 'check-dist.mjs').status).not.toBe(0);
  });

  it('rejects a broad script policy even when network connections are blocked', async () => {
    const path = await workspace();
    const html = await readFile(join(path, 'dist/index.html'), 'utf8');
    await writeFile(join(path, 'dist/index.html'), html.replace('script-src &#39;self&#39;', 'script-src * &#39;unsafe-inline&#39;'));
    expect(check(path, 'check-dist.mjs').status).not.toBe(0);
  });

  it('rejects arbitrary public HWPX files that are not the reviewed bundled demo', async () => {
    const path = await workspace();
    await writeFile(join(path, 'dist/private-document.hwpx'), 'synthetic unintended document publication');
    expect(check(path, 'check-dist.mjs').status).not.toBe(0);
  });
});

describe('the source constraint check includes the app entry', () => {
  it('accepts the local source entry', async () => {
    const result = check(await workspace(), 'check-constraints.mjs');
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a remote script introduced through root index.html', async () => {
    const path = await workspace();
    await writeFile(join(path, 'index.html'), '<html><script src="https://static.example.invalid/runtime.js"></script></html>');
    expect(check(path, 'check-constraints.mjs').status).not.toBe(0);
  });
});

it.each([0, 7])('checking a nested Pages path preserves the existing default build and retains failure status %i', async (e2eStatus) => {
  const path = await workspace();
  const original = await readFile(join(path, 'dist/index.html'), 'utf8');
  const bin = join(path, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[1] === 'build') {
  const outIndex = args.indexOf('--outDir');
  const output = outIndex >= 0 ? args[outIndex + 1] : 'dist';
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'index.html'), process.env.PAGES_BASE_PATH === '/nested/hwp-check/'
    ? 'rebuilt for ' + process.env.PAGES_BASE_PATH : ${JSON.stringify(original)});
}
if (args[1] === 'test:e2e') process.exit(${e2eStatus});
`, { mode: 0o755 });
  const result = check(path, 'check-pages-path.mjs', { PATH: `${bin}:${process.env.PATH}` });
  expect(result.status, result.stderr).toBe(e2eStatus);
  expect(await readFile(join(path, 'dist/index.html'), 'utf8')).toBe(original);
});
