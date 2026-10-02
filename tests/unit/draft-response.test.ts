import { describe, expect, it } from 'vitest';
import { isDraftResponseResult } from '../../src/workers/protocol';
import { RESOURCE_LIMITS } from '../../src/domain/limits';

const result = () => ({
  bytes: new Uint8Array([0x50, 0x4b, 3, 4]).buffer,
  kind: 'competition', sourceParagraphCount: 10, outputParagraphCount: 8,
  packageVerified: true, originalTextVerified: true, manualValidation: 'NOT_RUN',
  profileId: 'field-summary', profileLabel: '전국현장교육연구대회 요약서', profileYear: 2026,
  profileVersion: '2026.10.02-v1', sourceSelection: 'summary-selection',
  includedParagraphCount: 2, excludedParagraphCount: 8, addedParagraphCount: 1,
});

describe('draft worker result envelopes', () => {
  it('accepts explicit summary counts without claiming all source paragraphs were included', () => {
    expect(isDraftResponseResult(result())).toBe(true);
  });

  it.each([
    { includedParagraphCount: 3 },
    { excludedParagraphCount: undefined },
    { sourceSelection: 'all' },
    { includedParagraphCount: 0, excludedParagraphCount: 10 },
    { outputParagraphCount: 1 },
    { sourceParagraphCount: 2001 },
    { profileId: '../field-summary' },
    { profileYear: 2026.5 },
    { profileVersion: '<script>' },
    { manualValidation: 'PASSED' },
    { originalTextVerified: false },
    { packageVerified: false },
    { addedParagraphCount: 9 },
    { bytes: new ArrayBuffer(0) },
    { bytes: new Uint8Array([0x50, 0x4b]) },
  ])('refuses an inconsistent or unverified result: %j', (patch) => {
    expect(isDraftResponseResult({ ...result(), ...patch })).toBe(false);
  });

  it('refuses a transferred buffer beyond the existing document limit', () => {
    expect(isDraftResponseResult({ ...result(), bytes: new ArrayBuffer(RESOURCE_LIMITS.maxInputBytes + 1) })).toBe(false);
  });
});
