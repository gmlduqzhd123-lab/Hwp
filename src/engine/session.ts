import { EngineError } from '../domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../domain/limits';
import type { PreflightReport } from '../domain/preflight';
import type { DocumentInspection } from '../domain/document';
import { resourceLimit } from './package/errors';
import { validateLimits } from './package/metadata';
import { inspectHwpx, preflight } from './preflight';

export interface DocumentSession {
  readonly report: PreflightReport;
  readonly originalSha256: string;
  getOriginalBytes(): Uint8Array;
  getWorkerBytes(): Uint8Array;
  exportUnchanged(): Uint8Array;
}

export interface InspectionSession extends DocumentSession {
  readonly inspection: DocumentInspection;
}

function reportCopy(report: PreflightReport): PreflightReport {
  return { ...report, sectionPaths: [...report.sectionPaths] };
}

/** Original ownership stays private; transfer and output APIs only hand out fresh copies. */
async function createSession(input: Uint8Array, fileName: string, inputLimits: Readonly<ResourceLimits>, includeInspection: boolean): Promise<DocumentSession | InspectionSession> {
  const limits = Object.freeze({ ...inputLimits });
  validateLimits(limits);
  if (input.byteLength > limits.maxInputBytes) resourceLimit();
  // Node Buffer.slice() returns an alias, so normalize all Uint8Array subtypes.
  const originalBytes = new Uint8Array(input);
  const analysis = includeInspection ? await inspectHwpx(originalBytes, fileName, limits) : null;
  const report = analysis?.report ?? await preflight(originalBytes, fileName, limits);
  let originalSha256: string;
  try {
    const digest = await crypto.subtle.digest('SHA-256', originalBytes);
    originalSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new EngineError('WORKER_FAILED', '문서 세션을 시작하지 못했습니다. 원본은 변경되지 않았습니다.');
  }
  const session: DocumentSession = {
    get report() { return reportCopy(report); },
    originalSha256,
    getOriginalBytes: () => originalBytes.slice(),
    getWorkerBytes: () => originalBytes.slice(),
    exportUnchanged: () => originalBytes.slice(),
  };
  if (analysis) Object.defineProperty(session, 'inspection', { enumerable: true, get: () => structuredClone(analysis.inspection) });
  return Object.freeze(session);
}

export async function createDocumentSession(input: Uint8Array, fileName: string, inputLimits: Readonly<ResourceLimits> = RESOURCE_LIMITS): Promise<DocumentSession> {
  return createSession(input, fileName, inputLimits, false);
}

/** Structured getters cannot mutate the private reading model or source bytes. */
export async function createInspectionSession(input: Uint8Array, fileName: string, inputLimits: Readonly<ResourceLimits> = RESOURCE_LIMITS): Promise<InspectionSession> {
  return await createSession(input, fileName, inputLimits, true) as InspectionSession;
}
