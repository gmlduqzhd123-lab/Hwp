import { readFile } from 'node:fs/promises';
import { ZipReader } from '@zip.js/zip.js/lib/zip-core-native.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../src/domain/limits';
import { preflight } from '../../src/engine/preflight';
import { createDocumentSession } from '../../src/engine/session';

let input: Uint8Array;

beforeAll(async () => {
  input = new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url)));
});

afterEach(() => vi.restoreAllMocks());

describe('complete resource limit validation before ZIP access', () => {
  it.each(Object.keys(RESOURCE_LIMITS))('rejects missing required limit %s before decoding', async (missing) => {
    const limits = { ...RESOURCE_LIMITS } as Record<string, number>;
    delete limits[missing];
    const zipAccess = vi.spyOn(ZipReader.prototype, 'getEntries');
    const invalid = limits as unknown as ResourceLimits;
    await expect(preflight(input, 'synthetic.hwpx', invalid)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(createDocumentSession(input, 'synthetic.hwpx', invalid)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(zipAccess).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid numeric resource limits: %s', async (invalidValue) => {
    const zipAccess = vi.spyOn(ZipReader.prototype, 'getEntries');
    const invalid = { ...RESOURCE_LIMITS, maxUncompressedBytes: invalidValue };
    await expect(preflight(input, 'synthetic.hwpx', invalid)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(createDocumentSession(input, 'synthetic.hwpx', invalid)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(zipAccess).not.toHaveBeenCalled();
  });
});
