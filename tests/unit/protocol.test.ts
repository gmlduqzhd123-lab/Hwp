import { describe, expect, it } from 'vitest';
import { createErrorResponse, isJobId, isWorkerRequest, PROTOCOL_VERSION } from '../../src/workers/protocol';
import { ERROR_MESSAGES, XML_UNSUPPORTED_MESSAGES, type ErrorCode } from '../../src/domain/errors';

function inspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'INSPECT',
    protocolVersion: PROTOCOL_VERSION,
    jobId: 'job_1',
    bytes: new ArrayBuffer(4),
    fileName: 'synthetic.hwpx',
    ...overrides,
  };
}

describe('Worker request boundary', () => {
  it('accepts only the current initialization and inspection protocol', () => {
    expect(isWorkerRequest({ type: 'INIT', protocolVersion: PROTOCOL_VERSION })).toBe(true);
    expect(isWorkerRequest(inspection())).toBe(true);
    expect(isWorkerRequest(inspection({ protocolVersion: PROTOCOL_VERSION + 1 }))).toBe(false);
    expect(isWorkerRequest(inspection({ protocolVersion: String(PROTOCOL_VERSION) }))).toBe(false);
    expect(isWorkerRequest({ type: 'INIT' })).toBe(false);
    expect(isWorkerRequest(inspection({ type: 'APPLY' }))).toBe(false);
  });

  it.each([null, undefined, true, 1, 'INSPECT', []])('rejects non-request values (%#)', (value) => {
    expect(isWorkerRequest(value)).toBe(false);
  });

  it('requires transferred ArrayBuffer ownership rather than a typed view or shared memory', () => {
    expect(isWorkerRequest(inspection({ bytes: new Uint8Array(4) }))).toBe(false);
    expect(isWorkerRequest(inspection({ bytes: new SharedArrayBuffer(4) }))).toBe(false);
    expect(isWorkerRequest(inspection({ bytes: { byteLength: 4 } }))).toBe(false);
    expect(isWorkerRequest(inspection({ bytes: undefined }))).toBe(false);
  });

  it.each(['', 'x'.repeat(256), 'synthetic\0.hwpx', null, 12])('bounds file name inputs (%#)', (fileName) => {
    expect(isWorkerRequest(inspection({ fileName }))).toBe(false);
  });

  it('accepts the exact file name length boundary', () => {
    expect(isWorkerRequest(inspection({ fileName: `${'a'.repeat(250)}.hwpx` }))).toBe(true);
  });

  it.each(['', 'a'.repeat(129), 'file name.hwpx', '../path', '<script>', 'job\n1', undefined, 7])(
    'never treats an unsafe or oversized reflected job identifier as valid (%#)',
    (jobId) => {
      expect(isJobId(jobId)).toBe(false);
      expect(isWorkerRequest(inspection({ jobId }))).toBe(false);
    },
  );

  it('accepts opaque IDs at both documented boundaries', () => {
    expect(isJobId('a')).toBe(true);
    expect(isJobId('a'.repeat(128))).toBe(true);
    expect(isJobId('job_A-0_1')).toBe(true);
  });
});

describe('Worker error boundary', () => {
  it('preserves a known XML reason with app-owned text and a bounded job ID', () => {
    expect(createErrorResponse('XML_UNSUPPORTED', 'job_1', 'DTD')).toEqual({
      type: 'ERROR', protocolVersion: PROTOCOL_VERSION, jobId: 'job_1',
      code: 'XML_UNSUPPORTED', xmlReason: 'DTD', message: XML_UNSUPPORTED_MESSAGES.DTD,
    });
  });

  it.each(['PRIVATE_FILENAME.hwpx', 'https://example.invalid/PRIVATE_TEXT', '__proto__', 'constructor', '', null, {}, 12])(
    'does not reflect unknown reason values (%#)',
    (reason) => {
      expect(createErrorResponse('XML_UNSUPPORTED', 'job_1', reason)).toEqual({
        type: 'ERROR', protocolVersion: PROTOCOL_VERSION, jobId: 'job_1',
        code: 'XML_UNSUPPORTED', message: ERROR_MESSAGES.XML_UNSUPPORTED,
      });
    },
  );

  it('omits XML reasons on other codes and unsafe reflected identifiers', () => {
    expect(createErrorResponse('FILE_INVALID_PACKAGE', 'PRIVATE FILE NAME.hwpx', 'DTD')).toEqual({
      type: 'ERROR', protocolVersion: PROTOCOL_VERSION,
      code: 'FILE_INVALID_PACKAGE', message: ERROR_MESSAGES.FILE_INVALID_PACKAGE,
    });
  });

  it('falls back instead of reflecting a runtime-invalid error code', () => {
    expect(createErrorResponse('PRIVATE_DOCUMENT_TEXT' as ErrorCode, 'job_1', 'DTD')).toEqual({
      type: 'ERROR', protocolVersion: PROTOCOL_VERSION, jobId: 'job_1',
      code: 'FILE_INVALID_PACKAGE', message: ERROR_MESSAGES.FILE_INVALID_PACKAGE,
    });
  });
});
