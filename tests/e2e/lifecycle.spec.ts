import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const firstFixture = await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url));
const nextFixture = await readFile(new URL('../fixtures/02-alternate-prefixes.hwpx', import.meta.url));

interface Harness {
  suppressInit: boolean;
  holdReports: boolean;
  heldReportCount: number;
  releaseReports: () => void;
  deferredRead: boolean;
  releaseRead?: () => void;
  releasedBuffer?: ArrayBuffer;
  inspectionCount: number;
  terminatedCount: number;
  workerUrls: string[];
  createdUrls: string[];
  downloadUrls: string[];
  revokedUrls: string[];
}

async function instrument(page: Page, suppressInit = false) {
  await page.addInitScript((initiallySuppressInit) => {
    const host = window as typeof window & { lifecycleHarness: Harness };
    const reports: Array<() => void> = [];
    host.lifecycleHarness = {
      suppressInit: initiallySuppressInit, holdReports: false, heldReportCount: 0, deferredRead: false,
      inspectionCount: 0, terminatedCount: 0, workerUrls: [], createdUrls: [], downloadUrls: [], revokedUrls: [],
      releaseReports: () => { for (const release of reports.splice(0)) release(); host.lifecycleHarness.heldReportCount = 0; },
    };
    const state = host.lifecycleHarness;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        state.workerUrls.push(String(url));
        this.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
          if (!state.holdReports || event.data.type !== 'REPORT') return;
          event.stopImmediatePropagation();
          state.heldReportCount += 1;
          reports.push(() => this.onmessage?.call(this, event));
        });
      }
      override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        const type = (message as { type?: string }).type;
        if (type === 'INIT' && state.suppressInit) return;
        if (type === 'INSPECT') state.inspectionCount += 1;
        super.postMessage(message, transferOrOptions as Transferable[]);
      }
      override terminate() {
        state.terminatedCount += 1;
        super.terminate();
      }
    };
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      const buffer = await read.call(this);
      if (!state.deferredRead) return buffer;
      state.deferredRead = false;
      return new Promise<ArrayBuffer>((resolve) => {
        state.releaseRead = () => {
          state.releasedBuffer = buffer;
          resolve(buffer);
        };
      });
    };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      state.createdUrls.push(url);
      if (blob instanceof Blob && blob.type === 'application/hwp+zip') state.downloadUrls.push(url);
      return url;
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { state.revokedUrls.push(url); revoke(url); };
  }, suppressInit);
}

async function openSection(page: Page, label: string): Promise<void> {
  const details = page.locator('details').filter({ has: page.getByText(label, { exact: true }) });
  await expect(details).toHaveCount(1);
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

async function ready(page: Page) {
  await page.goto('./#/start');
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
}

async function select(page: Page, name: string, buffer = firstFixture) {
  await page.getByLabel('HWPX 파일 선택', { exact: true }).setInputFiles({ name, buffer, mimeType: 'application/hwp+zip' });
}

async function savedBytes(page: Page) {
  const requested = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 그대로 내려받기' }).click();
  const download = await requested;
  const path = await download.path();
  if (!path) throw new Error('No downloaded HWPX.');
  return readFile(path);
}

test('replacing a document asks about saving and dismissal retains the current original', async ({ page }) => {
  await ready(page);
  await select(page, '첫문서.hwpx');
  await expect(page.getByRole('heading', { name: '첫문서.hwpx' })).toBeVisible();
  const dismissed = page.waitForEvent('dialog');
  const attempted = select(page, '다음문서.hwpx', nextFixture);
  const dialog = await dismissed;
  expect(dialog.message()).toContain('저장했는지 확인');
  await dialog.dismiss();
  await attempted;
  await expect(page.getByRole('heading', { name: '첫문서.hwpx' })).toBeVisible();
  expect(await savedBytes(page)).toEqual(firstFixture);
  page.once('dialog', (nextDialog) => nextDialog.accept());
  await select(page, '다음문서.hwpx', nextFixture);
  await expect(page.getByRole('heading', { name: '다음문서.hwpx' })).toBeVisible();
  expect(await savedBytes(page)).toEqual(nextFixture);
});

test('cancelling an unresolved file read discards late bytes and keeps the previously accepted document', async ({ page }) => {
  await instrument(page);
  await ready(page);
  await select(page, '이전문서.hwpx');
  await expect(page.getByRole('heading', { name: '이전문서.hwpx' })).toBeVisible();
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.deferredRead = true; });
  page.once('dialog', (dialog) => dialog.accept());
  await select(page, '지연읽기.hwpx', nextFixture);
  await page.waitForFunction(() => !!(window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.releaseRead);
  await expect(page.getByText('파일을 메모리에서 읽고 있습니다')).toBeVisible();
  await page.getByRole('button', { name: '검사 취소' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.releaseRead?.(); });
  await page.waitForFunction(() => {
    const buffer = (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.releasedBuffer;
    return buffer && new Uint8Array(buffer).every((byte) => byte === 0);
  });
  await expect(page.getByRole('heading', { name: '지연읽기.hwpx' })).toHaveCount(0);
  expect(await savedBytes(page)).toEqual(firstFixture);
  expect(await page.evaluate(() => (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.inspectionCount)).toBe(1);
});

test('late real Worker reports cannot restore a cancelled or ended document', async ({ page }) => {
  await instrument(page);
  await ready(page);
  await select(page, '유지문서.hwpx');
  await expect(page.getByRole('heading', { name: '유지문서.hwpx' })).toBeVisible();
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.holdReports = true; });
  page.once('dialog', (dialog) => dialog.accept());
  await select(page, '늦은결과.hwpx', nextFixture);
  await expect(page.getByRole('button', { name: '검사 취소' })).toBeVisible();
  // Wait for the real engine to post its result before cancelling its UI job.
  await page.waitForFunction(() => {
    const state = (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness;
    return state.heldReportCount === 1;
  });
  await page.getByRole('button', { name: '검사 취소' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.releaseReports(); });
  await expect(page.getByRole('heading', { name: '유지문서.hwpx' })).toBeVisible();
  expect(await savedBytes(page)).toEqual(firstFixture);
  page.once('dialog', (dialog) => dialog.accept());
  await select(page, '종료후결과.hwpx', nextFixture);
  await page.waitForFunction(() => (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.heldReportCount === 1);
  await page.getByRole('button', { name: '작업 종료' }).click();
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.releaseReports(); });
  await expect(page).toHaveURL(/#\/start$/);
  await expect(page.getByRole('button', { name: '원본 그대로 내려받기' })).toHaveCount(0);
});

test('a silent Worker readiness hang times out, keeps input disabled and recovers on retry', async ({ page }) => {
  await instrument(page, true);
  await page.clock.install();
  await page.goto('./#/start');
  await expect(page.getByLabel('HWPX 파일 선택', { exact: true })).toBeDisabled();
  await page.clock.runFor(20_001);
  await expect(page.getByRole('alert')).toContainText('WORKER_FAILED');
  await expect(page.getByLabel('HWPX 파일 선택', { exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.suppressInit = false; });
  await page.getByRole('button', { name: '준비 다시 시도' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '예시 문서로 체험' }).click();
  await openSection(page, '문서 검사 상세');
});

test('ending work revokes download URLs and navigation cannot recover the ended document', async ({ page }) => {
  await instrument(page);
  await ready(page);
  await select(page, '정리문서.hwpx');
  await expect(page.getByRole('heading', { name: '정리문서.hwpx' })).toBeVisible();
  expect(await savedBytes(page)).toEqual(firstFixture);
  const before = await page.evaluate(() => (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.terminatedCount);
  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  const state = await page.evaluate(() => {
    const harness = (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness;
    return { downloads: harness.downloadUrls, revoked: harness.revokedUrls, terminated: harness.terminatedCount };
  });
  // Inline Worker code revokes its own Blob URL in the Worker global scope;
  // this window-side observer owns only the document download lifecycle.
  expect(state.downloads.length).toBeGreaterThan(0);
  expect(state.revoked).toEqual(expect.arrayContaining(state.downloads));
  expect(state.terminated).toBeGreaterThan(before);
  await page.goBack();
  await expect(page).toHaveURL(/#\/start$/);
  await expect(page.getByRole('button', { name: '원본 그대로 내려받기' })).toHaveCount(0);
});

test('file drops outside the picker prevent navigation and workspace replacement uses the same confirmation', async ({ page }) => {
  await ready(page);
  await select(page, '드롭이전.hwpx');
  await expect(page.getByRole('heading', { name: '드롭이전.hwpx' })).toBeVisible();
  const outsidePrevented = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['synthetic'], '드롭.hwpx'));
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    window.document.querySelector('main')?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(outsidePrevented).toBe(true);
  await expect(page.getByText('파일 선택 영역에 HWPX 파일 한 개를', { exact: false })).toBeVisible();
  const linkPrevented = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/uri-list', 'https://example.invalid/');
    const event = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
    window.document.querySelector('main')?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(linkPrevented).toBe(false);
  const accepted = page.waitForEvent('dialog');
  const dropped = page.evaluate((bytes: number[]) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], '드롭새문서.hwpx', { type: 'application/hwp+zip' }));
    const picker = window.document.querySelector('[aria-label="새 HWPX 파일 가져오기"]');
    if (!picker) throw new Error('No workspace replacement drop target.');
    picker.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, Array.from(nextFixture));
  await (await accepted).accept();
  await dropped;
  await expect(page.getByRole('heading', { name: '드롭새문서.hwpx' })).toBeVisible();
  expect(await savedBytes(page)).toEqual(nextFixture);
});

test('keyboard picker opens and narrow zoomed layout keeps core actions within the viewport', async ({ page }) => {
  await ready(page);
  const picker = page.getByLabel('HWPX 파일 선택', { exact: true });
  await picker.focus();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: '키보드문서.hwpx', mimeType: 'application/hwp+zip', buffer: firstFixture });
  await expect(page.getByRole('heading', { name: '키보드문서.hwpx' })).toBeVisible();
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => { window.document.documentElement.style.zoom = '2'; });
  const bounds = await page.evaluate(() => ({ width: window.innerWidth, scroll: window.document.documentElement.scrollWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  const download = page.getByRole('button', { name: '원본 그대로 내려받기' });
  await download.scrollIntoViewIfNeeded();
  await expect(download).toBeVisible();
  expect(await savedBytes(page)).toEqual(firstFixture);
});

test('the real Worker bounds overlapping inspection requests during delayed hashing and accepts the next job', async ({ page }) => {
  await instrument(page);
  await ready(page);
  const workerUrl = await page.evaluate(() => (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.workerUrls.at(-1));
  if (!workerUrl) throw new Error('No initialized Worker URL.');
  // Preserve real crypto and engine output; delay hashing so the second message
  // arrives while the first asynchronous inspection still owns the Worker.
  await page.route(workerUrl, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const delay = 'const lifecycleDigest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=(...args)=>new Promise((resolve,reject)=>setTimeout(()=>lifecycleDigest(...args).then(resolve,reject),100));\n';
    await route.fulfill({ response, body: delay + body });
  });
  const responses = await page.evaluate(async (bytes: number[]) => {
    const workerUrl = (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.workerUrls.at(-1);
    if (!workerUrl) throw new Error('No initialized Worker URL.');
    const worker = new Worker(workerUrl, { type: 'module' });
    const result: Array<{ type: string; jobId?: string; code?: string }> = [];
    try {
      await new Promise<void>((resolve) => {
        worker.onmessage = (event: MessageEvent<{ type: string }>) => { if (event.data.type === 'READY') resolve(); };
        worker.postMessage({ type: 'INIT', protocolVersion: 2 });
      });
      await new Promise<void>((resolve) => {
        worker.onmessage = (event: MessageEvent<{ type: string; jobId?: string; code?: string }>) => {
          result.push({ type: event.data.type, jobId: event.data.jobId, code: event.data.code });
          if (result.length === 2) resolve();
        };
        const first = new Uint8Array(bytes).buffer;
        const second = new Uint8Array(bytes).buffer;
        worker.postMessage({ type: 'INSPECT', protocolVersion: 2, jobId: 'first', fileName: 'one.hwpx', bytes: first }, [first]);
        worker.postMessage({ type: 'INSPECT', protocolVersion: 2, jobId: 'overlap', fileName: 'two.hwpx', bytes: second }, [second]);
      });
      await new Promise<void>((resolve) => {
        worker.onmessage = (event: MessageEvent<{ type: string; jobId?: string; code?: string }>) => {
          result.push({ type: event.data.type, jobId: event.data.jobId, code: event.data.code });
          resolve();
        };
        const next = new Uint8Array(bytes).buffer;
        worker.postMessage({ type: 'INSPECT', protocolVersion: 2, jobId: 'sequential', fileName: 'next.hwpx', bytes: next }, [next]);
      });
      return result;
    } finally { worker.terminate(); }
  }, Array.from(firstFixture));
  expect(responses).toContainEqual({ type: 'ERROR', jobId: 'overlap', code: 'WORKER_FAILED' });
  expect(responses).toContainEqual({ type: 'REPORT', jobId: 'first', code: undefined });
  expect(responses.at(-1)).toEqual({ type: 'REPORT', jobId: 'sequential', code: undefined });
});

test('prepared production resources can restart after ending and cancelling work offline without network requests', async ({ page, context }) => {
  // Vite development inline workers import source modules over HTTP. Production
  // bundles their complete code in the application before readiness.
  await instrument(page);
  await ready(page);
  test.skip(await page.locator('script[src*="/@vite/client"]').count() > 0, 'Production bundle required for offline Worker restart.');
  const requests: string[] = [];
  page.on('request', (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await context.setOffline(true);
  await page.getByRole('button', { name: '예시 문서로 체험' }).click();
  await openSection(page, '문서 검사 상세');
  await page.getByRole('button', { name: '작업 종료' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await select(page, '오프라인원본.hwpx');
  await expect(page.getByRole('heading', { name: '오프라인원본.hwpx' })).toBeVisible();
  expect(await savedBytes(page)).toEqual(firstFixture);
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.holdReports = true; });
  page.once('dialog', (dialog) => dialog.accept());
  await select(page, '오프라인지연.hwpx', nextFixture);
  await page.waitForFunction(() => (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.heldReportCount === 1);
  await page.getByRole('button', { name: '검사 취소' }).click();
  await expect(page.getByText('로컬 검사 준비 완료', { exact: false })).toBeVisible();
  await page.evaluate(() => { (window as typeof window & { lifecycleHarness: Harness }).lifecycleHarness.releaseReports(); });
  await expect(page.getByRole('heading', { name: '오프라인원본.hwpx' })).toBeVisible();
  expect(await savedBytes(page)).toEqual(firstFixture);
  expect(requests).toEqual([]);
});
