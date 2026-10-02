import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError } from '../../src/domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../src/domain/limits';
import { preflight } from '../../src/engine/preflight';

let original: Uint8Array;
let fixture: Record<string, Uint8Array>;

function centralRecords(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = view.getUint32(bytes.length - 6, true);
  const count = view.getUint16(bytes.length - 12, true);
  const records: number[] = [];
  for (let index = 0; index < count; index += 1) {
    records.push(cursor);
    cursor += 46 + view.getUint16(cursor + 28, true)
      + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return records;
}

async function expectRejected(
  bytes: Uint8Array,
  code: 'FILE_INVALID_PACKAGE' | 'RESOURCE_LIMIT',
  limits: Readonly<ResourceLimits> = RESOURCE_LIMITS,
): Promise<void> {
  const before = new Uint8Array(bytes);
  const hash = createHash('sha256').update(before).digest('hex');
  let caught: unknown;
  try {
    await preflight(bytes, 'PRIVATE_INTEGRITY_FILENAME.hwpx', limits);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineError);
  expect(caught).toMatchObject({ code });
  expect((caught as EngineError).message).not.toContain('PRIVATE_INTEGRITY_FILENAME');
  expect((caught as EngineError).message).not.toContain(hash);
  expect(bytes).toEqual(before);
}

beforeAll(async () => {
  original = new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url)));
  fixture = unzipSync(original);
});

describe('ZIP metadata and package integrity independent regressions', () => {
  it('rejects a Unix symlink entry even when its inert content and CRC are otherwise valid', async () => {
    const bytes = zipSync({ ...fixture, 'BinData/link.bin': new TextEncoder().encode('../../outside') }, { level: 0 });
    const record = centralRecords(bytes).at(-1)!;
    const view = new DataView(bytes.buffer);
    view.setUint16(record + 4, 0x0314, true); // UNIX creator, version 2.0.
    view.setUint32(record + 38, 0xa1ff0000, true); // S_IFLNK | 0777.
    await expectRejected(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('accepts inert resources with ordinary Unix regular-file metadata', async () => {
    const bytes = zipSync({ ...fixture, 'BinData/ordinary.bin': new Uint8Array([1, 2, 3]) }, { level: 0 });
    const record = centralRecords(bytes).at(-1)!;
    const view = new DataView(bytes.buffer);
    view.setUint16(record + 4, 0x0314, true);
    view.setUint32(record + 38, 0x81a40000, true); // S_IFREG | 0644.
    expect((await preflight(bytes, 'synthetic.hwpx')).supportLevel).toBe('INSPECT_ONLY');
  });

  it('accepts UTF-8 XML with a retained BOM and line endings without rewriting it', async () => {
    const section = fixture['Contents/section0.xml'];
    if (!section) throw new Error('Trusted section is absent');
    const changed = new TextEncoder().encode('\ufeff' + new TextDecoder().decode(section).replaceAll('\n', '\r\n'));
    const bytes = zipSync({ ...fixture, 'Contents/section0.xml': changed }, { level: 0 });
    const before = new Uint8Array(bytes);
    expect((await preflight(bytes, 'synthetic.hwpx')).sectionPaths).toEqual(['Contents/section0.xml']);
    expect(bytes).toEqual(before);
  });

  it('does not misclassify harmless PDF or HWP marker bytes inside a ZIP resource', async () => {
    const bytes = zipSync({ ...fixture, 'BinData/marker.bin': new TextEncoder().encode('%PDF-1.7 HWP Document File') }, { level: 0 });
    expect((await preflight(bytes, 'synthetic.hwpx')).supportLevel).toBe('INSPECT_ONLY');
  });
});

describe('Public preflight rejects unusable limit configuration safely', () => {
  it.each(Object.keys(RESOURCE_LIMITS) as (keyof ResourceLimits)[])('requires the %s bound to be present', async (key) => {
    const limits: Partial<ResourceLimits> = { ...RESOURCE_LIMITS };
    delete limits[key];
    await expectRejected(original.slice(), 'RESOURCE_LIMIT', limits as ResourceLimits);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid numeric bound %s', async (value) => {
    await expectRejected(original.slice(), 'RESOURCE_LIMIT', { ...RESOURCE_LIMITS, maxXmlDepth: value });
  });

  it.each([null, {}, 'limits', false])('rejects unusable runtime configuration %j without a raw exception', async (value) => {
    await expectRejected(original.slice(), 'RESOURCE_LIMIT', value as unknown as ResourceLimits);
  });

  it('accepts a complete valid bounds object without changing the original bytes', async () => {
    const bytes = original.slice();
    expect((await preflight(bytes, 'synthetic.hwpx', { ...RESOURCE_LIMITS })).supportLevel).toBe('INSPECT_ONLY');
    expect(bytes).toEqual(original);
  });
});
