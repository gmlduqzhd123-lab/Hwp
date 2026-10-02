import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const basePath = '/nested/hwp-check/';
const backup = await mkdtemp(join(tmpdir(), 'hwp-pages-build-'));
const previous = await lstat('dist').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) {
  await rm(backup, { recursive: true, force: true });
  throw new Error('Expected dist to be a regular build directory.');
}
if (previous) await cp('dist', join(backup, 'dist'), { recursive: true });
let status = 0;
try {
  for (const args of [['run', 'build'], ['run', 'check:dist'], ['run', 'test:e2e']]) {
    const result = spawnSync('npm', args, {
      stdio: 'inherit',
      env: { ...process.env, PAGES_BASE_PATH: basePath, E2E_BASE_PATH: basePath },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) { status = result.status ?? 1; break; }
  }
} finally {
  try {
    await rm('dist', { recursive: true, force: true });
    if (previous) await cp(join(backup, 'dist'), 'dist', { recursive: true });
    else {
      const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env: process.env });
      if (result.error) throw result.error;
      if (result.status !== 0) status ||= result.status ?? 1;
    }
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}
process.exitCode = status;
