import { expect, test, type Dialog, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { inspectHwpx } from '../../src/engine/preflight';
import { makeResearchFixture } from '../helpers/research-fixture';

const fixture = Buffer.from(makeResearchFixture());
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Harness {
  holdDrafts: boolean;
  heldDrafts: number;
  heldBuffers: ArrayBuffer[];
  releaseDrafts: () => void;
  draftRequests: number;
  terminated: number;
  downloadUrls: string[];
  revokedUrls: string[];
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const host = window as typeof window & { researchHarness: Harness };
    const held: Array<() => void> = [];
    const state: Harness = {
      holdDrafts: false, heldDrafts: 0, heldBuffers: [], draftRequests: 0, terminated: 0, downloadUrls: [], revokedUrls: [],
      releaseDrafts: () => { for (const deliver of held.splice(0)) deliver(); state.heldDrafts = 0; },
    };
    host.researchHarness = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<{ type?: string; result?: { bytes?: ArrayBuffer } }>) => {
          if (!state.holdDrafts || event.data.type !== 'DRAFT_READY') return;
          event.stopImmediatePropagation();
          state.heldDrafts += 1;
          if (event.data.result?.bytes instanceof ArrayBuffer) state.heldBuffers.push(event.data.result.bytes);
          // Save the real handler too, so release exercises its stale-worker
          // guard even after cleanup removes the old Worker listener.
          const handler = this.onmessage;
          held.push(() => handler?.call(this, event));
        });
      }
      override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        if ((message as { type?: string }).type === 'DRAFT') state.draftRequests += 1;
        super.postMessage(message, transferOrOptions as Transferable[]);
      }
      override terminate() { state.terminated += 1; super.terminate(); }
    };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (blob instanceof Blob && blob.type === 'application/hwp+zip') state.downloadUrls.push(url);
      return url;
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { state.revokedUrls.push(url); revoke(url); };
  });
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

async function select(page: Page, buffer = fixture, name = '보고서_합성.hwpx'): Promise<void> {
  const accept = (dialog: Dialog) => dialog.accept();
  page.once('dialog', accept);
  try {
    await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({ name, mimeType: 'application/hwp+zip', buffer });
  } finally { page.off('dialog', accept); }
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '보고서·논문 초안 만들기', exact: true })).toBeVisible();
}

async function generate(page: Page): Promise<void> {
  await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.', exact: true })).toBeVisible();
}

async function download(page: Page, button: string): Promise<{ bytes: Buffer; name: string }> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('No downloaded HWPX.');
  return { bytes: await readFile(path), name: saved.suggestedFilename() };
}

/** Read literal paragraph payload with an independent XML library. */
function paragraphs(bytes: Uint8Array): Array<{ id: string; text: string }> {
  const section = unzipSync(bytes)['Contents/section0.xml'];
  if (!section) throw new Error('Missing trusted section.');
  const parser = new SaxesParser({ xmlns: true });
  const result: Array<{ id: string; text: string }> = [];
  let active: { id: string; text: string } | null = null;
  let textDepth = 0;
  parser.on('opentag', (tag) => {
    if (tag.uri !== HP) return;
    if (tag.local === 'p') {
      const id = Object.values(tag.attributes).find((attribute) => attribute.uri === '' && attribute.local === 'id')?.value ?? '';
      active = { id, text: '' };
    }
    if (tag.local === 't') textDepth += 1;
    if (active && tag.local === 'tab') active.text += '\t';
    if (active && tag.local === 'lineBreak') active.text += '\n';
  });
  parser.on('text', (text) => { if (active && textDepth) active.text += text; });
  parser.on('cdata', (text) => { if (active && textDepth) active.text += text; });
  parser.on('closetag', (tag) => {
    if (tag.uri !== HP) return;
    if (tag.local === 't') textDepth -= 1;
    if (tag.local === 'p' && active) { result.push(active); active = null; }
  });
  parser.write(decoder.decode(section)).close();
  return result;
}

async function expectSourcePreserved(bytes: Uint8Array, original = fixture): Promise<void> {
  const source = paragraphs(original);
  const generated = paragraphs(bytes).filter((paragraph) => Number(paragraph.id) >= 1000);
  expect(generated).toHaveLength(source.length);
  const byId = [...generated].sort((left, right) => Number(left.id) - Number(right.id));
  expect(byId).toEqual(source.map((paragraph, index) => ({ id: String(1000 + index), text: paragraph.text })));
  const reopened = await inspectHwpx(bytes, 'downloaded-draft.hwpx');
  expect(reopened.report.sectionPaths).toEqual(['Contents/section0.xml']);
  expect(reopened.inspection.tables).toEqual([]);
  expect(reopened.inspection.paragraphs.filter((paragraph) => Number(paragraph.sourceId) >= 1000)).toHaveLength(source.length);
}

test('an offline real Worker generates corrected research roles and preserves the original download and cleanup', async ({ page, context }) => {
  await instrument(page);
  await ready(page);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await context.setOffline(true);
  await select(page);
  await openSection(page, '공식 기준과 준비물');
  await openSection(page, '세부 설정');
  await openSection(page, '문단 배치 확인·수정');
  await expect(page.getByText('전국 공식 자료 확인', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /2026 수업혁신사례연구대회 전국 운영계획 · 교육청 공식 게시본/u }))
    .toHaveAttribute('href', 'https://www.edus.or.kr/web/board/fileDownload/1748.do');
  expect(await page.locator('.draft-source-text').allTextContents()).toEqual(paragraphs(fixture).map((paragraph) => paragraph.text));
  await page.getByLabel('연구 제목', { exact: false }).fill('합성 협력 수업 보고서');
  await page.getByLabel('교과·주제 (선택)', { exact: true }).fill('합성 국어');
  await page.getByLabel('연구 형태 (선택)', { exact: true }).selectOption('joint');
  await page.getByLabel('대상 학년 (선택)', { exact: true }).selectOption('초등학교 5학년');
  await page.getByLabel('대상 학생 수 (선택)', { exact: true }).fill('24');
  await page.getByLabel('문단 2의 배치 항목', { exact: true }).selectOption('appendix');
  await generate(page);
  await openSection(page, '다운로드 후 확인');
  await expect(page.getByText('한글에서 쪽수·서식 검수', { exact: true }).locator('..')).toContainText('미실행');
  await expect(page.getByText('내려받은 파일 저장 확인', { exact: true }).locator('..')).toContainText('미확인');
  const draft = await download(page, '생성한 초안 내려받기');
  expect(draft.name).toBe('수업혁신사례연구대회_작성초안.hwpx');
  await expectSourcePreserved(draft.bytes);
  const output = paragraphs(draft.bytes).filter((paragraph) => Number(paragraph.id) >= 1000);
  expect(output.slice(-2).map((paragraph) => paragraph.id)).toEqual(['1001', '1009']);
  expect(paragraphs(draft.bytes).some((paragraph) => paragraph.text === '합성 협력 수업 보고서')).toBe(true);
  expect(paragraphs(draft.bytes).map((paragraph) => paragraph.text)).toContain('연구형태: 공동연구');
  expect(paragraphs(draft.bytes).map((paragraph) => paragraph.text)).toContain('관리번호: ');
  const original = await download(page, '원본 그대로 내려받기');
  expect(original.bytes).toEqual(fixture);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: '작업 종료', exact: true }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: '보고서·논문 초안 만들기', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => {
    const state = (window as typeof window & { researchHarness: Harness }).researchHarness;
    return state.downloadUrls.length === 2 && state.downloadUrls.every((url) => state.revokedUrls.includes(url));
  })).toBe(true);
  expect(await page.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: (await indexedDB.databases()).map((database) => database.name), caches: await caches.keys() })))
    .toEqual({ local: [], session: [], databases: [], caches: [] });
  expect(requests).toEqual([]);
});

test('editing draft settings invalidates prior generated output while browsing source text keeps it', async ({ page }) => {
  await ready(page);
  await select(page);
  await openSection(page, '세부 설정');
  await openSection(page, '문단 배치 확인·수정');
  await page.getByLabel('연구 제목', { exact: false }).fill('첫 번째 합성 초안');
  await generate(page);
  await page.getByLabel('원문 문단 검색', { exact: true }).fill('연구 결과');
  await expect(page.locator('.draft-paragraph-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toBeVisible();
  await page.getByLabel('원문 문단 검색', { exact: true }).fill('');
  await page.getByLabel('배치 항목 필터', { exact: true }).selectOption('appendix');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toBeVisible();
  await page.getByLabel('배치 항목 필터', { exact: true }).selectOption('all');
  for (const change of [
    () => page.getByLabel('교과·주제 (선택)', { exact: true }).fill('국어'),
    () => page.getByLabel('연구 형태 (선택)', { exact: true }).selectOption('individual'),
    () => page.getByLabel('대상 학년 (선택)', { exact: true }).selectOption('초등학교 6학년'),
    () => page.getByLabel('대상 학생 수 (선택)', { exact: true }).fill('25'),
    () => page.getByLabel('문단 2의 배치 항목', { exact: true }).selectOption('references'),
    () => page.getByLabel('연구 제목', { exact: false }).fill('수정한 합성 초안'),
  ]) {
    await change();
    await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
    await generate(page);
  }
  const competition = await download(page, '생성한 초안 내려받기');
  expect(paragraphs(competition.bytes).map((paragraph) => paragraph.text)).toContain('연구형태: 개인연구');
  await page.getByRole('combobox', { name: '대회 선택', exact: true }).selectOption('paper');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await openSection(page, '공식 기준과 준비물');
  await expect(page.getByText('개인 참고 · 공식 기준 아님', { exact: true })).toBeVisible();
  await generate(page);
  const paper = await download(page, '생성한 초안 내려받기');
  expect(paper.name).toBe('논문_작성초안.hwpx');
  await expectSourcePreserved(paper.bytes);
  const outputText = paragraphs(paper.bytes).map((paragraph) => paragraph.text);
  expect(outputText).toContain('수정한 합성 초안');
  expect(outputText).toContain('초록');
  expect(outputText).toContain('논의와 결론');
  expect(outputText).not.toContain('연구형태: 개인연구');
  expect((await download(page, '원본 그대로 내려받기')).bytes).toEqual(fixture);
});

test('cancelling a real completed draft ignores its late reply and regenerates from the preserved source offline', async ({ page, context }) => {
  await instrument(page);
  await ready(page);
  test.skip(await page.locator('script[src*="@vite/client"]').count() > 0, 'Offline restart requires the production inline Worker bundle.');
  const requests: string[] = [];
  page.on('request', (request) => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  await context.setOffline(true);
  await select(page);
  await openSection(page, '문단 배치 확인·수정');
  await page.getByLabel('연구 제목', { exact: false }).fill('취소 후 합성 초안');
  await page.getByLabel('문단 2의 배치 항목', { exact: true }).selectOption('reflection');
  await page.evaluate(() => { (window as typeof window & { researchHarness: Harness }).researchHarness.holdDrafts = true; });
  await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
  await page.waitForFunction(() => (window as typeof window & { researchHarness: Harness }).researchHarness.heldDrafts === 1);
  await expect(page.getByLabel('연구 제목', { exact: false })).toBeDisabled();
  await page.getByRole('button', { name: '초안 생성 취소', exact: true }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as typeof window & { researchHarness: Harness }).researchHarness;
    state.holdDrafts = false;
    state.releaseDrafts();
  });
  expect(await page.evaluate(() => {
    const buffers = (window as typeof window & { researchHarness: Harness }).researchHarness.heldBuffers;
    return buffers.length === 1 && buffers.every((buffer) => new Uint8Array(buffer).every((byte) => byte === 0));
  })).toBe(true);
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('연구 제목', { exact: false })).toHaveValue('취소 후 합성 초안');
  await expect(page.getByLabel('문단 2의 배치 항목', { exact: true })).toHaveValue('reflection');
  expect((await download(page, '원본 그대로 내려받기')).bytes).toEqual(fixture);
  await generate(page);
  const result = await download(page, '생성한 초안 내려받기');
  await expectSourcePreserved(result.bytes);
  expect(await page.evaluate(() => {
    const state = (window as typeof window & { researchHarness: Harness }).researchHarness;
    return { drafts: state.draftRequests, terminated: state.terminated > 0 };
  })).toEqual({ drafts: 2, terminated: true });
  expect(requests).toEqual([]);
});

test('a document containing a table blocks reconstruction and retains its exact original export', async ({ page }) => {
  const source = Buffer.from(makeResearchFixture({ includeTable: true }));
  await ready(page);
  await select(page, source, '표가있는_합성.hwpx');
  await expect(page.getByRole('heading', { name: '생성할 수 없는 이유', exact: true })).toBeVisible();
  await expect(page.getByText('표가 있는 문서는 초안을 만들 수 없습니다. 표를 포함한 원본 사본은 계속 내려받을 수 있습니다.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  expect((await download(page, '원본 그대로 내려받기')).bytes).toEqual(source);
});

test('help navigation preserves draft settings and binds a completed or pending result to those same settings', async ({ page }) => {
  await instrument(page);
  await ready(page);
  await select(page);
  await openSection(page, '세부 설정');
  await openSection(page, '문단 배치 확인·수정');
  await page.getByLabel('연구 제목', { exact: false }).fill('화면 이동 합성 보고서');
  await page.getByLabel('교과·주제 (선택)', { exact: true }).fill('합성 사회');
  await page.getByLabel('연구 형태 (선택)', { exact: true }).selectOption('joint');
  await page.getByLabel('대상 학년 (선택)', { exact: true }).selectOption('초등학교 4학년');
  await page.getByLabel('대상 학생 수 (선택)', { exact: true }).fill('23');
  await page.getByLabel('문단 1의 배치 항목', { exact: true }).selectOption('results');
  await generate(page);
  const before = await download(page, '생성한 초안 내려받기');
  const help = page.getByRole('navigation', { name: '화면 이동' }).getByRole('link', { name: '지원 범위', exact: true });
  await help.click();
  await expect(page.getByRole('heading', { name: '지원 범위와 처리 방식', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '작업 문서로 돌아가기', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '대회 선택', exact: true })).toHaveValue('innovation');
  await expect(page.getByLabel('연구 제목', { exact: false })).toHaveValue('화면 이동 합성 보고서');
  await expect(page.getByLabel('교과·주제 (선택)', { exact: true })).toHaveValue('합성 사회');
  await expect(page.getByLabel('연구 형태 (선택)', { exact: true })).toHaveValue('joint');
  await expect(page.getByLabel('대상 학년 (선택)', { exact: true })).toHaveValue('초등학교 4학년');
  await expect(page.getByLabel('대상 학생 수 (선택)', { exact: true })).toHaveValue('23');
  await expect(page.getByLabel('문단 1의 배치 항목', { exact: true })).toHaveValue('results');
  expect((await download(page, '생성한 초안 내려받기')).bytes).toEqual(before.bytes);
  expect(await page.evaluate(() => (window as typeof window & { researchHarness: Harness }).researchHarness.draftRequests)).toBe(1);

  await page.getByRole('combobox', { name: '대회 선택', exact: true }).selectOption('paper');
  await expect(page.getByLabel('교과·주제 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('연구 형태 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('대상 학년 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('대상 학생 수 (선택)', { exact: true })).not.toBeVisible();
  await page.getByLabel('문단 1의 배치 항목', { exact: true }).selectOption('results');
  await page.getByLabel('연구 제목', { exact: false }).fill('이동 중 생성한 합성 논문');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as typeof window & { researchHarness: Harness }).researchHarness.holdDrafts = true; });
  await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
  await page.waitForFunction(() => (window as typeof window & { researchHarness: Harness }).researchHarness.heldDrafts === 1);
  await help.click();
  await expect(page.getByRole('heading', { name: '지원 범위와 처리 방식', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as typeof window & { researchHarness: Harness }).researchHarness;
    state.holdDrafts = false;
    state.releaseDrafts();
  });
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '작업 문서로 돌아가기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 HWPX 초안을 만들었습니다.', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '대회 선택', exact: true })).toHaveValue('paper');
  await expect(page.getByLabel('연구 제목', { exact: false })).toHaveValue('이동 중 생성한 합성 논문');
  await expect(page.getByLabel('교과·주제 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('연구 형태 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('대상 학년 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('대상 학생 수 (선택)', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('문단 1의 배치 항목', { exact: true })).toHaveValue('results');
  const after = await download(page, '생성한 초안 내려받기');
  expect(after.name).toBe('논문_작성초안.hwpx');
  await expectSourcePreserved(after.bytes);
  expect(paragraphs(after.bytes).map((paragraph) => paragraph.text)).toContain('이동 중 생성한 합성 논문');
  expect(await page.evaluate(() => (window as typeof window & { researchHarness: Harness }).researchHarness.draftRequests)).toBe(2);
  expect((await download(page, '원본 그대로 내려받기')).bytes).toEqual(fixture);
  await page.getByRole('combobox', { name: '대회 선택', exact: true }).selectOption('innovation');
  await expect(page.getByRole('button', { name: '생성한 초안 내려받기', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('교과·주제 (선택)', { exact: true })).toHaveValue('합성 사회');
  await expect(page.getByLabel('연구 형태 (선택)', { exact: true })).toHaveValue('joint');
  await expect(page.getByLabel('대상 학년 (선택)', { exact: true })).toHaveValue('초등학교 4학년');
  await expect(page.getByLabel('대상 학생 수 (선택)', { exact: true })).toHaveValue('23');
});

test('draft review bounds long paragraph lists and text windows while keeping role editing accessible on narrow screens', async ({ page }) => {
  const entries = unzipSync(fixture);
  const long = '가'.repeat(2999) + '😀' + '긴 합성 원문 끝';
  const texts = [long, ...Array.from({ length: 80 }, (_, index) => `합성 문단 ${index + 2}: 원문 검토`)];
  entries['Contents/section0.xml'] = encoder.encode('<?xml version="1.0" encoding="UTF-8"?>'
    + `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="${HP}">`
    + texts.map((text, index) => `<hp:p id="${index}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`).join('')
    + '</hs:sec>');
  const source = Buffer.from(zipSync(entries, { level: 0 }));
  await ready(page);
  await select(page, source, '긴원문_합성.hwpx');
  await openSection(page, '문단 배치 확인·수정');
  await expect(page.locator('.draft-paragraph-card')).toHaveCount(40);
  await page.getByRole('button', { name: '문단 1 원문 펼치기', exact: true }).click();
  await expect(page.locator('.draft-source-text').first()).toHaveText('가'.repeat(2999));
  await page.getByRole('button', { name: '문단 1 다음 부분', exact: true }).click();
  await expect(page.locator('.draft-source-text').first()).toHaveText('😀긴 합성 원문 끝');
  await page.getByRole('button', { name: '초안 문단 다음 페이지', exact: true }).click();
  await page.getByRole('button', { name: '초안 문단 다음 페이지', exact: true }).click();
  await expect(page.locator('.draft-paragraph-card')).toHaveCount(1);
  const role = page.getByLabel('문단 81의 배치 항목', { exact: true });
  await role.focus();
  await role.press('End');
  await expect(role).toHaveValue('appendix');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await download(page, '원본 그대로 내려받기')).bytes).toEqual(source);
});
