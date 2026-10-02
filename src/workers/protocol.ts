import { getErrorMessage, isErrorCode, isXmlUnsupportedReason, type ErrorCode, type XmlUnsupportedReason } from '../domain/errors';
import type { PreflightReport } from '../domain/preflight';
import type { DocumentInspection } from '../domain/document';
import { DRAFT_LIMITS, isResearchDraftOptions, type ResearchDraftOptions, type ResearchDraftResult } from '../domain/research';
import { RESOURCE_LIMITS } from '../domain/limits';

export const PROTOCOL_VERSION = 2 as const;

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

export interface DraftRequest {
  type: 'DRAFT';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  bytes: ArrayBuffer;
  options: ResearchDraftOptions;
}

export type WorkerRequest = InitRequest | InspectRequest | DraftRequest;

export interface ReadyResponse {
  type: 'READY';
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface ReportResponse {
  type: 'REPORT';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  report: PreflightReport;
  inspection: DocumentInspection;
}

export interface ErrorResponse {
  type: 'ERROR';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId?: string;
  code: ErrorCode;
  message: string;
  xmlReason?: XmlUnsupportedReason;
}

export interface DraftResponse {
  type: 'DRAFT_READY';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  result: Omit<ResearchDraftResult, 'bytes'> & { bytes: ArrayBuffer };
}

export type WorkerResponse = ReadyResponse | ReportResponse | DraftResponse | ErrorResponse;

/** Reject incomplete, oversized or inconsistent result envelopes before the UI uses them. */
export function isDraftResponseResult(value: unknown): value is DraftResponse['result'] {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (!(result.bytes instanceof ArrayBuffer) || result.bytes.byteLength === 0 || result.bytes.byteLength > RESOURCE_LIMITS.maxInputBytes
    || result.kind !== 'competition' && result.kind !== 'paper'
    || result.packageVerified !== true || result.originalTextVerified !== true || result.manualValidation !== 'NOT_RUN'
    || !Number.isInteger(result.sourceParagraphCount) || Number(result.sourceParagraphCount) < 1 || Number(result.sourceParagraphCount) > DRAFT_LIMITS.maxParagraphs
    || !Number.isInteger(result.outputParagraphCount) || Number(result.outputParagraphCount) < 1 || Number(result.outputParagraphCount) > DRAFT_LIMITS.maxParagraphs + 500) return false;
  if (result.profileId !== undefined && (typeof result.profileId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(result.profileId))
    || result.profileLabel !== undefined && (typeof result.profileLabel !== 'string' || result.profileLabel.length === 0 || result.profileLabel.length > 200)
    || result.profileYear !== undefined && (!Number.isInteger(result.profileYear) || Number(result.profileYear) < 2000 || Number(result.profileYear) > 2100)
    || result.profileVersion !== undefined && (typeof result.profileVersion !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/u.test(result.profileVersion))
    || result.addedParagraphCount !== undefined && (!Number.isInteger(result.addedParagraphCount) || Number(result.addedParagraphCount) < 0 || Number(result.addedParagraphCount) > 8)
    || result.sourceSelection !== undefined && result.sourceSelection !== 'all' && result.sourceSelection !== 'summary-selection') return false;
  for (const key of ['includedParagraphCount', 'excludedParagraphCount']) {
    if (result[key] !== undefined && (!Number.isInteger(result[key]) || Number(result[key]) < 0 || Number(result[key]) > Number(result.sourceParagraphCount))) return false;
  }
  if (result.includedParagraphCount !== undefined || result.excludedParagraphCount !== undefined) {
    if (result.includedParagraphCount === undefined || result.excludedParagraphCount === undefined
      || Number(result.includedParagraphCount) + Number(result.excludedParagraphCount) !== Number(result.sourceParagraphCount)
      || Number(result.includedParagraphCount) < 1 || Number(result.includedParagraphCount) > Number(result.outputParagraphCount)
      || result.sourceSelection === 'all' && Number(result.excludedParagraphCount) !== 0) return false;
  }
  return true;
}

/** Only bounded opaque IDs may be reflected in a response. */
export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Construct a bounded diagnostic without reflecting arbitrary strings. */
export function createErrorResponse(code: ErrorCode, jobId?: string, reason?: unknown): ErrorResponse {
  const safeCode = isErrorCode(code) ? code : 'FILE_INVALID_PACKAGE';
  const xmlReason = safeCode === 'XML_UNSUPPORTED' && isXmlUnsupportedReason(reason) ? reason : undefined;
  return {
    type: 'ERROR',
    protocolVersion: PROTOCOL_VERSION,
    ...(isJobId(jobId) ? { jobId } : {}),
    code: safeCode,
    message: getErrorMessage(safeCode, xmlReason),
    ...(xmlReason === undefined ? {} : { xmlReason }),
  };
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (request.protocolVersion !== PROTOCOL_VERSION) return false;
  if (request.type === 'INIT') return true;
  if (request.type === 'DRAFT') return isJobId(request.jobId) && request.bytes instanceof ArrayBuffer && isResearchDraftOptions(request.options);
  return request.type === 'INSPECT'
    && isJobId(request.jobId)
    && request.bytes instanceof ArrayBuffer
    && typeof request.fileName === 'string'
    && request.fileName.length > 0
    && request.fileName.length <= 255
    && !request.fileName.includes('\0');
}
