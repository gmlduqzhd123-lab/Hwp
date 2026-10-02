import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { makeHancomPackage } from '../tests/helpers/hancom-package.ts';

const target = new URL(process.env.PAGES_URL ?? '');
const commit = process.env.EXPECTED_COMMIT ?? '';
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('EXPECTED_COMMIT must be the full deployed commit SHA.');
if (target.username || target.password || target.search || target.hash
  || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname)))) {
  throw new Error('PAGES_URL must be an HTTPS site URL or a loopback HTTP test URL, without credentials, query or hash.');
}
if (!target.pathname.endsWith('/')) target.pathname += '/';
const fixture = await readFile(new URL('../tests/fixtures/01-plain-text.hwpx', import.meta.url));
const replacement = await readFile(new URL('../tests/fixtures/03-spine-order.hwpx', import.meta.url));
const hancom = Buffer.from(makeHancomPackage(fixture));
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
});

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  const failedAssets = [];
  const failedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failedAssets.push({ url: response.url(), status: response.status() });
  });
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  // Pages CDN propagation can briefly serve the preceding build after deployment.
  // Require the actual revision before assessing the app; a stale site cannot pass.
  let current = false;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    errors.length = 0;
    failedAssets.length = 0;
    failedRequests.length = 0;
    if (attempt === 0) await page.goto(new URL('#/start', target).href, { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await expect(page.locator('[data-build-commit]')).toHaveAttribute('data-build-commit', commit, { timeout: 5000 });
      current = true;
      break;
    } catch {
      if (attempt < 17) await delay(2000);
    }
  }
  assert.ok(current, 'The public site did not serve the expected commit after propagation checks.');
  await page.waitForLoadState('load');
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await expect(page.getByLabel('HWPX 파일 선택', { exact: true })).toBeEnabled();

  const requests = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: '예시 문서로 체험' }).click();
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
  await expect(page.getByText('예시 문서', { exact: true })).toBeVisible();
  await expect(page.getByText('5.1.0.0', { exact: true })).toBeVisible();
  const requested = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const download = await requested;
  assert.match(download.suggestedFilename(), /_원본사본\.hwpx$/);
  const path = await download.path();
  assert.ok(path, 'The public app did not produce a downloadable file.');
  assert.deepEqual(await readFile(path), fixture, 'Downloaded demo bytes changed.');

  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({
    name: '배포검증_합성.hwpx', mimeType: 'application/hwp+zip', buffer: replacement,
  });
  await expect(page.getByRole('heading', { name: '배포검증_합성.hwpx' })).toBeVisible();
  await expect(page.locator('.report-grid > div').filter({ has: page.locator('dt', { hasText: '선언된 구역' }) }).locator('dd')).toHaveText(/^3개$/);
  const replacedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const replacedPath = await (await replacedDownload).path();
  assert.ok(replacedPath, 'The offline replacement did not produce a downloadable file.');
  assert.deepEqual(await readFile(replacedPath), replacement, 'Offline replacement download did not match the new input.');

  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({
    name: '한컴구조_합성.hwpx', mimeType: 'application/hwp+zip', buffer: hancom,
  });
  await expect(page.getByRole('heading', { name: '한컴구조_합성.hwpx' })).toBeVisible();
  await expect(page.getByText('5.1.1.0', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const hancomDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const hancomPath = await (await hancomDownload).path();
  assert.ok(hancomPath, 'The documented Hancom structure did not produce a downloadable file.');
  assert.deepEqual(await readFile(hancomPath), hancom, 'Documented Hancom structure download changed the input.');
  assert.deepEqual(requests, [], 'A prepared app requested HTTP resources while processing documents offline.');
  await context.setOffline(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/start$/);
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '원본 그대로 내려받기' })).toHaveCount(0);
  await page.goto(new URL('#/help', target).href);
  await expect(page.getByRole('heading', { name: '지원 범위와 처리 방식' })).toBeVisible();
  await expect(page.locator('[data-build-commit]')).toHaveAttribute('data-build-commit', commit);
  assert.deepEqual(errors, [], 'Public app threw browser errors.');
  assert.deepEqual(failedAssets, [], 'Public app failed to load deployed assets.');
  assert.deepEqual(failedRequests, [], 'Public app resource requests failed.');
  console.log(JSON.stringify({
    url: target.href, commit, worker: 'ready', example: 'real inspection',
    download: 'byte-identical', offlineRestart: 'passed', hashRefresh: 'passed', assetErrors: 0,
    hancomStructure: 'passed offline with inert metadata',
  }));
} finally {
  await browser.close();
}
