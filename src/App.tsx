import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent as ReactDragEvent } from 'react';
import { ERROR_MESSAGES, getErrorMessage, isErrorCode, type ErrorCode } from './domain/errors';
import { RESOURCE_LIMITS } from './domain/limits';
import type { PreflightReport } from './domain/preflight';
import type { DocumentInspection } from './domain/document';
import DocumentInspector from './features/DocumentInspector';
import ResearchDraftPanel from './features/ResearchDraftPanel';
import type { ResearchDraftOptions, ResearchDraftResult } from './domain/research';
import { PROTOCOL_VERSION } from './workers/protocol';
import type { WorkerRequest, WorkerResponse } from './workers/protocol';
import InlineDocumentWorker from './workers/document.worker.ts?worker&inline';
import exampleUrl from '../tests/fixtures/01-plain-text.hwpx?url&inline';

type Route = 'start' | 'workspace' | 'help';
type Readiness = 'preparing' | 'ready' | 'failed';
type Phase = 'idle' | 'reading' | 'checking' | 'drafting';
const PREPARATION_TIMEOUT_MS = 20_000;

interface LocalDocument {
  jobId: string;
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
  example: boolean;
  report: PreflightReport;
  inspection: DocumentInspection;
}

interface PendingDocument {
  jobId: string;
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
  example: boolean;
}

interface Notice {
  code: ErrorCode;
  message: string;
}

function initialLocation(): { route: Route; notice: string | null } {
  if (window.location.hash === '#/help') return { route: 'help', notice: null };
  if (window.location.hash === '#/workspace') {
    return { route: 'start', notice: '새로고침으로 이전 작업이 종료되었습니다. 파일을 다시 선택해 주세요.' };
  }
  const unknown = window.location.hash && window.location.hash !== '#/start';
  return { route: 'start', notice: unknown ? '화면 주소를 확인할 수 없어 시작 화면으로 이동했습니다.' : null };
}

function downloadName(originalName: string): string {
  const fileName = originalName.replace(/\\/g, '/').split('/').at(-1) ?? '';
  const stem = fileName.replace(/\.hwpx$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 100);
  return `${stem || '문서'}_원본사본.hwpx`;
}

function protocolName(originalName: string): string {
  return (originalName.replace(/\\/g, '/').split('/').at(-1) ?? '문서.hwpx')
    .replace(/\u0000/g, '').slice(-255) || '문서.hwpx';
}

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString('ko-KR')} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} MB`;
}

function carriesFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && (Array.from(transfer.types).includes('Files')
    || Array.from(transfer.items).some((item) => item.kind === 'file') || transfer.files.length > 0);
}

async function loadExample(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (exampleUrl.startsWith('data:')) {
    const encoded = exampleUrl.slice(exampleUrl.indexOf(',') + 1);
    const binary = window.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  const response = await fetch(exampleUrl, { signal });
  if (!response.ok) throw new Error('Example unavailable');
  return new Uint8Array(await response.arrayBuffer());
}

function App() {
  const [location] = useState(initialLocation);
  const [route, setRoute] = useState<Route>(location.route);
  const [routeNotice, setRouteNotice] = useState(location.notice);
  const [readiness, setReadiness] = useState<Readiness>('preparing');
  const [phase, setPhase] = useState<Phase>('idle');
  const [document, setDocument] = useState<LocalDocument | null>(null);
  const [error, setError] = useState<Notice | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const [restart, setRestart] = useState(0);
  const [draftResult, setDraftResult] = useState<ResearchDraftResult | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const draftResultRef = useRef<ResearchDraftResult | null>(null);
  const draftPendingRef = useRef<{ jobId: string; sourceJobId: string } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const acceptedRef = useRef<LocalDocument | null>(null);
  const pendingRef = useRef<PendingDocument | null>(null);
  const exampleRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const jobCounter = useRef(0);
  const activeRequestRef = useRef(false);
  const downloadUrls = useRef(new Map<number, string>());
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const busy = phase !== 'idle';
  const canSelect = readiness === 'ready' && !busy;

  function invalidateDraft() {
    draftResultRef.current?.bytes.fill(0);
    draftResultRef.current = null;
    setDraftResult(null);
    setDraftError(null);
  }

  function navigate(nextRoute: Route) {
    window.location.hash = `/${nextRoute}`;
    setRoute(nextRoute);
    setRouteNotice(null);
  }

  useEffect(() => {
    const updateLocation = () => {
      const hash = window.location.hash;
      if (hash === '#/help') setRoute('help');
      else if (hash === '#/workspace' && acceptedRef.current) setRoute('workspace');
      else {
        setRoute('start');
        if (hash === '#/workspace') setRouteNotice('이 화면에 열린 문서가 없습니다. 파일을 선택해 주세요.');
        else if (hash !== '#/start' && hash !== '') setRouteNotice('화면 주소를 확인할 수 없어 시작 화면으로 이동했습니다.');
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/start`);
      }
    };
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/${location.route}`);
    window.addEventListener('hashchange', updateLocation);
    return () => window.removeEventListener('hashchange', updateLocation);
  }, [location.route]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [route]);

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      const handled = event.defaultPrevented;
      event.preventDefault();
      if (event.type === 'drop' && !handled) {
        setRouteNotice('파일 선택 영역에 HWPX 파일 한 개를 끌어 놓거나 ‘HWPX 파일 선택’을 이용해 주세요.');
      }
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let workerReady = false;
    let exampleReady = exampleRef.current !== null;
    const controller = new AbortController();
    let worker: Worker | null = null;
    let preparationTimer: number | null = null;
    setReadiness('preparing');

    const activate = () => {
      if (!stopped && workerReady && exampleReady) {
        if (preparationTimer !== null) window.clearTimeout(preparationTimer);
        setReadiness('ready');
      }
    };
    const fail = () => {
      if (stopped) return;
      stopped = true;
      if (preparationTimer !== null) window.clearTimeout(preparationTimer);
      controller.abort();
      worker?.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      jobCounter.current += 1;
      pendingRef.current?.bytes.fill(0);
      pendingRef.current = null;
      activeRequestRef.current = false;
      if (draftPendingRef.current) setDraftError('초안 생성 기능이 중단되었습니다. 준비를 다시 시도해 주세요.');
      draftPendingRef.current = null;
      setPhase('idle');
      setReadiness('failed');
      setError({ code: 'WORKER_FAILED', message: ERROR_MESSAGES.WORKER_FAILED });
    };

    preparationTimer = window.setTimeout(fail, PREPARATION_TIMEOUT_MS);

    try {
      // Load the deployed Worker path once; restarts use code already received
      // in the app bundle so cancellation and ending work also function offline.
      worker = restart === 0
        ? new Worker(new URL('./workers/document.worker.ts', import.meta.url), { type: 'module' })
        : new InlineDocumentWorker();
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        const discardDraft = () => {
          if (response?.type === 'DRAFT_READY' && response.result?.bytes instanceof ArrayBuffer
            && draftResultRef.current?.bytes.buffer !== response.result.bytes) new Uint8Array(response.result.bytes).fill(0);
        };
        if (stopped || workerRef.current !== worker) { discardDraft(); return; }
        if (!response || response.protocolVersion !== PROTOCOL_VERSION) {
          discardDraft();
          fail();
          return;
        }
        if (response.type === 'READY') {
          workerReady = true;
          activate();
          return;
        }
        if (response.type === 'ERROR' && response.jobId === undefined) {
          fail();
          return;
        }
        const draftPending = draftPendingRef.current;
        if (draftPending && response.jobId === draftPending.jobId) {
          if (acceptedRef.current?.jobId !== draftPending.sourceJobId) { discardDraft(); return; }
          if (response.type === 'DRAFT_READY') {
            const result = { ...response.result, bytes: new Uint8Array(response.result.bytes) };
            draftResultRef.current = result;
            setDraftResult(result);
            setDraftError(null);
          } else if (response.type === 'ERROR') {
            setDraftError('초안이 검증을 통과하지 못했습니다. 원본은 그대로 보관 중입니다. 문단 배치와 지원 범위를 확인해 주세요.');
          } else return;
          draftPendingRef.current = null;
          activeRequestRef.current = false;
          setPhase('idle');
          return;
        }
        const pending = pendingRef.current;
        if (!pending || response.jobId !== pending.jobId) { discardDraft(); return; }
        if (response.type === 'REPORT') {
          const accepted = { ...pending, report: response.report, inspection: response.inspection };
          acceptedRef.current?.bytes.fill(0);
          acceptedRef.current = accepted;
          pendingRef.current = null;
          activeRequestRef.current = false;
          setDocument(accepted);
          invalidateDraft();
          setPhase('idle');
          setError(null);
          setDownloadStatus(null);
          navigate('workspace');
        } else if (response.type === 'ERROR') {
          pending.bytes.fill(0);
          pendingRef.current = null;
          activeRequestRef.current = false;
          setPhase('idle');
          const code = isErrorCode(response.code) ? response.code : 'FILE_INVALID_PACKAGE';
          setError({ code, message: getErrorMessage(code, response.xmlReason) });
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail();
      };
      worker.onmessageerror = fail;
      const init: WorkerRequest = { type: 'INIT', protocolVersion: PROTOCOL_VERSION };
      worker.postMessage(init);
    } catch {
      fail();
    }

    if (!exampleReady && !stopped) {
      void loadExample(controller.signal).then((bytes) => {
        if (stopped) return;
        exampleRef.current = bytes;
        exampleReady = true;
        activate();
      }).catch(() => { if (!stopped) fail(); });
    }
    return () => {
      stopped = true;
      if (preparationTimer !== null) window.clearTimeout(preparationTimer);
      controller.abort();
      worker?.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [restart]);

  useEffect(() => () => {
    acceptedRef.current?.bytes.fill(0);
    pendingRef.current?.bytes.fill(0);
    exampleRef.current?.fill(0);
    draftResultRef.current?.bytes.fill(0);
    for (const [timer, url] of downloadUrls.current) {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    downloadUrls.current.clear();
  }, []);

  function reject(code: ErrorCode, message = ERROR_MESSAGES[code]) {
    setError({ code, message });
  }

  function inspectBytes(bytes: Uint8Array<ArrayBuffer>, name: string, example: boolean, counter: number) {
    const worker = workerRef.current;
    if (!worker || counter !== jobCounter.current) {
      bytes.fill(0);
      return;
    }
    const jobId = `job_${counter}`;
    pendingRef.current = { jobId, bytes, name, example };
    setPhase('checking');
    const copy = bytes.slice().buffer;
    const request: WorkerRequest = {
      type: 'INSPECT', protocolVersion: PROTOCOL_VERSION, jobId, bytes: copy, fileName: protocolName(name),
    };
    try {
      worker.postMessage(request, [copy]);
    } catch {
      pendingRef.current = null;
      activeRequestRef.current = false;
      bytes.fill(0);
      setPhase('idle');
      setReadiness('failed');
      reject('WORKER_FAILED');
      worker.terminate();
      workerRef.current = null;
    }
  }

  async function chooseFile(file: File) {
    if (!canSelect || activeRequestRef.current) return;
    if (file.webkitRelativePath || !/\.hwpx$/i.test(file.name)) {
      reject('FILE_UNSUPPORTED');
      return;
    }
    if (file.size > RESOURCE_LIMITS.maxInputBytes) {
      reject('RESOURCE_LIMIT', '선택한 파일이 25 MB를 넘습니다. 파일을 읽기 전에 검사를 중단했습니다.');
      return;
    }
    if (!confirmReplacement()) return;
    activeRequestRef.current = true;
    setError(null);
    setDownloadStatus(null);
    const counter = ++jobCounter.current;
    setPhase('reading');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (counter !== jobCounter.current) { bytes.fill(0); return; }
      inspectBytes(bytes, file.name, false, counter);
    } catch {
      if (counter !== jobCounter.current) return;
      activeRequestRef.current = false;
      setPhase('idle');
      reject('FILE_INVALID_PACKAGE', '파일을 읽지 못했습니다. 원본 파일은 변경되지 않았습니다.');
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files;
    const file = files?.item(0);
    if (files?.length === 1 && file) void chooseFile(file);
    else if (files?.length) reject('FILE_UNSUPPORTED', '한 번에 HWPX 파일 한 개만 선택해 주세요.');
    event.currentTarget.value = '';
  }

  function onDragOver(event: ReactDragEvent<HTMLElement>) {
    if (carriesFiles(event.dataTransfer)) event.preventDefault();
  }

  function onDrop(event: ReactDragEvent<HTMLElement>) {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!canSelect) return;
    const items = Array.from(event.dataTransfer.items);
    if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      reject('FILE_UNSUPPORTED', '폴더는 열 수 없습니다. HWPX 파일 한 개를 선택해 주세요.');
      return;
    }
    const files = event.dataTransfer.files;
    const file = files.item(0);
    if (files.length !== 1 || !file) {
      reject('FILE_UNSUPPORTED', '한 번에 HWPX 파일 한 개만 선택해 주세요.');
      return;
    }
    void chooseFile(file);
  }

  function chooseExample() {
    if (!canSelect || activeRequestRef.current || !exampleRef.current || !confirmReplacement()) return;
    activeRequestRef.current = true;
    setError(null);
    setDownloadStatus(null);
    const counter = ++jobCounter.current;
    inspectBytes(exampleRef.current.slice(), '합성_예시문서.hwpx', true, counter);
  }

  function confirmReplacement(): boolean {
    return !acceptedRef.current || window.confirm(
      '현재 문서의 사본을 필요한 위치에 저장했는지 확인해 주세요.'
      + '\n새 문서를 검사할까요? 새 파일 검사에 실패하면 현재 문서를 유지합니다.',
    );
  }

  function cancel() {
    jobCounter.current += 1;
    activeRequestRef.current = false;
    workerRef.current?.terminate();
    workerRef.current = null;
    pendingRef.current?.bytes.fill(0);
    pendingRef.current = null;
    if (draftPendingRef.current) setDraftError('초안 생성을 취소했습니다. 원본과 검토한 분류는 유지됩니다.');
    draftPendingRef.current = null;
    setPhase('idle');
    setReadiness('preparing');
    setError(null);
    setRouteNotice('검사를 취소했습니다. 원본 파일은 변경되지 않았습니다.');
    setRestart((value) => value + 1);
  }

  function finish() {
    jobCounter.current += 1;
    activeRequestRef.current = false;
    workerRef.current?.terminate();
    workerRef.current = null;
    acceptedRef.current?.bytes.fill(0);
    pendingRef.current?.bytes.fill(0);
    acceptedRef.current = null;
    pendingRef.current = null;
    draftPendingRef.current = null;
    invalidateDraft();
    setDocument(null);
    setPhase('idle');
    setReadiness('preparing');
    setError(null);
    setDownloadStatus(null);
    for (const [timer, url] of downloadUrls.current) {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    downloadUrls.current.clear();
    navigate('start');
    setRouteNotice('작업을 종료하고 이 화면에 보관한 문서 데이터를 비웠습니다.');
    setRestart((value) => value + 1);
  }

  function download() {
    const accepted = acceptedRef.current;
    if (!accepted || busy || activeRequestRef.current) return;
    const copy = accepted.bytes.slice();
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: 'application/hwp+zip' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName(accepted.name);
    window.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadUrls.current.delete(timer);
    }, 30_000);
    downloadUrls.current.set(timer, url);
    setDownloadStatus('다운로드를 요청했습니다. 저장한 파일은 한글에서 직접 열어 확인해 주세요.');
  }

  function generateDraft(options: ResearchDraftOptions) {
    const accepted = acceptedRef.current;
    const worker = workerRef.current;
    if (!accepted || !worker || !canSelect || activeRequestRef.current) return;
    invalidateDraft();
    const jobId = `draft_${++jobCounter.current}`;
    draftPendingRef.current = { jobId, sourceJobId: accepted.jobId };
    activeRequestRef.current = true;
    setPhase('drafting');
    const copy = accepted.bytes.slice().buffer;
    const request: WorkerRequest = { type: 'DRAFT', protocolVersion: PROTOCOL_VERSION, jobId, bytes: copy, options };
    try {
      worker.postMessage(request, [copy]);
    } catch {
      draftPendingRef.current = null;
      activeRequestRef.current = false;
      setPhase('idle');
      setDraftError('초안 생성 기능을 시작하지 못했습니다. 준비를 다시 시도해 주세요.');
      setReadiness('failed');
      worker.terminate();
      workerRef.current = null;
    }
  }

  function downloadDraft() {
    const result = draftResultRef.current;
    if (!result || busy || activeRequestRef.current) return;
    const url = URL.createObjectURL(new Blob([result.bytes.slice().buffer], { type: 'application/hwp+zip' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = result.kind === 'competition' ? '수업혁신사례연구대회_작성초안.hwpx' : '논문_작성초안.hwpx';
    window.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const timer = window.setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(timer); }, 30_000);
    downloadUrls.current.set(timer, url);
  }

  const readinessText = readiness === 'ready' ? '로컬 검사 준비 완료' : readiness === 'preparing' ? '검사 기능 준비 중' : '검사 기능 준비 실패';
  const picker = (
    <label className={`button primary file-button ${!canSelect ? 'disabled' : ''}`}>
      <span>HWPX 파일 선택</span>
      <input className="visually-hidden" type="file" accept=".hwpx" aria-label="HWPX 파일 선택" disabled={!canSelect} onChange={onFileChange} />
    </label>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); window.document.getElementById('main')?.focus(); }}>본문으로 바로가기</a>
      <header className="site-header">
        <a className="brand" href="#/start" aria-label="한글 마감실 시작 화면"><span className="brand-mark" aria-hidden="true">한</span><span>한글 마감실</span></a>
        <nav aria-label="화면 이동">
          <a href="#/start" aria-current={route === 'start' ? 'page' : undefined}>시작</a>
          {document && <a href="#/workspace" aria-current={route === 'workspace' ? 'page' : undefined}>작업 문서</a>}
          <a href="#/help" aria-current={route === 'help' ? 'page' : undefined}>지원 범위</a>
        </nav>
        <span className="version-tag">검사·초안 시험판</span>
      </header>

      <main id="main" tabIndex={-1} className={`main-content ${route === 'workspace' ? 'workspace-content' : ''}`}>
        <div className="status-line" role="status" aria-live="polite"><span className={`status-dot ${readiness}`} aria-hidden="true" />{readinessText}<span className="status-divider" aria-hidden="true">·</span><span>문서는 이 브라우저 안에서 처리합니다</span></div>
        {routeNotice && <p className="notice" role="status">{routeNotice}</p>}
        {error && <div className="error-notice" role="alert"><strong>{error.message}</strong><span>오류 코드: {error.code}. {document ? '이번 파일의 검사는 완료되지 않았습니다. 이전에 확인한 문서는 작업 화면에 그대로 보관 중입니다.' : '원본 파일은 변경되지 않았습니다.'}</span></div>}
        {readiness === 'failed' && <div className="recovery-actions"><button className="button secondary" onClick={() => { setError(null); setReadiness('preparing'); setRestart((value) => value + 1); }}>준비 다시 시도</button><a href="#/help">도움말 보기</a></div>}
        {busy && phase !== 'drafting' && <div className="processing" role="status"><span className="spinner" aria-hidden="true" /><div><strong>{phase === 'reading' ? '파일을 메모리에서 읽고 있습니다' : 'HWPX 패키지와 XML을 검사하고 있습니다'}</strong><p>진행 중에는 새 파일을 선택할 수 없습니다.</p></div><button className="button secondary" onClick={cancel}>검사 취소</button></div>}

        {route === 'start' && <>
          <section className="hero">
            <div className="hero-copy"><p className="eyebrow">HWPX 사전 검사</p><h1 ref={headingRef} tabIndex={-1}>원본을 지키는<br />첫 번째 확인.</h1><p className="hero-description">파일 구조를 확인하고 줄글을 보고서 초안으로 정리하세요.<br />원본은 그대로 두고 새 HWPX 문서를 만듭니다.</p><div className="scope-tags"><span>보고서·논문 초안</span><span>원본 그대로 보관</span><span>로그인 없이</span></div></div>
            <div className="file-card" onDragOver={onDragOver} onDrop={onDrop} aria-label="HWPX 파일 가져오기">
              <div className="file-illustration" aria-hidden="true"><span className="paper-label">HWPX</span><i /><i /><i /><span className="paper-check">✓</span></div>
              <h2>확인할 문서를 가져오세요</h2><p>HWPX 파일 한 개 · 최대 25 MB<br />이곳에 파일을 끌어 놓아도 됩니다.</p>{picker}<button className="example-button" onClick={chooseExample} disabled={!canSelect}>예시 문서로 체험 <span aria-hidden="true">↗</span></button><p className="example-caption">실제 학생 정보가 없는 합성 예시입니다.</p>
            </div>
          </section>
          <section className="principles" aria-label="처리 원칙">
            <article><span className="principle-number">01</span><h2>문서는 외부로 보내지 않아요</h2><p>파일 내용은 브라우저 메모리에서 처리합니다. 원문·파일명·문서 해시를 지속 저장하지 않습니다.</p></article>
            <article><span className="principle-number">02</span><h2>줄글을 보고서 초안으로</h2><p>원문 문단을 연구대회 보고서나 논문 구성으로 자동 분류합니다. 배치를 검토한 뒤 서식을 적용한 새 HWPX 초안을 내려받으세요.</p></article>
            <article><span className="principle-number">03</span><h2>마지막 확인은 한글에서</h2><p>사전 검사 성공은 실제 한글 조판 검증을 뜻하지 않습니다. 저장한 문서를 한글에서 열어 확인해 주세요.</p></article>
          </section>
        </>}

        {route === 'workspace' && document && <>
          <section className="workspace-heading"><div><p className="eyebrow">문서 작업 · 사전 검사</p><h1 ref={headingRef} tabIndex={-1}>파일 구조를 확인했습니다.</h1><p>확인된 원본 바이트를 이 화면의 메모리에 보관 중입니다.</p></div><button className="button text-button" onClick={finish}>작업 종료 <span aria-hidden="true">↗</span></button></section>
          <div className="workspace-grid">
            <section className="document-summary panel"><div className="panel-heading"><span className="small-file-icon" aria-hidden="true">H</span><div><div className="inline-badges"><span className="badge">검사 전용</span>{document.example && <span className="badge example-badge">예시 문서</span>}</div><h2>{document.name}</h2><p>{readableBytes(document.bytes.byteLength)} · HWPX</p></div></div><div className="report-heading"><h3>패키지 검사 결과</h3><span className="check-label">사전 검사 완료</span></div><dl className="report-grid"><div><dt>패키지 항목</dt><dd>{document.report.entryCount.toLocaleString('ko-KR')}<small>개</small></dd></div><div><dt>XML 파일</dt><dd>{document.report.xmlCount.toLocaleString('ko-KR')}<small>개</small></dd></div><div><dt>선언된 구역</dt><dd>{document.report.sectionPaths.length.toLocaleString('ko-KR')}<small>개</small></dd></div><div><dt>해제 후 크기</dt><dd className="size-value">{readableBytes(document.report.uncompressedBytes)}</dd></div></dl><div className="format-row"><span>파일 형식 버전</span><strong>{document.report.formatVersion}</strong></div><details className="section-details"><summary>패키지에 선언된 구역 경로</summary><ul>{document.report.sectionPaths.map((path) => <li key={path}>{path}</li>)}</ul></details><p className="muted-note">문단·표의 내용과 읽을 수 있는 서식은 아래 문서 구조 보기에서 확인하세요.</p></section>
            <aside className="save-panel panel"><p className="eyebrow">원본 그대로 내보내기</p><h2>바꾸지 않은 사본을<br />내려받습니다.</h2><p>입력 파일과 동일한 바이트로 새 파일을 만듭니다. 서식이나 내용은 수정하지 않습니다.</p><div className="verification-row"><span>패키지 사전 검사</span><strong>완료</strong></div><div className="verification-row"><span>한글 화면 검수</span><strong className="unverified">미실행</strong></div><button className="button primary download-button" onClick={download} disabled={busy}>원본 그대로 내려받기 <span aria-hidden="true">↓</span></button><p className="muted-note">파일명에 ‘_원본사본’을 붙여 저장합니다.</p>{downloadStatus && <p className="download-status" role="status">{downloadStatus}</p>}<div className="replace-file" onDragOver={onDragOver} onDrop={onDrop} aria-label="새 HWPX 파일 가져오기"><p>다른 문서의 구조를 확인하려면</p>{picker}<p className="muted-note">이곳에 HWPX 한 개를 끌어 놓을 수 있습니다. 새 파일 검사에 실패하면 현재 문서를 유지합니다.</p></div></aside>
          </div>
        </>}
        {document && <div hidden={route !== 'workspace'}>
          <ResearchDraftPanel key={`draft-${document.jobId}`} inspection={document.inspection}
            disabled={readiness !== 'ready' || (busy && phase !== 'drafting')} generating={phase === 'drafting'}
            onGenerate={generateDraft} onCancel={cancel} result={draftResult} error={draftError}
            onDownload={downloadDraft} onInvalidate={invalidateDraft} />
        </div>}
        {route === 'workspace' && document && <DocumentInspector key={document.jobId} inspection={document.inspection} />}

        {route === 'help' && <section className="help-content"><p className="eyebrow">사용 전 확인</p><h1 ref={headingRef} tabIndex={-1}>지원 범위와 처리 방식</h1><p className="help-lead">HWPX를 검사하고 줄글을 보고서·논문 구성으로 분류해 별도의 작성 초안을 만드는 시험판입니다. HWP 파일은 한글에서 HWPX로 저장한 뒤 선택해 주세요.</p><div className="help-grid"><article className="panel"><h2>현재 할 수 있는 작업</h2><ul><li>25 MB 이하 HWPX 한 개 선택 또는 드래그 앤 드롭</li><li>ZIP 구조·XML 안전성·자원 한도 사전 검사</li><li>실제 패키지 항목·XML·구역 수와 형식 버전 확인</li><li>선언 순서에 따른 문단·표 내용과 글꼴·크기·문단 서식 참조 탐색</li><li>병합·중첩 표와 확인할 수 없는 서식의 사유 확인</li><li>원문 문단의 자동 분류·배치 검토와 보고서·논문 HWPX 초안 생성</li><li>생성한 초안의 파일 구조·원문 텍스트 보존 재검사</li><li>검사한 입력 바이트와 동일한 HWPX 사본 다운로드</li></ul></article><article className="panel"><h2>아직 제공하지 않는 작업</h2><ul><li>HWP·PDF 변환, 암호화 파일 처리</li><li>업로드 원본의 자동 교정, 표·그림·각주가 포함된 초안 생성</li><li>원문에 없는 연구 결과 작성, 전국대회 최종 제출 적합성 인증</li><li>문서 미리보기와 실제 한글 쪽 배치 검증</li><li>새로고침 뒤 문서 복원, 오프라인 재접속</li></ul></article></div><article className="privacy-help panel"><h2>문서 데이터는 열린 화면에만 남습니다</h2><p>앱과 예시·Worker를 준비한 뒤에는 파일 검사와 다운로드에 네트워크가 필요하지 않습니다. 선택한 문서를 외부로 전송하거나 지속 저장소에 기록하지 않습니다.</p><p>‘작업 종료’는 화면의 문서 데이터를 비웁니다. 새로고침하거나 탭을 닫으면 작업이 끝나므로 필요한 사본을 먼저 내려받아 주세요. 다운로드 요청은 실제 저장·한글 검수 확인과 구분됩니다.</p></article><a className="button secondary" href={document ? '#/workspace' : '#/start'}>{document ? '작업 문서로 돌아가기' : '시작 화면으로 돌아가기'}</a></section>}
      </main>
      <footer className="site-footer"><span>한글 마감실</span><p>원본은 그대로, 확인한 범위만 안내합니다.</p><span data-build-commit={__BUILD_COMMIT__} title={`빌드 ${__BUILD_COMMIT__}`}>빌드 {__BUILD_COMMIT__ === 'development' ? '개발' : __BUILD_COMMIT__.slice(0, 7)}</span><a href="#/help">지원 범위 및 개인정보</a></footer>
    </div>
  );
}

export default App;
