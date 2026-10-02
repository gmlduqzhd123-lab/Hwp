import { test, expect, type Dialog, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const plain = await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url));
const spine = await readFile(new URL('../fixtures/03-spine-order.hwpx', import.meta.url));
const simple = await readFile(new URL('../fixtures/04-simple-table.hwpx', import.meta.url));
const complex = await readFile(new URL('../fixtures/05-unsupported-tables.hwpx', import.meta.url));
const golden = JSON.parse(await readFile(new URL('../fixtures/01-plain-text.golden.json', import.meta.url), 'utf8')) as { paragraphsInDeclaredOrder: string[] };

async function ready(page: Page) {
  await page.goto('./#/start');
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
}

async function select(page: Page, buffer: Buffer, name = '구조검증_합성.hwpx') {
  const accept = (dialog: Dialog) => dialog.accept();
  page.once('dialog', accept);
  try {
    await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({ name, mimeType: 'application/hwp+zip', buffer });
  } finally { page.off('dialog', accept); }
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('heading', { name: '문서 구조 보기', exact: true })).toBeVisible();
}

function withParagraphs(texts: string[]): Buffer {
  const entries = unzipSync(plain);
  const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  entries['Contents/section0.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8"?>'
    + '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">'
    + texts.map((text, index) => `<hp:p id="${index}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${escaped(text)}</hp:t></hp:run></hp:p>`).join('')
    + '</hs:sec>');
  return Buffer.from(zipSync(entries, { level: 0 }));
}

test('the real offline Worker shows exact paragraph text and resolved character size without changing the download', async ({ page, context }) => {
  await ready(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await context.setOffline(true);
  await select(page, plain);
  const paragraphs = page.locator('.inspector-paragraph');
  await expect(paragraphs).toHaveCount(2);
  expect(await paragraphs.locator(':scope > .inspector-text-window > .inspector-document-text').allTextContents()).toEqual(golden.paragraphsInDeclaredOrder);
  await paragraphs.first().locator('summary').click();
  await expect(paragraphs.first().getByText('11 pt', { exact: true })).toBeVisible();
  await expect(paragraphs.first().getByText('서식 참조를 찾을 수 없습니다.', { exact: true }).first()).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('No unchanged download.');
  expect(await readFile(path)).toEqual(plain);
  expect(requests).toEqual([]);
});

test('section navigation follows spine order and replacing a document resets the structure view', async ({ page }) => {
  await ready(page);
  await select(page, spine);
  const text = page.locator('.inspector-paragraph > .inspector-text-window > .inspector-document-text');
  await expect(text).toHaveText('선언 순서 첫 번째');
  await page.getByLabel('구역 선택', { exact: true }).selectOption({ index: 1 });
  await expect(text).toHaveText('선언 순서 두 번째');
  await page.getByLabel('구역 선택', { exact: true }).selectOption({ index: 2 });
  await expect(text).toHaveText('선언 순서 세 번째');
  await page.getByRole('button', { name: '표 보기', exact: true }).click();
  await select(page, plain, '교체구조_합성.hwpx');
  await expect(page.getByRole('button', { name: '문단 보기', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await text.allTextContents()).toEqual(golden.paragraphsInDeclaredOrder);
});

test('simple cells link to actual paragraphs and merged or nested tables show their read-only reasons', async ({ page }) => {
  await ready(page);
  await select(page, simple);
  await page.getByRole('button', { name: '표 보기', exact: true }).click();
  await expect(page.locator('.inspector-table')).toHaveCount(1);
  expect(await page.locator('.inspector-cell-table .inspector-document-text').allTextContents()).toEqual(['첫째 칸', '둘째 칸', '셋째 칸', '넷째 칸']);
  await page.getByRole('button', { name: '이 셀의 첫 문단으로 이동' }).first().click();
  await expect(page.locator('.inspector-paragraph').filter({ hasText: '첫째 칸' })).toBeFocused();
  await select(page, complex, '복합표_합성.hwpx');
  await page.getByRole('button', { name: '표 보기', exact: true }).click();
  await expect(page.locator('.inspector-table')).toHaveCount(3);
  await expect(page.getByText('병합 표입니다. 셀 위치와 읽은 텍스트만 표시합니다.', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('중첩 표입니다. 원래 배치를 재현하지 않습니다.', { exact: true }).first()).toBeVisible();
});

test('large documents keep bounded lists, preserve emoji across text windows and support keyboard paragraph navigation', async ({ page }) => {
  const long = '가'.repeat(2999) + '😀' + '긴 문단 끝';
  const input = withParagraphs([long, ...Array.from({ length: 84 }, (_, index) => `합성 문단 ${index + 2}`)]);
  await ready(page);
  await select(page, input);
  await expect(page.locator('.inspector-paragraph')).toHaveCount(40);
  const first = page.locator('.inspector-paragraph').first();
  const text = first.locator(':scope > .inspector-text-window > .inspector-document-text');
  expect(await text.textContent()).toBe('가'.repeat(2999));
  await first.getByRole('button', { name: '문단 텍스트 다음 부분', exact: true }).click();
  expect(await text.textContent()).toBe('😀긴 문단 끝');
  await page.getByLabel('문단 번호로 이동', { exact: true }).fill('85');
  await page.getByLabel('문단 번호로 이동', { exact: true }).press('Enter');
  await expect(page.locator('.inspector-paragraph')).toHaveCount(5);
  await expect(page.locator('.inspector-paragraph').last()).toBeFocused();
  await expect(page.locator('.inspector-paragraph').last().locator('.inspector-document-text').first()).toHaveText('합성 문단 85');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('decoded markup remains text and inspection adds no external requests or persistent document storage', async ({ page, context }) => {
  const marker = '<img src="https://outside.invalid/synthetic" onerror="window.inspectionExecuted=true">';
  await ready(page);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await context.setOffline(true);
  await select(page, withParagraphs([marker]));
  await expect(page.locator('.inspector-paragraph > .inspector-text-window > .inspector-document-text')).toHaveText(marker);
  await expect(page.locator('.document-inspector img, .document-inspector iframe, .document-inspector a')).toHaveCount(0);
  const state = await page.evaluate(async () => ({
    executed: (window as typeof window & { inspectionExecuted?: boolean }).inspectionExecuted ?? false,
    local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: (await indexedDB.databases()).map((database) => database.name), caches: await caches.keys(),
  }));
  expect(state).toEqual({ executed: false, local: [], session: [], databases: [], caches: [] });
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('an oversized font label cannot expand repeated detail cells into unbounded text', async ({ page }) => {
  const entries = unzipSync(plain);
  const header = entries['Contents/header.xml'];
  if (!header) throw new Error('Missing synthetic header.');
  entries['Contents/header.xml'] = strToU8(new TextDecoder().decode(header).replace('face="함초롬바탕"', `face="${'글'.repeat(50_000)}끝표시"`));
  const input = Buffer.from(zipSync(entries, { level: 0 }));
  await ready(page);
  await select(page, input);
  await page.locator('.inspector-paragraph').first().locator('summary').click();
  const label = page.locator('.inspector-format-table').first().locator('tbody tr').first().locator('td').first();
  await expect(label).toHaveText('글'.repeat(256) + '… (일부 표시)');
  expect((await label.textContent())?.length).toBeLessThan(300);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('No unchanged download.');
  expect(await readFile(path)).toEqual(input);
});
