import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { inspectHwpx } from '../../src/engine/preflight';
import { makeResearchFixture } from '../helpers/research-fixture';

const fixture = Buffer.from(makeResearchFixture());
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';

/** Reopen literal source paragraphs, independently of the app's success status. */
function sourceParagraphs(bytes: Uint8Array): string[] {
  const section = unzipSync(bytes)['Contents/section0.xml'];
  if (!section) throw new Error('No actual generated section XML.');
  const parser = new SaxesParser({ xmlns: true });
  const result: Array<{ id: string; text: string }> = [];
  let paragraph: { id: string; text: string } | null = null;
  let inText = false;
  parser.on('opentag', (tag) => {
    if (tag.uri !== HP) return;
    if (tag.local === 'p') paragraph = { id: Object.values(tag.attributes).find((attribute) => attribute.uri === '' && attribute.local === 'id')?.value ?? '', text: '' };
    if (tag.local === 't') inText = true;
    if (paragraph && tag.local === 'tab') paragraph.text += '\t';
    if (paragraph && tag.local === 'lineBreak') paragraph.text += '\n';
  });
  const append = (text: string) => { if (paragraph && inText) paragraph.text += text; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', (tag) => {
    if (tag.uri !== HP) return;
    if (tag.local === 't') inText = false;
    if (tag.local === 'p' && paragraph) { result.push(paragraph); paragraph = null; }
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(section)).close();
  return result.filter(({ id }) => Number(id) >= 1000 && Number(id) < 10_000)
    .sort((left, right) => Number(left.id) - Number(right.id)).map(({ text }) => text);
}

async function ready(page: Page): Promise<void> {
  await page.goto('./#/start');
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
}

async function upload(page: Page, buffer = fixture, name = '협력수업 연구.hwpx'): Promise<void> {
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({ name, buffer, mimeType: 'application/hwp+zip' });
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function download(page: Page, label = '생성한 초안 내려받기'): Promise<Buffer> {
  const requested = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const path = await (await requested).path();
  if (!path) throw new Error('No downloadable actual HWPX.');
  return readFile(path);
}

async function expectPastedSource(draft: Uint8Array, source: Uint8Array, lines: string[]): Promise<void> {
  const reopened = await inspectHwpx(source, 'entered-source.hwpx');
  const paragraphs = reopened.inspection.paragraphs;
  // The trusted source includes one empty paragraph for section/page controls.
  // Preserve it as well as every entered line; an entered blank line is distinct.
  expect(paragraphs.map(({ text }) => text)).toEqual(['', ...lines]);
  expect(paragraphs[0]?.sourceId).toBe('0');
  expect(reopened.inspection.runs.some((run) => run.paragraphId === paragraphs[0]?.nodeId
    && run.segments.some((segment) => segment.kind === 'UNKNOWN_CONTROL' && segment.layoutControl))).toBe(true);
  expect(sourceParagraphs(source)).toEqual(lines);
  expect(sourceParagraphs(draft)).toEqual(paragraphs.map(({ text }) => text));
}

async function generate(page: Page): Promise<Buffer> {
  await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.', exact: true })).toBeVisible();
  return download(page);
}

async function expectAdvancedClosed(page: Page): Promise<void> {
  for (const label of ['세부 설정', '공식 기준과 준비물', '문단 배치 확인·수정', '문서 검사 상세']) {
    const details = page.locator('details').filter({ has: page.getByText(label, { exact: true }) });
    await expect(details).toHaveCount(1);
    await expect(details).not.toHaveAttribute('open', '');
  }
  await expect(page.getByLabel('교과·주제 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('학교급 선택', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('원문 문단 검색', { exact: true })).not.toBeVisible();
}

test('upload, choose a competition and create a real draft without opening advanced controls', async ({ page }) => {
  await ready(page);
  await upload(page);
  await expect(page.getByLabel('연구 제목', { exact: false })).toHaveValue('협력수업 연구');
  await expectAdvancedClosed(page);
  await page.getByRole('combobox', { name: '대회 선택', exact: true }).selectOption('field');
  await expect(page.getByLabel('연구 제목', { exact: false })).toBeEnabled();
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeEnabled();
  await expectAdvancedClosed(page);
  const draft = await generate(page);
  const source = await inspectHwpx(fixture, 'synthetic.hwpx');
  expect(sourceParagraphs(draft)).toEqual(source.inspection.paragraphs.map(({ text }) => text));
  const reopened = await inspectHwpx(draft, 'created.hwpx');
  expect(reopened.report.sectionPaths).toEqual(['Contents/section0.xml']);
  expect(reopened.inspection.tables).toEqual([]);
  expect(await download(page, '원본 그대로 내려받기')).toEqual(fixture);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toBeVisible();
});

test('a blocked table leaves inputs clickable and offers an explicit text-only new-source recovery', async ({ page }) => {
  const original = Buffer.from(makeResearchFixture({ includeTable: true }));
  await ready(page);
  await upload(page, original, '표를 포함한 연구.hwpx');
  const title = page.getByLabel('연구 제목', { exact: false });
  await expect(title).toBeEnabled();
  await title.fill('교사가 수정한 제목');
  await expect(title).toHaveValue('교사가 수정한 제목');
  await page.getByRole('combobox', { name: '대회 선택', exact: true }).selectOption('paper');
  await expect(title).toBeEnabled();
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
  await expect(page.locator('.draft-blocker')).toContainText('표');
  expect(await download(page, '원본 그대로 내려받기')).toEqual(original);
  await page.getByRole('button', { name: '글을 붙여넣어 새로 시작', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '보고서로 만들 글', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '보고서로 만들 글', exact: true }).fill('교사가 직접 가져온 줄글\n표와 사진을 제외하고 새로 시작합니다.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '이 글로 시작하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '붙여넣은 글.hwpx', exact: true })).toBeVisible();
  await expect(page.locator('.draft-blocker')).toHaveCount(0);
  const pastedOriginal = await download(page, '원본 그대로 내려받기');
  await expectPastedSource(await generate(page), pastedOriginal, ['교사가 직접 가져온 줄글', '표와 사진을 제외하고 새로 시작합니다.']);
});

test('pasted prose produces real HWPX offline, preserving blank lines and inert markup without persistent storage', async ({ page, context }) => {
  await ready(page);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await context.setOffline(true);
  const marker = '<img src="https://outside.invalid/synthetic" onerror="window.simpleFlowExecuted=true">';
  const lines = ['Ⅰ. 연구의 필요성', '', marker, 'Ⅲ. 연구 결과: 합성 한글 & 😀 그대로'];
  await page.getByRole('button', { name: '글 붙여넣기', exact: true }).click();
  await page.getByRole('textbox', { name: '보고서로 만들 글', exact: true }).fill(lines.join('\n'));
  await page.getByRole('button', { name: '이 글로 시작하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '붙여넣은 글.hwpx', exact: true })).toBeVisible();
  await expect(page.getByLabel('연구 제목', { exact: false })).toBeEnabled();
  await expectAdvancedClosed(page);
  const draft = await generate(page);
  const original = await download(page, '원본 그대로 내려받기');
  await expectPastedSource(draft, original, lines);
  const reopened = await inspectHwpx(draft, 'pasted-output.hwpx');
  expect(reopened.inspection.tables).toEqual([]);
  await expect(page.locator('.research-draft-panel img, .research-draft-panel iframe')).toHaveCount(0);
  expect(await page.evaluate(async () => ({
    executed: (window as typeof window & { simpleFlowExecuted?: boolean }).simpleFlowExecuted ?? false,
    local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: (await indexedDB.databases()).map((database) => database.name), caches: await caches.keys(),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }))).toEqual({ executed: false, local: [], session: [], databases: [], caches: [], serviceWorkers: 0 });
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

interface TextHarness {
  hold: boolean;
  held: number;
  buffers: ArrayBuffer[];
  release: () => void;
}

async function holdRealTextReplies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const host = window as typeof window & { textHarness: TextHarness };
    const replies: Array<() => void> = [];
    const state: TextHarness = { hold: true, held: 0, buffers: [], release: () => {
      for (const deliver of replies.splice(0)) deliver();
      state.held = 0;
    } };
    host.textHarness = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<{ type?: string; bytes?: ArrayBuffer }>) => {
          if (!state.hold || event.data.type !== 'TEXT_READY') return;
          event.stopImmediatePropagation();
          state.held += 1;
          if (event.data.bytes instanceof ArrayBuffer) state.buffers.push(event.data.bytes);
          const handler = this.onmessage;
          replies.push(() => handler?.call(this, event));
        });
      }
    };
  });
}

test('cancelled text-source creation wipes its late real reply and keeps the accepted original', async ({ page, context }) => {
  await holdRealTextReplies(page);
  await ready(page);
  const requests: string[] = [];
  page.on('request', (request) => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  await context.setOffline(true);
  await upload(page);
  await page.getByRole('button', { name: '글 붙여넣기', exact: true }).click();
  const prose = '취소되는 합성 글\n뒤늦은 결과가 원본을 바꾸면 안 됩니다.';
  await page.getByRole('textbox', { name: '보고서로 만들 글', exact: true }).fill(prose);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '이 글로 시작하기', exact: true }).click();
  await page.waitForFunction(() => (window as typeof window & { textHarness: TextHarness }).textHarness.held === 1);
  await page.getByRole('button', { name: '검사 취소', exact: true }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as typeof window & { textHarness: TextHarness }).textHarness;
    state.hold = false;
    state.release();
  });
  expect(await page.evaluate(() => {
    const state = (window as typeof window & { textHarness: TextHarness }).textHarness;
    return state.buffers.length === 1 && state.buffers.every((buffer) => buffer.byteLength > 0 && new Uint8Array(buffer).every((byte) => byte === 0));
  })).toBe(true);
  await expect(page.getByRole('heading', { name: '협력수업 연구.hwpx', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '붙여넣은 글.hwpx', exact: true })).toHaveCount(0);
  expect(await download(page, '원본 그대로 내려받기')).toEqual(fixture);
  await expect(page.getByRole('textbox', { name: '보고서로 만들 글', exact: true })).toHaveValue(prose);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '이 글로 시작하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '붙여넣은 글.hwpx', exact: true })).toBeVisible();
  const pastedOriginal = await download(page, '원본 그대로 내려받기');
  await expectPastedSource(await generate(page), pastedOriginal, prose.split('\n'));
  expect(requests).toEqual([]);
});

type TextReplyFault = 'summary-shape' | 'unexpected-type';
interface TextFaultHarness { fault: TextReplyFault | null; bytes: ArrayBuffer[] }

async function corruptOneRealTextReply(page: Page, fault: TextReplyFault): Promise<void> {
  await page.addInitScript((initialFault) => {
    const host = window as typeof window & { textFaultHarness: TextFaultHarness };
    const state: TextFaultHarness = { fault: initialFault, bytes: [] };
    host.textFaultHarness = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<{ type?: string; bytes?: ArrayBuffer; inspection?: { summary?: unknown } }>) => {
          const response = event.data;
          if (!state.fault || response.type !== 'TEXT_READY' || !(response.bytes instanceof ArrayBuffer)) return;
          state.bytes.push(response.bytes);
          if (state.fault === 'summary-shape' && response.inspection) response.inspection.summary = null;
          if (state.fault === 'unexpected-type') response.type = 'REPORT';
          state.fault = null;
        });
      }
    };
  }, fault);
}

for (const fault of ['summary-shape', 'unexpected-type'] as const) {
  test(`a malformed real text reply (${fault}) is wiped without replacing or locking the accepted original`, async ({ page }) => {
    await corruptOneRealTextReply(page, fault);
    await ready(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await upload(page);
    await page.getByRole('button', { name: '글 붙여넣기', exact: true }).click();
    const prose = '손상된 응답 검증용 합성 원문\n이전 문서는 계속 내려받을 수 있어야 합니다.';
    await page.getByRole('textbox', { name: '보고서로 만들 글', exact: true }).fill(prose);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '이 글로 시작하기', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
    await expect(page.getByRole('heading', { name: '협력수업 연구.hwpx', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '붙여넣은 글.hwpx', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '검사 취소', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '보고서로 만들 글', exact: true })).toBeEnabled();
    await expect(page.getByLabel('연구 제목', { exact: true })).toBeEnabled();
    expect(await page.evaluate(() => {
      const state = (window as typeof window & { textFaultHarness: TextFaultHarness }).textFaultHarness;
      return state.bytes.length === 1 && state.bytes.every((buffer) => buffer.byteLength > 0 && new Uint8Array(buffer).every((byte) => byte === 0));
    })).toBe(true);
    expect(await download(page, '원본 그대로 내려받기')).toEqual(fixture);
    expect(errors).toEqual([]);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '이 글로 시작하기', exact: true }).click();
    await expect(page.getByRole('heading', { name: '붙여넣은 글.hwpx', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
