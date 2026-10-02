import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { getDraftProfile } from '../../src/domain/competitions';
import { inspectHwpx } from '../../src/engine/preflight';
import { makeResearchFixture } from '../helpers/research-fixture';

const fixture = Buffer.from(makeResearchFixture());
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HH = 'http://www.hancom.co.kr/hwpml/2011/head';
const decoder = new TextDecoder('utf-8', { fatal: true });

interface Paragraph { id: string; text: string; paraRef: string; charRefs: string[] }
interface Harness { drafts: number; selections: Array<{ profileId?: string; assignmentCount: number; selectedCount?: number; additions: number }> }
type ResultFault = 'profile-id' | 'profile-year' | 'included-count' | 'none';
interface ResultHarness {
  fault: ResultFault;
  captured: Array<{ bytes: ArrayBuffer; profileId?: string; profileYear?: number; includedCount?: number }>;
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const host = window as typeof window & { catalogHarness: Harness };
    const state: Harness = { drafts: 0, selections: [] };
    host.catalogHarness = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        const request = message as { type?: string; options?: { profileId?: string; assignments?: unknown[]; summaryParagraphIds?: unknown[]; supplements?: unknown[] } };
        if (request.type === 'DRAFT') {
          state.drafts += 1;
          state.selections.push({ profileId: request.options?.profileId, assignmentCount: request.options?.assignments?.length ?? 0,
            selectedCount: request.options?.summaryParagraphIds?.length, additions: request.options?.supplements?.length ?? 0 });
        }
        super.postMessage(message, transferOrOptions as Transferable[]);
      }
    };
  });
}

async function instrumentResultFaults(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const host = window as typeof window & { resultHarness: ResultHarness };
    const state: ResultHarness = { fault: 'none', captured: [] };
    host.resultHarness = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<{ type?: string; result?: {
          bytes?: ArrayBuffer; profileId?: string; profileYear?: number;
          includedParagraphCount?: number; excludedParagraphCount?: number; sourceSelection?: string;
        } }>) => {
          const result = event.data.result;
          if (event.data.type !== 'DRAFT_READY' || state.fault === 'none' || !(result?.bytes instanceof ArrayBuffer)) return;
          // Alter the actual successfully generated Worker response before the
          // application's handler runs; no fabricated engine result is sent.
          state.captured.push({ bytes: result.bytes, profileId: result.profileId,
            profileYear: result.profileYear, includedCount: result.includedParagraphCount });
          if (state.fault === 'profile-id') result.profileId = 'innovation-report';
          if (state.fault === 'profile-year') result.profileYear = 2025;
          if (state.fault === 'included-count') {
            result.includedParagraphCount = (result.includedParagraphCount ?? 10) - 1;
            result.excludedParagraphCount = (result.excludedParagraphCount ?? 0) + 1;
            result.sourceSelection = 'summary-selection';
          }
          state.fault = 'none';
        });
      }
    };
  });
}

function paragraphs(bytes: Uint8Array): Paragraph[] {
  const section = unzipSync(bytes)['Contents/section0.xml'];
  if (!section) throw new Error('Missing synthetic section.');
  const parser = new SaxesParser({ xmlns: true });
  const values: Paragraph[] = [];
  let current: Paragraph | null = null;
  let insideText = false;
  parser.on('opentag', (tag) => {
    if (tag.uri !== HP) return;
    const attrs = Object.fromEntries(Object.values(tag.attributes).filter((attribute) => attribute.uri === '').map((attribute) => [attribute.local, attribute.value]));
    if (tag.local === 'p') current = { id: attrs.id ?? '', text: '', paraRef: attrs.paraPrIDRef ?? '', charRefs: [] };
    if (current && tag.local === 'run') current.charRefs.push(attrs.charPrIDRef ?? '');
    if (tag.local === 't') insideText = true;
    if (current && tag.local === 'tab') current.text += '\t';
    if (current && tag.local === 'lineBreak') current.text += '\n';
  });
  parser.on('text', (value) => { if (current && insideText) current.text += value; });
  parser.on('cdata', (value) => { if (current && insideText) current.text += value; });
  parser.on('closetag', (tag) => {
    if (tag.uri !== HP) return;
    if (tag.local === 't') insideText = false;
    if (tag.local === 'p' && current) { values.push(current); current = null; }
  });
  parser.write(decoder.decode(section)).close();
  return values;
}

function assertBodyFormat(bytes: Uint8Array, height: number, line: number): void {
  const header = unzipSync(bytes)['Contents/header.xml'];
  if (!header) throw new Error('Missing generated header.');
  const chars = new Map<string, string>();
  const spacing = new Map<string, { type?: string; value?: string }>();
  let para = '';
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.uri !== HH) return;
    const attrs = Object.fromEntries(Object.values(tag.attributes).filter((attribute) => attribute.uri === '').map((attribute) => [attribute.local, attribute.value]));
    if (tag.local === 'charPr') chars.set(attrs.id ?? '', attrs.height ?? '');
    if (tag.local === 'paraPr') para = attrs.id ?? '';
    if (tag.local === 'lineSpacing') spacing.set(para, attrs);
  });
  parser.write(decoder.decode(header)).close();
  const source = paragraphs(bytes).filter((paragraph) => Number(paragraph.id) >= 1000 && Number(paragraph.id) < 10_000);
  expect(source.length).toBeGreaterThan(0);
  for (const paragraph of source) {
    expect(spacing.get(paragraph.paraRef)).toMatchObject({ type: 'PERCENT', value: String(line) });
    for (const ref of paragraph.charRefs) expect(chars.get(ref)).toBe(String(height));
  }
}

async function openSection(page: Page, label: string): Promise<void> {
  const details = page.locator('details').filter({ has: page.getByText(label, { exact: true }) });
  await expect(details).toHaveCount(1);
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

async function ready(page: Page): Promise<void> {
  await page.goto('./#/start');
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
}

async function selectOriginal(page: Page): Promise<void> {
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({ name: '대회선택_합성.hwpx', mimeType: 'application/hwp+zip', buffer: fixture });
  await expect(page.getByRole('heading', { name: '대회선택_합성.hwpx', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '대회 선택', exact: true })).toBeVisible();
}

async function selectProfile(page: Page, id: string): Promise<void> {
  const profile = getDraftProfile(id);
  if (!profile) throw new Error(`Missing test profile: ${id}`);
  await openSection(page, '세부 설정');
  await page.getByLabel('대회 검색', { exact: true }).fill('');
  await page.getByRole('combobox', { name: '대회 선택', exact: true }).selectOption(profile.competitionId);
  const yearInput = page.getByRole('combobox', { name: '기준 연도', exact: true });
  if (await yearInput.inputValue() !== String(profile.year)) await yearInput.selectOption(String(profile.year));
  const documentInput = page.getByRole('combobox', { name: '문서·분과 선택', exact: true });
  if (await documentInput.count()) await documentInput.selectOption(id);
}

async function generate(page: Page): Promise<void> {
  await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.', exact: true })).toBeVisible();
}

async function download(page: Page, button = '생성한 초안 내려받기'): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('No actual HWPX download.');
  return readFile(path);
}

async function expectSource(bytes: Uint8Array, selected = Array.from({ length: 10 }, (_, index) => index)): Promise<void> {
  const source = paragraphs(fixture);
  const output = paragraphs(bytes).filter((paragraph) => Number(paragraph.id) >= 1000 && Number(paragraph.id) < 10_000)
    .sort((left, right) => Number(left.id) - Number(right.id));
  expect(output.map(({ id, text }) => ({ id, text }))).toEqual(selected.map((index) => ({ id: String(1000 + index), text: source[index]!.text })));
  const reopened = await inspectHwpx(bytes, 'catalog-output.hwpx');
  expect(reopened.inspection.tables).toEqual([]);
}

test('one offline original creates distinct competition drafts and only approved teacher additions', async ({ page, context }) => {
  await instrument(page);
  await ready(page);
  const requests: string[] = [];
  page.on('request', (request) => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  await context.setOffline(true);
  await selectOriginal(page);
  await page.getByLabel('연구 제목', { exact: false }).fill('합성 다대회 원고');
  await generate(page);
  const innovation = await download(page);
  await expectSource(innovation);
  assertBodyFormat(innovation, 1200, 160);
  await selectProfile(page, 'field-report');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  const field = getDraftProfile('field-report')!;
  const addition = '[교사 직접 작성] 합성 보완 문장 & <원문과 별도> 😀';
  await page.getByText('질문을 보고 직접 내용 보완하기', { exact: true }).click();
  await page.getByLabel(`직접 작성: ${field.labels.need}`, { exact: true }).fill(addition);
  await generate(page);
  const unchecked = await download(page);
  expect(paragraphs(unchecked).some((paragraph) => paragraph.text === addition)).toBe(false);
  await page.getByLabel(`이 내용을 초안에 포함: ${field.labels.need}`, { exact: true }).check();
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await generate(page);
  const added = await download(page);
  await expectSource(added);
  assertBodyFormat(added, 1100, 140);
  expect(paragraphs(added).filter((paragraph) => Number(paragraph.id) >= 10_000).map((paragraph) => paragraph.text)).toEqual([addition]);
  expect((await download(page, '원본 그대로 내려받기'))).toEqual(fixture);
  await page.getByRole('combobox', { name: '작성 단계', exact: true }).selectOption('regional');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '대회선택_합성.hwpx', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});

test('national mutation restrictions prevent Worker generation and retain the original download', async ({ page }) => {
  await instrument(page);
  await ready(page);
  await selectOriginal(page);
  await page.getByLabel('연구 제목', { exact: false }).fill('수정 금지 단계 합성 원고');
  for (const id of ['character-teacher-report', 'ebs-review-description']) {
    await selectProfile(page, id);
    await page.getByRole('combobox', { name: '작성 단계', exact: true }).selectOption('national');
    await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
    await expect(page.locator('.draft-blocker')).toBeVisible();
    await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
    expect((await download(page, '원본 그대로 내려받기'))).toEqual(fixture);
  }
  expect(await page.evaluate(() => (window as typeof window & { catalogHarness: Harness }).catalogHarness.drafts)).toBe(0);
});

test('a reviewed summary outputs selected original paragraphs and reports the excluded source honestly', async ({ page }) => {
  await instrument(page);
  await ready(page);
  await selectOriginal(page);
  await page.getByLabel('연구 제목', { exact: false }).fill('교사 검토 합성 요약');
  await selectProfile(page, 'field-summary');
  for (let number = 1; number <= 10; number += 1) {
    const checkbox = page.getByLabel(`문단 ${number}을 요약 후보로 선택`, { exact: true });
    if ([1, 4, 8].includes(number)) await checkbox.check();
    else await checkbox.uncheck();
  }
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
  await expect(page.locator('.draft-summary-review > p[role="status"]')).toHaveText('선택한 3/전체 10 문단만 요약 후보에 포함, 나머지 문단은 원본에 보존합니다.');
  await page.getByLabel('선택한 원문만 요약 초안에 포함하는 것을 확인했습니다.', { exact: true }).check();
  await generate(page);
  const summary = await download(page);
  await expectSource(summary, [0, 3, 7]);
  assertBodyFormat(summary, 1100, 140);
  await expect(page.locator('.draft-result')).toContainText('전체 원문 10개 중 3개 문단을 요약 초안에 포함하고 7개는 원본에 보존합니다.');
  await openSection(page, '다운로드 후 확인');
  await expect(page.locator('.draft-verification')).toContainText('선택한 원문 텍스트 보존 확인');
  expect((await download(page, '원본 그대로 내려받기'))).toEqual(fixture);
  expect(await page.evaluate(() => (window as typeof window & { catalogHarness: Harness }).catalogHarness.selections.at(-1)))
    .toMatchObject({ profileId: 'field-summary', assignmentCount: 10, selectedCount: 3 });
  await page.getByLabel('문단 1을 요약 후보로 선택', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
});

test('previous-year guidance is labelled honestly and a custom reference respects bounded actual output', async ({ page }) => {
  await ready(page);
  await selectOriginal(page);
  await page.getByLabel('연구 제목', { exact: false }).fill('개인 참고 기준 합성 원고');
  await selectProfile(page, 'teacher-invention-report');
  await expect(page.getByRole('combobox', { name: '기준 연도', exact: true })).toHaveValue('2025');
  await openSection(page, '공식 기준과 준비물');
  await expect(page.locator('.draft-official-profile')).toContainText('2025');
  await expect(page.locator('.draft-official-profile')).toContainText(/최신|2026.*미확인|당해/u);
  await selectProfile(page, 'custom');
  await page.getByLabel('참고 기준 이름', { exact: true }).fill('교사 개인 참고 양식');
  await page.getByLabel('참고 글꼴', { exact: true }).fill('함초롬바탕');
  await page.getByLabel('참고 글자 크기 (pt)', { exact: true }).fill('12.75');
  await page.getByLabel('참고 줄간격 (%)', { exact: true }).fill('175');
  await generate(page);
  const custom = await download(page);
  await expectSource(custom);
  assertBodyFormat(custom, 1275, 175);
  await expect(page.locator('.draft-official-profile')).toContainText(/개인|참고/u);
  await page.getByLabel('참고 글자 크기 (pt)', { exact: true }).fill('5');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
  expect((await download(page, '원본 그대로 내려받기'))).toEqual(fixture);
});

test('a real generated result must match the reviewed profile and selection before it becomes downloadable', async ({ page }) => {
  await instrumentResultFaults(page);
  await ready(page);
  await selectOriginal(page);
  await page.getByLabel('연구 제목', { exact: false }).fill('생성 결과 일치 검증 합성 원고');
  await selectProfile(page, 'field-report');
  for (const fault of ['profile-id', 'profile-year', 'included-count'] as const) {
    await page.evaluate((value) => { (window as typeof window & { resultHarness: ResultHarness }).resultHarness.fault = value; }, fault);
    await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('생성 결과가 검토한 대회·기준·문단 선택과 일치하지 않습니다.');
    await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as typeof window & { resultHarness: ResultHarness }).resultHarness.captured.at(-1)))
      .toMatchObject({ profileId: 'field-report', profileYear: 2026, includedCount: 10 });
    expect(await page.evaluate(() => (window as typeof window & { resultHarness: ResultHarness }).resultHarness.captured
      .every(({ bytes }) => bytes.byteLength > 0 && new Uint8Array(bytes).every((value) => value === 0)))).toBe(true);
    expect((await download(page, '원본 그대로 내려받기'))).toEqual(fixture);
    await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeEnabled();
  }
  await generate(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const recovered = await download(page);
  await expectSource(recovered);
  assertBodyFormat(recovered, 1100, 140);
  expect((await download(page, '원본 그대로 내려받기'))).toEqual(fixture);
});
