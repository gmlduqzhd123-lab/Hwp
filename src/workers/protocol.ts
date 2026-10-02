import type { ErrorCode } from '../domain/errors';
import type { PreflightReport } from '../domain/preflight';

export const PROTOCOL_VERSION = 1 as const;

export interface InitRequest {
  type: 'INIT';
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface InspectRequest {
  type: 'INSPECT';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  bytes: ArrayBuffer;
  fileName: string;
}

export type WorkerRequest = InitRequest | InspectRequest;

export interface ReadyResponse {
  type: 'READY';
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface ReportResponse {
  type: 'REPORT';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  report: PreflightReport;
}

export interface ErrorResponse {
  type: 'ERROR';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId?: string;
  code: ErrorCode;
  message: string;
}

export type WorkerResponse = ReadyResponse | ReportResponse | ErrorResponse;

/** Only bounded opaque IDs may be reflected in a response. */
export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (request.protocolVersion !== PROTOCOL_VERSION) return false;
  if (request.type === 'INIT') return true;
  return request.type === 'INSPECT'
    && isJobId(request.jobId)
    && request.bytes instanceof ArrayBuffer
    && typeof request.fileName === 'string'
    && request.fileName.length > 0
    && request.fileName.length <= 255
    && !request.fileName.includes('\0');
}
