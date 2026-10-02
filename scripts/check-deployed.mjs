import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { makeHancomPackage } from '../tests/helpers/hancom-package.ts';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

const target = new URL(process.env.PAGES_URL ?? '');
const commit = process.env.EXPECTED_COMMIT ?? '';
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('EXPECTED_COMMIT must be the full deployed commit SHA.');
if (target.username || target.password || target.search || target.hash
  || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname)))) {
  throw new Error('PAGES_URL must be an HTTPS site URL or a loopback HTTP test URL, without credentials, query or hash.');
}
if (!target.pathname.endsWith('/')) target.pathname += '/';
const fixture = await readFile(new URL('../tests/fixtures/01-plain-text.hwpx', import.meta.url));
const fixtureGolden = JSON.parse(await readFile(new URL('../tests/fixtures/01-plain-text.golden.json', import.meta.url), 'utf8'));
const replacement = await readFile(new URL('../tests/fixtures/03-spine-order.hwpx', import.meta.url));
const tableFixture = await readFile(new URL('../tests/fixtures/04-simple-table.hwpx', import.meta.url));
const hancom = Buffer.from(makeHancomPackage(fixture));

// Only a tiny trusted synthetic download is expanded in this CI helper.
function sourceParagraphTexts(bytes) {
  const section = unzipSync(bytes)['Contents/section0.xml'];
  assert.ok(section, 'The draft has no section XML.');
  const parser = new SaxesParser({ xmlns: true });
  const texts = [];
  let source = null;
  let inText = false;
  parser.on('opentag', (tag) => {
    if (tag.uri !== 'http://www.hancom.co.kr/hwpml/2011/paragraph') return;
    if (tag.local === 'p') {
      const id = Object.values(tag.attributes).find((attribute) => attribute.uri === '' && attribute.local === 'id')?.value;
      source = Number(id) >= 1000 ? '' : null;
    }
    if (tag.local === 't') inText = true;
    if (source !== null && tag.local === 'tab') source += '\t';
    if (source !== null && tag.local === 'lineBreak') source += '\n';
  });
  parser.on('text', (text) => { if (source !== null && inText) source += text; });
  parser.on('closetag', (tag) => {
    if (tag.uri !== 'http://www.hancom.co.kr/hwpml/2011/paragraph') return;
    if (tag.local === 't') inText = false;
    if (tag.local === 'p' && source !== null) { texts.push(source); source = null; }
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(section)).close();
  return texts;
}
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
  await expect(page.getByRole('heading', { name: '문서 구조 보기', exact: true })).toBeVisible();
  await expect(page.locator('.inspector-paragraph')).toHaveCount(2);
  await expect(page.locator('.inspector-paragraph > .inspector-text-window > .inspector-document-text').first()).toHaveText('합성 연구 보고서');
  await page.locator('.inspector-paragraph').first().locator('summary').click();
  await expect(page.locator('.inspector-paragraph').first().getByText('11 pt', { exact: true })).toBeVisible();
  const requested = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const download = await requested;
  assert.match(download.suggestedFilename(), /_원본사본\.hwpx$/);
  const path = await download.path();
  assert.ok(path, 'The public app did not produce a downloadable file.');
  assert.deepEqual(await readFile(path), fixture, 'Downloaded demo bytes changed.');

  // Exercise the actual public Worker and independently reopen its offline output.
  await expect(page.getByRole('heading', { name: '보고서·논문 초안 만들기' })).toBeVisible();
  await page.getByLabel('연구 제목').fill('배포 검증용 합성 연구');
  await page.getByRole('button', { name: '검토한 내용으로 초안 생성' }).click();
  await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.' })).toBeVisible();
  const draftDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '생성한 초안 내려받기' }).click();
  const draftPath = await (await draftDownload).path();
  assert.ok(draftPath, 'The public app did not produce a downloadable research draft.');
  const draftBytes = await readFile(draftPath);
  assert.deepEqual(sourceParagraphTexts(draftBytes), fixtureGolden.paragraphsInDeclaredOrder);
  await expect(page.locator('.draft-verification').getByText('미실행', { exact: true })).toBeVisible();
  await page.getByLabel('연구 제목').fill('검토 중인 새 제목');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기' })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({ name: '초안재검사_합성.hwpx', mimeType: 'application/hwp+zip', buffer: draftBytes });
  await expect(page.getByRole('heading', { name: '초안재검사_합성.hwpx', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({
    name: '배포검증_합성.hwpx', mimeType: 'application/hwp+zip', buffer: replacement,
  });
  await expect(page.getByRole('heading', { name: '배포검증_합성.hwpx' })).toBeVisible();
  await expect(page.locator('.report-grid > div').filter({ has: page.locator('dt', { hasText: '선언된 구역' }) }).locator('dd')).toHaveText(/^3개$/);
  await expect(page.locator('.inspector-paragraph > .inspector-text-window > .inspector-document-text')).toHaveText('선언 순서 첫 번째');
  await page.getByLabel('구역 선택', { exact: true }).selectOption({ index: 2 });
  await expect(page.locator('.inspector-paragraph > .inspector-text-window > .inspector-document-text')).toHaveText('선언 순서 세 번째');
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

  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({
    name: '단순표_합성.hwpx', mimeType: 'application/hwp+zip', buffer: tableFixture,
  });
  await expect(page.getByRole('heading', { name: '단순표_합성.hwpx' })).toBeVisible();
  await page.getByRole('button', { name: '표 보기', exact: true }).click();
  await expect(page.locator('.inspector-table')).toHaveCount(1);
  assert.deepEqual(await page.locator('.inspector-cell-table .inspector-document-text').allTextContents(), ['첫째 칸', '둘째 칸', '셋째 칸', '넷째 칸']);
  const tableDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const tablePath = await (await tableDownload).path();
  assert.ok(tablePath, 'The table inspection did not produce a downloadable file.');
  assert.deepEqual(await readFile(tablePath), tableFixture, 'Table inspection changed the original bytes.');
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
    documentReading: 'paragraphs, character size, spine order and table cells passed offline',
    researchDraft: 'generated offline, independently reopened, source text preserved, stale output cleared',
  }));
} finally {
  await browser.close();
}
