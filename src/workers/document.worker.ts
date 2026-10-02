import { safeError, type ErrorCode } from '../domain/errors';
import { RESOURCE_LIMITS } from '../domain/limits';
import { createInspectionSession } from '../engine/session';
import { createResearchDraft } from '../engine/draft';
import { createPlainTextSource } from '../engine/plain-text';
import {
  isJobId,
  isWorkerRequest,
  createErrorResponse,
  PROTOCOL_VERSION,
  type WorkerResponse,
} from './protocol';

// Keep the Worker boundary explicit without mixing DOM and WebWorker global libs.
interface DocumentWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as DocumentWorkerScope;
let ready = false;
let inspecting = false;

// Reflect only known reason identifiers; parser text never crosses this boundary.
function replyError(code: ErrorCode, jobId?: string, reason?: unknown): void {
  scope.postMessage(createErrorResponse(code, jobId, reason));
}

function extractJobId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const jobId = (value as Record<string, unknown>).jobId;
  return isJobId(jobId) ? jobId : undefined;
}

scope.addEventListener('message', (event) => {
  const request: unknown = event.data;
  if (!isWorkerRequest(request)) {
    replyError('WORKER_FAILED', extractJobId(request));
    return;
  }

  if (request.type === 'INIT') {
    // Static engine imports have completed before this listener can run.
    ready = true;
    scope.postMessage({ type: 'READY', protocolVersion: PROTOCOL_VERSION });
    return;
  }

  if (!ready || inspecting) {
    replyError('WORKER_FAILED', request.jobId);
    return;
  }

  if (request.type !== 'TEXT' && request.bytes.byteLength > RESOURCE_LIMITS.maxInputBytes) {
    replyError('RESOURCE_LIMIT', request.jobId);
    return;
  }

  // The UI transfers a copy. Every inspection owns a local, temporary session;
  // the Worker returns a plain reading model within this tab. Original bytes,
  // file names and hashes stay private; no source XML or cyclic index is sent.
  inspecting = true;
  if (request.type === 'TEXT') {
    let source: Uint8Array<ArrayBuffer> | null = null;
    void createPlainTextSource(request.text)
      .then(async (bytes) => {
        source = bytes;
        const session = await createInspectionSession(bytes, '붙여넣은 글.hwpx');
        const buffer = bytes.buffer;
        scope.postMessage({ type: 'TEXT_READY', protocolVersion: PROTOCOL_VERSION, jobId: request.jobId,
          bytes: buffer, report: session.report, inspection: session.inspection }, [buffer]);
      })
      .catch((error: unknown) => {
        const { code, xmlReason } = safeError(error);
        replyError(code, request.jobId, xmlReason);
      })
      .finally(() => { if (source?.byteLength) source.fill(0); inspecting = false; });
    return;
  }
  if (request.type === 'DRAFT') {
    const input = new Uint8Array(request.bytes);
    void createResearchDraft(input, request.options)
      .then((result) => {
        const bytes = result.bytes.buffer;
        scope.postMessage({ type: 'DRAFT_READY', protocolVersion: PROTOCOL_VERSION, jobId: request.jobId,
          result: { ...result, bytes } }, [bytes]);
      })
      .catch((error: unknown) => {
        const { code, xmlReason } = safeError(error);
        replyError(code, request.jobId, xmlReason);
      })
      .finally(() => { input.fill(0); inspecting = false; });
    return;
  }
  void createInspectionSession(new Uint8Array(request.bytes), request.fileName)
    .then((session) => {
      scope.postMessage({
        type: 'REPORT',
        protocolVersion: PROTOCOL_VERSION,
        jobId: request.jobId,
        report: session.report,
        inspection: session.inspection,
      });
    })
    .catch((error: unknown) => {
      const { code, xmlReason } = safeError(error);
      replyError(code, request.jobId, xmlReason);
    })
    .finally(() => {
      inspecting = false;
    });
});
