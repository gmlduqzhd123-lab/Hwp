import { test, expect, type Dialog, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { preflight } from '../../src/engine/preflight';

const fixturePath = new URL('../fixtures/01-plain-text.hwpx', import.meta.url);
const fixture = await readFile(fixturePath);

async function ready(page: Page) {
  await page.goto('./#/start');
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await expect(page.getByLabel('HWPX 파일 선택', { exact: true })).toBeEnabled();
}

async function select(page: Page, bytes: Buffer = fixture, name = '합성문서.hwpx') {
  const acceptReplacement = (dialog: Dialog) => dialog.accept();
  page.once('dialog', acceptReplacement);
  try {
    await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({
      name, mimeType: 'application/hwp+zip', buffer: bytes,
    });
  } finally {
    page.off('dialog', acceptReplacement);
  }
}

async function downloadBytes(page: Page): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/_원본사본\.hwpx$/);
  const path = await download.path();
  if (!path) throw new Error('Download did not save a file.');
  return readFile(path);
}

test('Worker inspection and saved HWPX preserve every input byte and reopen independently', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await ready(page);
  await select(page);
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '합성문서.hwpx' })).toBeVisible();
  await expect(page.getByText('5.1.0.0', { exact: true })).toBeVisible();
  const output = await downloadBytes(page);
  expect(output).toEqual(fixture);
  const report = await preflight(new Uint8Array(output), 'download.hwpx');
  expect(report.entryCount).toBe(6);
  expect(report.sectionPaths).toEqual(['Contents/section0.xml']);
  await expect(page.getByText('다운로드를 요청했습니다.', { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test('preloaded synthetic example works offline with no post-readiness requests or persistent document data', async ({ page, context }) => {
  await ready(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await context.setOffline(true);
  await page.getByRole('button', { name: '예시 문서로 체험' }).click();
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
  await expect(page.getByText('예시 문서', { exact: true })).toBeVisible();
  expect(await downloadBytes(page)).toEqual(fixture);
  const storage = await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    databases: (await indexedDB.databases()).map((database) => database.name),
    caches: await caches.keys(),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  expect(storage).toEqual({ local: [], session: [], databases: [], caches: [], serviceWorkers: 0 });
  expect(requests).toEqual([]);
});

test('wrong format and CRC damage fail safely while the previous validated original remains exportable', async ({ page }) => {
  await ready(page);
  await select(page);
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
  await select(page, Buffer.from('%PDF-1.7\nPRIVATE_SYNTHETIC_MARKER'), 'renamed.hwpx');
  await expect(page.getByRole('alert')).toContainText('FILE_UNSUPPORTED');
  expect(await downloadBytes(page)).toEqual(fixture);
  const damaged = Buffer.from(fixture);
  const offset = damaged.indexOf(Buffer.from('합성 연구 보고서'));
  expect(offset).toBeGreaterThan(0);
  damaged[offset] = (damaged[offset] ?? 0) ^ 1;
  await select(page, damaged, 'damaged.hwpx');
  await expect(page.getByRole('alert')).toContainText('FILE_INVALID_PACKAGE');
  expect(await downloadBytes(page)).toEqual(fixture);
  await select(page, fixture, '다시선택.hwpx');
  await expect(page.getByRole('heading', { name: '다시선택.hwpx' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a real DEFLATE package is inspected in the offline Worker and exported without recompression', async ({ page, context }) => {
  const entries = unzipSync(fixture);
  const mimetype = entries.mimetype;
  if (!mimetype) throw new Error('Fixture has no mimetype.');
  const compressed = Buffer.from(zipSync({ ...entries, mimetype: [mimetype, { level: 0 }] }, { level: 6 }));
  expect(compressed.byteLength).toBeLessThan(fixture.byteLength);
  await ready(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await context.setOffline(true);
  await select(page, compressed, '압축문서.hwpx');
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
  expect(await downloadBytes(page)).toEqual(compressed);
  expect(requests).toEqual([]);
});

test('oversized input is refused before processing and a valid input still works afterward', async ({ page }) => {
  await ready(page);
  await select(page, Buffer.alloc(25 * 1024 * 1024 + 1), 'large.hwpx');
  await expect(page.getByRole('alert')).toContainText('RESOURCE_LIMIT');
  await expect(page.getByRole('button', { name: '원본 그대로 내려받기' })).toHaveCount(0);
  await select(page);
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
});

test('DTD input cannot trigger external requests or script execution and the UI recovers', async ({ page }) => {
  await ready(page);
  const entries = unzipSync(fixture);
  entries['Contents/section0.xml'] = strToU8('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY ex SYSTEM "https://example.invalid/PRIVATE_SYNTHETIC_MARKER">]><x>&ex;</x>');
  const unsafe = Buffer.from(zipSync(entries, { level: 0 }));
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await select(page, unsafe, 'unsafe.hwpx');
  await expect(page.getByRole('alert')).toContainText('XML_UNSUPPORTED');
  await expect(page.getByRole('alert')).not.toContainText('PRIVATE_SYNTHETIC_MARKER');
  expect(requests).toEqual([]);
  await select(page);
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
});

test('ending or refreshing a workspace removes the document and unknown hashes recover', async ({ page }) => {
  await ready(page);
  await select(page);
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByRole('button', { name: '원본 그대로 내려받기' })).toHaveCount(0);
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await select(page);
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#\/start$/);
  await expect(page.getByRole('button', { name: '원본 그대로 내려받기' })).toHaveCount(0);
  await page.goto('./#/unknown');
  await expect(page).toHaveURL(/#\/start$/);
  await expect(page.getByText('화면 주소를 확인할 수 없어 시작 화면으로 이동했습니다.')).toBeVisible();
});

test('a failed Worker disables input and retry initializes a working inspection', async ({ page }) => {
  const workerPattern = '**/assets/document.worker-*.js';
  await page.route(workerPattern, (route) => route.abort());
  await page.goto('./#/start');
  await expect(page.getByRole('alert')).toContainText('WORKER_FAILED');
  await expect(page.getByLabel('HWPX 파일 선택', { exact: true })).toBeDisabled();
  await page.unroute(workerPattern);
  await page.getByRole('button', { name: '준비 다시 시도' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '예시 문서로 체험' }).click();
  await expect(page.getByRole('heading', { name: '파일 구조를 확인했습니다.' })).toBeVisible();
});
