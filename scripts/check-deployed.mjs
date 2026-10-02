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

// Only tiny trusted synthetic downloads are expanded in this CI helper.
function serializedParagraphs(bytes) {
  const section = unzipSync(bytes)['Contents/section0.xml'];
  assert.ok(section, 'The draft has no section XML.');
  const parser = new SaxesParser({ xmlns: true });
  const paragraphs = [];
  let paragraph = null;
  let inText = false;
  parser.on('opentag', (tag) => {
    if (tag.uri !== 'http://www.hancom.co.kr/hwpml/2011/paragraph') return;
    if (tag.local === 'p') {
      const attributes = Object.fromEntries(Object.values(tag.attributes).filter((attribute) => attribute.uri === '').map((attribute) => [attribute.local, attribute.value]));
      paragraph = { id: attributes.id, text: '', paraRef: attributes.paraPrIDRef, charRefs: [] };
    }
    if (paragraph && tag.local === 'run') paragraph.charRefs.push(Object.values(tag.attributes).find((attribute) => attribute.uri === '' && attribute.local === 'charPrIDRef')?.value);
    if (tag.local === 't') inText = true;
    if (paragraph && tag.local === 'tab') paragraph.text += '\t';
    if (paragraph && tag.local === 'lineBreak') paragraph.text += '\n';
  });
  const appendText = (text) => { if (paragraph && inText) paragraph.text += text; };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', (tag) => {
    if (tag.uri !== 'http://www.hancom.co.kr/hwpml/2011/paragraph') return;
    if (tag.local === 't') inText = false;
    if (tag.local === 'p' && paragraph) { paragraphs.push(paragraph); paragraph = null; }
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(section)).close();
  return paragraphs;
}

function sourceParagraphTexts(bytes) {
  return serializedParagraphs(bytes).filter(({ id }) => Number(id) >= 1000 && Number(id) < 10_000)
    .sort((left, right) => Number(left.id) - Number(right.id)).map(({ text }) => text);
}

function assertSerializedSource(bytes) {
  const source = serializedParagraphs(bytes).filter(({ id }) => Number(id) >= 1000 && Number(id) < 10_000)
    .sort((left, right) => Number(left.id) - Number(right.id));
  assert.deepEqual(source.map(({ id, text }) => ({ id, text })), fixtureGolden.paragraphsInDeclaredOrder
    .map((text, index) => ({ id: String(1000 + index), text })), 'A competition draft changed, lost or duplicated an original paragraph.');
}

function assertSerializedBody(bytes, expected) {
  const header = unzipSync(bytes)['Contents/header.xml'];
  assert.ok(header, 'The draft has no header XML.');
  const characters = new Map();
  const paragraphs = new Map();
  const faces = new Map();
  const parser = new SaxesParser({ xmlns: true });
  let character = null;
  let paragraph = null;
  let language = null;
  parser.on('opentag', (tag) => {
    if (tag.uri !== 'http://www.hancom.co.kr/hwpml/2011/head') return;
    const attributes = Object.fromEntries(Object.values(tag.attributes).filter((attribute) => attribute.uri === '').map((attribute) => [attribute.local, attribute.value]));
    if (tag.local === 'charPr') { character = { height: attributes.height, fontRefs: null }; characters.set(attributes.id, character); }
    if (tag.local === 'fontRef' && character) character.fontRefs = attributes;
    if (tag.local === 'paraPr') { paragraph = {}; paragraphs.set(attributes.id, paragraph); }
    if (tag.local === 'lineSpacing' && paragraph) paragraph.line = attributes;
    if (tag.local === 'fontface') language = attributes.lang;
    if (tag.local === 'font') faces.set(`${language}:${attributes.id}`, attributes.face);
  });
  parser.on('closetag', (tag) => {
    if (tag.uri !== 'http://www.hancom.co.kr/hwpml/2011/head') return;
    if (tag.local === 'charPr') character = null;
    if (tag.local === 'paraPr') paragraph = null;
    if (tag.local === 'fontface') language = null;
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(header)).close();
  const source = serializedParagraphs(bytes).filter(({ id }) => Number(id) >= 1000 && Number(id) < 10_000);
  assert.ok(source.length > 0, 'The downloaded draft contains no original paragraphs.');
  for (const item of source) {
    assert.deepEqual(paragraphs.get(item.paraRef)?.line, { type: 'PERCENT', value: String(expected.line), unit: 'HWPUNIT' });
    assert.ok(item.charRefs.length > 0, 'An original paragraph has no serialized character definition.');
    for (const ref of item.charRefs) {
      const style = characters.get(ref);
      assert.equal(style?.height, String(expected.height));
      for (const lang of ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER']) {
        assert.equal(faces.get(`${lang}:${style?.fontRefs?.[lang.toLowerCase()]}`), expected.face);
      }
    }
  }
}

async function openSection(page, label) {
  const details = page.locator('details').filter({ has: page.getByText(label, { exact: true }) });
  await expect(details).toHaveCount(1);
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

async function selectCatalogProfile(page, competitionId, profileId, year = 2026) {
  await openSection(page, '세부 설정');
  await page.getByLabel('대회 검색', { exact: true }).fill('');
  await page.getByRole('combobox', { name: '대회 선택', exact: true }).selectOption(competitionId);
  const yearInput = page.getByRole('combobox', { name: '기준 연도', exact: true });
  if (await yearInput.inputValue() !== String(year)) await yearInput.selectOption(String(year));
  await page.getByRole('combobox', { name: '문서·분과 선택', exact: true }).selectOption(profileId);
}

async function generateAndDownload(page) {
  await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '생성한 초안 내려받기', exact: true }).click();
  const path = await (await pending).path();
  assert.ok(path, 'The public app did not produce a downloadable competition draft.');
  return readFile(path);
}
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
});

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.publicSmokeDraftRequests = 0;
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...arguments_) {
      if (message?.type === 'DRAFT') window.publicSmokeDraftRequests += 1;
      return Reflect.apply(postMessage, this, [message, ...arguments_]);
    };
  });
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
  await expect(page.getByRole('heading', { name: '만들 문서를 선택하세요', exact: true })).toBeVisible();
  await expect(page.getByText('예시 문서', { exact: true })).toBeVisible();
  const requested = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const download = await requested;
  assert.match(download.suggestedFilename(), /_원본사본\.hwpx$/);
  const path = await download.path();
  assert.ok(path, 'The public app did not produce a downloadable file.');
  assert.deepEqual(await readFile(path), fixture, 'Downloaded demo bytes changed.');

  // Exercise the actual public Worker and independently reopen its offline output.
  await expect(page.getByRole('heading', { name: '보고서·논문 초안 만들기' })).toBeVisible();
  await expect(page.getByLabel('연구 제목')).toHaveValue('합성_예시문서');
  await expect(page.getByLabel('교과·주제 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('원문 문단 검색', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '초안 만들기' }).click();
  await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.' })).toBeVisible();
  const draftDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '생성한 초안 내려받기' }).click();
  const draftPath = await (await draftDownload).path();
  assert.ok(draftPath, 'The public app did not produce a downloadable research draft.');
  const draftBytes = await readFile(draftPath);
  assert.deepEqual(sourceParagraphTexts(draftBytes), fixtureGolden.paragraphsInDeclaredOrder);
  assertSerializedSource(draftBytes);
  assertSerializedBody(draftBytes, { height: 1200, line: 160, face: '휴먼명조' });
  await openSection(page, '다운로드 후 확인');
  await expect(page.locator('.draft-verification').getByText('미실행', { exact: true })).toBeVisible();
  await openSection(page, '문서 검사 상세');
  await expect(page.getByText('5.1.0.0', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '문서 구조 보기', exact: true })).toBeVisible();
  await expect(page.locator('.inspector-paragraph')).toHaveCount(2);
  await expect(page.locator('.inspector-paragraph > .inspector-text-window > .inspector-document-text').first()).toHaveText('합성 연구 보고서');
  await page.locator('.inspector-paragraph').first().locator('summary').click();
  await expect(page.locator('.inspector-paragraph').first().getByText('11 pt', { exact: true })).toBeVisible();
  await page.getByLabel('연구 제목').fill('검토 중인 새 제목');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기' })).toHaveCount(0);

  // Reuse the same original offline: field formatting must change the file,
  // and a teacher addition enters it only after the separate inclusion choice.
  await selectCatalogProfile(page, 'field', 'field-report');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  const teacherText = '[교사 직접 작성] 배포 검증용 합성 보완 문장 & <그대로 보존> 😀';
  await page.getByText('질문을 보고 직접 내용 보완하기', { exact: true }).click();
  await page.getByLabel('직접 작성: 연구의 필요성과 목적', { exact: true }).fill(teacherText);
  const fieldWithoutAddition = await generateAndDownload(page);
  assertSerializedSource(fieldWithoutAddition);
  assertSerializedBody(fieldWithoutAddition, { height: 1100, line: 140, face: '휴먼명조' });
  assert.deepEqual(serializedParagraphs(fieldWithoutAddition).filter(({ id }) => Number(id) >= 10_000), []);
  await page.getByLabel('이 내용을 초안에 포함: 연구의 필요성과 목적', { exact: true }).check();
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  const fieldBytes = await generateAndDownload(page);
  assertSerializedSource(fieldBytes);
  assertSerializedBody(fieldBytes, { height: 1100, line: 140, face: '휴먼명조' });
  assert.deepEqual(serializedParagraphs(fieldBytes).filter(({ id }) => Number(id) >= 10_000).map(({ id, text }) => ({ id, text })), [{ id: '10000', text: teacherText }]);
  const originalAfterSelection = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기', exact: true }).click();
  const originalAfterSelectionPath = await (await originalAfterSelection).path();
  assert.ok(originalAfterSelectionPath, 'The selected competition lost its original download.');
  assert.deepEqual(await readFile(originalAfterSelectionPath), fixture, 'Competition selection or teacher additions changed the original bytes.');

  await selectCatalogProfile(page, 'character', 'character-teacher-report');
  const draftsBeforeBlockedStage = await page.evaluate(() => window.publicSmokeDraftRequests);
  await page.getByRole('combobox', { name: '작성 단계', exact: true }).selectOption('national');
  await expect(page.locator('.draft-blocker')).toBeVisible();
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.publicSmokeDraftRequests), draftsBeforeBlockedStage, 'A blocked national stage dispatched a draft request.');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({ name: '초안재검사_합성.hwpx', mimeType: 'application/hwp+zip', buffer: fieldBytes });
  await expect(page.getByRole('heading', { name: '초안재검사_합성.hwpx', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({
    name: '배포검증_합성.hwpx', mimeType: 'application/hwp+zip', buffer: replacement,
  });
  await expect(page.getByRole('heading', { name: '배포검증_합성.hwpx' })).toBeVisible();
  await openSection(page, '문서 검사 상세');
  await expect(page.locator('.report-grid > div').filter({ has: page.locator('dt', { hasText: '선언된 구역' }) }).locator('dd')).toHaveText(/^3개$/);
  await expect(page.locator('.inspector-paragraph > .inspector-text-window > .inspector-document-text')).toHaveText('선언 순서 첫 번째');
  await page.getByRole('combobox', { name: '구역 선택', exact: true }).selectOption({ index: 2 });
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
  await openSection(page, '문서 검사 상세');
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
  await openSection(page, '문서 검사 상세');
  await page.getByRole('button', { name: '표 보기', exact: true }).click();
  await expect(page.locator('.inspector-table')).toHaveCount(1);
  assert.deepEqual(await page.locator('.inspector-cell-table .inspector-document-text').allTextContents(), ['첫째 칸', '둘째 칸', '셋째 칸', '넷째 칸']);
  const tableDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const tablePath = await (await tableDownload).path();
  assert.ok(tablePath, 'The table inspection did not produce a downloadable file.');
  assert.deepEqual(await readFile(tablePath), tableFixture, 'Table inspection changed the original bytes.');

  // A blocked input must explain the unavailable action while its editable
  // settings and explicit text-only alternative continue to work offline.
  await expect(page.getByLabel('연구 제목', { exact: true })).toBeEnabled();
  await page.getByLabel('연구 제목', { exact: true }).fill('표 원본의 설정은 계속 수정 가능');
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '글을 붙여넣어 새로 시작', exact: true }).click();
  const pastedLines = ['배포 검증용 붙여넣은 글', '', '<img src="https://outside.invalid/synthetic" onerror="window.publicPasteExecuted=true">', '한글 & 😀 그대로 보존'];
  await page.getByRole('textbox', { name: '보고서로 만들 글', exact: true }).fill(pastedLines.join('\n'));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '이 글로 시작하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '붙여넣은 글.hwpx', exact: true })).toBeVisible();
  await expect(page.getByLabel('연구 제목', { exact: true })).toHaveValue('붙여넣은 글');
  await expect(page.getByLabel('학교급 선택', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('원문 문단 검색', { exact: true })).not.toBeVisible();
  const pastedSourceDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기', exact: true }).click();
  const pastedSourcePath = await (await pastedSourceDownload).path();
  assert.ok(pastedSourcePath, 'No actual text-source package was downloadable.');
  const pastedSource = await readFile(pastedSourcePath);
  const sourceParagraphs = serializedParagraphs(pastedSource);
  assert.deepEqual(sourceParagraphs.map(({ text }) => text), ['', ...pastedLines], 'The new text source must contain its separate empty layout carrier and all entered lines.');
  assert.equal(sourceParagraphs[0].id, '0', 'The separate empty carrier is not a user paragraph.');
  assert.deepEqual(sourceParagraphTexts(pastedSource), pastedLines, 'The actual text source changed the entered lines or blanks.');
  const pastedDraft = await generateAndDownload(page);
  assert.deepEqual(sourceParagraphTexts(pastedDraft), sourceParagraphs.map(({ text }) => text), 'The real generated draft did not preserve every source paragraph, including its empty layout carrier.');
  assertSerializedBody(pastedDraft, { height: 1200, line: 160, face: '휴먼명조' });
  assert.equal(await page.evaluate(() => window.publicPasteExecuted ?? false), false, 'Pasted markup executed.');
  await expect(page.locator('.research-draft-panel img, .research-draft-panel iframe')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: (await indexedDB.databases()).map((database) => database.name), caches: await caches.keys() })),
  { local: [], session: [], databases: [], caches: [] }, 'Pasted text left persistent browser data.');
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
    competitionDrafts: 'same original, field 11pt/140%, approved teacher addition, blocked national stage passed offline',
    simpleWorkflow: 'prefilled title and actual draft without opening advanced controls',
    textSource: 'blocked input remains editable; deliberate text-only restart preserves blank lines and inert markup offline',
  }));
} finally {
  await browser.close();
}
