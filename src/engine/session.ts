import { EngineError } from '../domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../domain/limits';
import type { PreflightReport } from '../domain/preflight';
import { resourceLimit } from './package/errors';
import { validateLimits } from './package/metadata';
import { preflight } from './preflight';

export interface DocumentSession {
  readonly report: PreflightReport;
  readonly originalSha256: string;
  getOriginalBytes(): Uint8Array;
  getWorkerBytes(): Uint8Array;
  exportUnchanged(): Uint8Array;
}

function reportCopy(report: PreflightReport): PreflightReport {
  return { ...report, sectionPaths: [...report.sectionPaths] };
}

/** Original ownership stays private; transfer and output APIs only hand out fresh copies. */
export async function createDocumentSession(input: Uint8Array, fileName: string, inputLimits: Readonly<ResourceLimits> = RESOURCE_LIMITS): Promise<DocumentSession> {
  const limits = Object.freeze({ ...inputLimits });
  validateLimits(limits);
  if (input.byteLength > limits.maxInputBytes) resourceLimit();
  // Node Buffer.slice() returns an alias, so normalize all Uint8Array subtypes.
  const originalBytes = new Uint8Array(input);
  const report = await preflight(originalBytes, fileName, limits);
  let originalSha256: string;
  try {
    const digest = await crypto.subtle.digest('SHA-256', originalBytes);
    originalSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new EngineError('WORKER_FAILED', '문서 세션을 시작하지 못했습니다. 원본은 변경되지 않았습니다.');
  }
  return Object.freeze({
    get report() { return reportCopy(report); },
    originalSha256,
    getOriginalBytes: () => originalBytes.slice(),
    getWorkerBytes: () => originalBytes.slice(),
    exportUnchanged: () => originalBytes.slice(),
  });
}
