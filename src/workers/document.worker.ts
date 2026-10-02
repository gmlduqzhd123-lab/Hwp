import { safeError, type ErrorCode } from '../domain/errors';
import { RESOURCE_LIMITS } from '../domain/limits';
import { createDocumentSession } from '../engine/session';
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
  postMessage(message: WorkerResponse): void;
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

  if (request.bytes.byteLength > RESOURCE_LIMITS.maxInputBytes) {
    replyError('RESOURCE_LIMIT', request.jobId);
    return;
  }

  // The UI transfers a copy. Every inspection owns a local, temporary session;
  // the Worker never sends source bytes, document text, file names, or hashes.
  inspecting = true;
  void createDocumentSession(new Uint8Array(request.bytes), request.fileName)
    .then((session) => {
      scope.postMessage({
        type: 'REPORT',
        protocolVersion: PROTOCOL_VERSION,
        jobId: request.jobId,
        report: session.report,
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
