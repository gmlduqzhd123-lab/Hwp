import { safeError, type ErrorCode } from '../domain/errors';
import { RESOURCE_LIMITS } from '../domain/limits';
import { createDocumentSession } from '../engine/session';
import {
  isJobId,
  isWorkerRequest,
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

// Parser details can contain untrusted XML, paths, or file names. Never relay them.
const errorMessages: Record<ErrorCode, string> = {
  FILE_UNSUPPORTED: '현재 지원 범위의 HWPX 파일만 검사할 수 있습니다. HWP·PDF 변환과 실행 가능 개체는 지원하지 않습니다.',
  FILE_INVALID_PACKAGE: '파일 구조를 확인하지 못했습니다. 원본은 변경되지 않았습니다.',
  FILE_ENCRYPTED: '암호화된 파일은 검사할 수 없습니다. 원본은 변경되지 않았습니다.',
  RESOURCE_LIMIT: '파일이 안전한 처리 한도를 초과했습니다. 원본은 변경되지 않았습니다.',
  XML_UNSUPPORTED: '안전하게 읽을 수 없는 XML 구조입니다. 원본은 변경되지 않았습니다.',
  WORKER_FAILED: '문서 검사 준비에 문제가 발생했습니다. 다시 시도해 주세요.',
};

function replyError(code: ErrorCode, jobId?: string): void {
  scope.postMessage({
    type: 'ERROR',
    protocolVersion: PROTOCOL_VERSION,
    ...(jobId === undefined ? {} : { jobId }),
    code,
    message: errorMessages[code],
  });
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
      replyError(safeError(error).code, request.jobId);
    })
    .finally(() => {
      inspecting = false;
    });
});
