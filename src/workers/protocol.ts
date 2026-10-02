import { getErrorMessage, isErrorCode, isXmlUnsupportedReason, type ErrorCode, type XmlUnsupportedReason } from '../domain/errors';
import type { PreflightReport } from '../domain/preflight';
import { FONT_LANGUAGES, type DocumentInspection } from '../domain/document';
import { DRAFT_LIMITS, isResearchDraftOptions, type ResearchDraftOptions, type ResearchDraftResult } from '../domain/research';
import { RESOURCE_LIMITS } from '../domain/limits';
import { isPlainTextInput } from '../domain/plain-text';

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

export interface PlainTextRequest {
  type: 'TEXT';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  text: string;
}

export type WorkerRequest = InitRequest | InspectRequest | DraftRequest | PlainTextRequest;

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

export interface PlainTextResponse {
  type: 'TEXT_READY';
  protocolVersion: typeof PROTOCOL_VERSION;
  jobId: string;
  bytes: ArrayBuffer;
  report: PreflightReport;
  inspection: DocumentInspection;
}

export type WorkerResponse = ReadyResponse | ReportResponse | DraftResponse | PlainTextResponse | ErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReasonList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const reason of value) if (typeof reason !== 'string') return false;
  return true;
}

function isFormatValue(value: unknown, kind: 'number' | 'string'): boolean {
  return isRecord(value) && (value.value === null || typeof value.value === kind
    && (kind !== 'number' || Number.isFinite(value.value)))
    && (value.unit === null || typeof value.unit === 'string') && isReasonList(value.reasons);
}

function isResolvedReference(value: unknown): boolean {
  return isRecord(value) && value.resolved === true && isReasonList(value.reasons);
}

function isReadableParagraphFormat(value: unknown): boolean {
  return isRecord(value) && isResolvedReference(value.reference) && isReasonList(value.reasons)
    && ['alignment', 'lineSpacingType'].every((key) => isFormatValue(value[key], 'string'))
    && ['lineSpacing', 'leftMargin', 'rightMargin', 'indent', 'beforeSpacing', 'afterSpacing']
      .every((key) => isFormatValue(value[key], 'number'));
}

function isReadableCharacterFormat(value: unknown): boolean {
  return isRecord(value) && isResolvedReference(value.reference) && isReasonList(value.reasons)
    && isFormatValue(value.fontSize, 'number') && typeof value.superscript === 'boolean' && typeof value.subscript === 'boolean'
    && ['fonts', 'ratio', 'spacing', 'relativeSize', 'offset'].every((key) => {
      const values = value[key];
      return isRecord(values) && FONT_LANGUAGES.every((language) => isFormatValue(values[language], key === 'fonts' ? 'string' : 'number'));
    });
}

/** Bind a new text source to the exact input before accepting its bytes. */
export function isPlainTextReadyResponse(value: unknown, expectedText: string): value is PlainTextResponse {
  if (typeof value !== 'object' || value === null || !isPlainTextInput(expectedText)) return false;
  const response = value as Partial<PlainTextResponse>;
  const inspection = response.inspection;
  const lines = expectedText.split('\n');
  if (response.type !== 'TEXT_READY' || response.protocolVersion !== PROTOCOL_VERSION || !isJobId(response.jobId)
    || !(response.bytes instanceof ArrayBuffer) || response.bytes.byteLength === 0 || response.bytes.byteLength > RESOURCE_LIMITS.maxInputBytes
    || !response.report || !Array.isArray(response.report.sectionPaths) || response.report.sectionPaths.length !== 1
    || !inspection || !Array.isArray(inspection.paragraphs) || inspection.paragraphs.length !== lines.length + 1
    || !Array.isArray(inspection.sections) || inspection.sections.length !== 1
    || inspection.supportLevel !== 'INSPECT_ONLY' || inspection.editingEnabled !== false
    || !Array.isArray(inspection.tables) || inspection.tables.length !== 0
    || !Array.isArray(inspection.rows) || inspection.rows.length !== 0 || !Array.isArray(inspection.cells) || inspection.cells.length !== 0
    || !Array.isArray(inspection.runs) || inspection.runs.length !== inspection.paragraphs.length) return false;
  const report = response.report;
  const summary = inspection.summary;
  if (report.supportLevel !== 'INSPECT_ONLY' || typeof report.formatVersion !== 'string' || !report.formatVersion
    || !Number.isSafeInteger(report.entryCount) || report.entryCount < 1 || report.entryCount > RESOURCE_LIMITS.maxEntries
    || !Number.isSafeInteger(report.xmlCount) || report.xmlCount < 1 || report.xmlCount > report.entryCount
    || !Number.isSafeInteger(report.uncompressedBytes) || report.uncompressedBytes < 1 || report.uncompressedBytes > RESOURCE_LIMITS.maxUncompressedBytes
    || !summary || summary.sectionCount !== 1 || summary.paragraphCount !== inspection.paragraphs.length
    || summary.runCount !== inspection.runs.length || summary.tableCount !== 0 || summary.cellCount !== 0
    || !Number.isSafeInteger(summary.correctionCandidateParagraphCount) || summary.correctionCandidateParagraphCount < 0
    || summary.correctionCandidateParagraphCount > inspection.paragraphs.length) return false;
  const section = inspection.sections[0];
  if (!section || typeof section.nodeId !== 'string' || section.entryPath !== response.report.sectionPaths[0]
    || !Array.isArray(section.paragraphIds) || section.paragraphIds.length !== inspection.paragraphs.length
    || !Array.isArray(section.tableIds) || section.tableIds.length !== 0 || !isReasonList(section.reasons)) return false;
  const paragraphIds = new Set<string>();
  const runIds = new Set<string>();
  for (let ordinal = 0; ordinal < inspection.paragraphs.length; ordinal += 1) {
    const paragraph = inspection.paragraphs[ordinal];
    const run = inspection.runs[ordinal];
    if (!paragraph || typeof paragraph !== 'object' || typeof paragraph.nodeId !== 'string' || paragraphIds.has(paragraph.nodeId)
      || paragraph.context !== 'BODY' || paragraph.parentCellId !== null || paragraph.sectionId !== section.nodeId
      || paragraph.sourceId !== String(ordinal === 0 ? 0 : 999 + ordinal) || paragraph.text !== (ordinal === 0 ? '' : lines[ordinal - 1])
      || !Array.isArray(paragraph.runIds) || paragraph.runIds.length !== 1 || section.paragraphIds[ordinal] !== paragraph.nodeId
      || typeof paragraph.structurePath !== 'string' || !isReasonList(paragraph.reasons)
      || !isReadableParagraphFormat(paragraph.paragraphFormat) || !isResolvedReference(paragraph.styleReference)
      || !run || typeof run.nodeId !== 'string' || runIds.has(run.nodeId) || run.nodeId !== paragraph.runIds[0]
      || run.paragraphId !== paragraph.nodeId || run.text !== paragraph.text || !isReasonList(run.reasons)
      || !isReadableCharacterFormat(run.characterFormat) || !Array.isArray(run.segments)) return false;
    let segmentText = '';
    for (const segment of run.segments) {
      if (!segment || typeof segment.text !== 'string' || !['TEXT', 'CDATA', 'TAB', 'LINE_BREAK', 'UNKNOWN_CONTROL'].includes(segment.kind)
        || segment.kind === 'UNKNOWN_CONTROL' && segment.layoutControl !== true) return false;
      segmentText += segment.text;
    }
    if (segmentText !== run.text) return false;
    paragraphIds.add(paragraph.nodeId); runIds.add(run.nodeId);
  }
  return true;
}

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
  if (request.type === 'TEXT') return isJobId(request.jobId) && isPlainTextInput(request.text);
  if (request.type === 'DRAFT') return isJobId(request.jobId) && request.bytes instanceof ArrayBuffer && isResearchDraftOptions(request.options);
  return request.type === 'INSPECT'
    && isJobId(request.jobId)
    && request.bytes instanceof ArrayBuffer
    && typeof request.fileName === 'string'
    && request.fileName.length > 0
    && request.fileName.length <= 255
    && !request.fileName.includes('\0');
}
