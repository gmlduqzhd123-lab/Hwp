import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';

function buildCommit(): string {
  const configured = process.env.VITE_APP_COMMIT;
  if (configured !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(configured)) throw new Error('VITE_APP_COMMIT must be a full commit SHA.');
    return configured;
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'development';
  }
}

export default defineConfig(({ command, isPreview }) => {
  const base = process.env.PAGES_BASE_PATH ?? (command === 'build' || isPreview ? '/Hwp/' : '/');
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
    throw new Error('PAGES_BASE_PATH must be / or a slash-delimited project path.');
  }
  return {
    base,
    define: { __BUILD_COMMIT__: JSON.stringify(buildCommit()) },
    plugins: [react(), {
      name: 'production-csp',
      apply: 'build',
      transformIndexHtml: () => [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:; manifest-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        },
        injectTo: 'head-prepend',
      }],
    }],
    build: { sourcemap: false },
  };
});
