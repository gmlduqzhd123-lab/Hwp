import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deflateSync, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineError, type ErrorCode } from '../../src/domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../src/domain/limits';
import { preflight } from '../../src/engine/preflight';

// Dangerous packages are generated only in memory. They are never public fixture files.
interface Entry {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  declaredSize?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let original: Uint8Array;
let validEntries: Entry[];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A small independent ZIP writer lets tests produce duplicate names, forged sizes,
// unsupported methods, and flags that a normal high-level writer would sanitize.
function zip(entries: Entry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x800;
    const payload = method === 8 ? deflateSync(entry.data) : entry.data;
    const uncompressedSize = entry.declaredSize ?? entry.data.length;
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, payload);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + payload.length;
  }
  const centralBytes = concat(centralParts);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralBytes.length, true);
  view.setUint32(16, localOffset, true);
  return concat([...localParts, centralBytes, end]);
}

function extras(entry: Entry): Uint8Array {
  return zip([...validEntries, entry]);
}

function replaceXml(path: string, transform: (xml: string) => string): Uint8Array {
  expect(validEntries.some((entry) => entry.name === path)).toBe(true);
  return zip(validEntries.map((entry) => entry.name === path
    ? { ...entry, data: encoder.encode(transform(decoder.decode(entry.data))) }
    : entry));
}

function records(bytes: Uint8Array): Array<{ central: number; local: number; data: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  let offset = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  const result: Array<{ central: number; local: number; data: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const local = view.getUint32(offset + 42, true);
    const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    result.push({ central: offset, local, data });
    offset += 46 + view.getUint16(offset + 28, true)
      + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return result;
}

async function rejectedWithoutMutation(
  bytes: Uint8Array,
  expected: ErrorCode | ErrorCode[],
  limits?: Partial<ResourceLimits>,
  name = 'PRIVATE_FILE_MARKER.hwpx',
): Promise<void> {
  const before = bytes.slice();
  const hash = sha256(before);
  let failure: unknown;
  try {
    await preflight(bytes, name, limits ? { ...RESOURCE_LIMITS, ...limits } : undefined);
  } catch (error) {
    failure = error;
  }
  expect(failure, 'Unsafe input must be rejected, never returned as an empty successful report')
    .toBeInstanceOf(EngineError);
  const error = failure as EngineError;
  expect(Array.isArray(expected) ? expected : [expected]).toContain(error.code);
  expect(error.message).not.toContain('PRIVATE_FILE_MARKER');
  expect(error.message).not.toContain('PRIVATE_XML_MARKER');
  expect(error.message).not.toContain(hash);
  expect(bytes).toEqual(before);
  expect(sha256(bytes)).toBe(hash);
}

beforeAll(async () => {
  original = new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url)));
  // unzipSync is used only on our tiny, trusted, committed synthetic fixture.
  const entries = unzipSync(original);
  validEntries = Object.entries(entries).map(([name, data]) => ({ name, data }));
});

describe('T-02 / AC-01 format identification', () => {
  it('accepts the independently reconstructed valid package before testing mutations', async () => {
    expect((await preflight(zip(validEntries), 'sample.hwpx')).supportLevel).toBe('INSPECT_ONLY');
  });

  it('accepts valid DEFLATE XML and binary resources with checked CRCs', async () => {
    const entries = validEntries.map((entry) => entry.name === 'mimetype' ? entry : { ...entry, method: 8 });
    const bytes = zip([...entries, { name: 'Resources/plain.bin', data: encoder.encode('synthetic binary resource'), method: 8 }]);
    const before = bytes.slice();
    const report = await preflight(bytes, 'sample.HWPX');
    expect(report.supportLevel).toBe('INSPECT_ONLY');
    expect(report.entryCount).toBe(entries.length + 1);
    expect(report.uncompressedBytes).toBe(entries.reduce((sum, entry) => sum + entry.data.length, 0) + 25);
    expect(bytes).toEqual(before);
  });

  it.each(['input.hwp', 'input.pdf', 'input.zip', 'input.txt'])('rejects unsupported filename %s', async (name) => {
    await rejectedWithoutMutation(original.slice(), 'FILE_UNSUPPORTED', undefined, name);
  });

  it.each([
    ['HWP compound document', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ['PDF', encoder.encode('%PDF-1.7\nPRIVATE_XML_MARKER')],
  ])('recognizes renamed %s instead of pretending it is HWPX', async (_label, bytes) => {
    await rejectedWithoutMutation(bytes, 'FILE_UNSUPPORTED');
  });

  it.each([
    ['empty file', new Uint8Array()],
    ['plain text', encoder.encode('PRIVATE_XML_MARKER')],
    ['plain ZIP', zip([{ name: 'readme.txt', data: encoder.encode('PRIVATE_XML_MARKER') }])],
  ])('rejects %s renamed to .hwpx', async (_label, bytes) => {
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects the wrong HWPX mimetype', async () => {
    const bytes = zip(validEntries.map((entry) => entry.name === 'mimetype'
      ? { ...entry, data: encoder.encode('application/zip') } : entry));
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects compressed mimetype entries', async () => {
    const bytes = zip(validEntries.map((entry) => entry.name === 'mimetype' ? { ...entry, method: 8 } : entry));
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects mimetype moved behind another entry', async () => {
    const bytes = zip([...validEntries.filter((entry) => entry.name !== 'mimetype'),
      validEntries.find((entry) => entry.name === 'mimetype')!]);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it.each(['mimetype', 'META-INF/container.xml', 'Contents/content.hpf'])('rejects missing package component %s', async (path) => {
    await rejectedWithoutMutation(zip(validEntries.filter((entry) => entry.name !== path)), 'FILE_INVALID_PACKAGE');
  });
});

describe('T-02 / AC-02 archive integrity and encryption', () => {
  it.each([0, 8])('validates CRC for compression method %i', async (method) => {
    const bytes = zip([...validEntries, { name: 'Resources/payload.bin', data: encoder.encode('PRIVATE_XML_MARKER'), method }]);
    const record = records(bytes).at(-1)!;
    const view = new DataView(bytes.buffer);
    view.setUint32(record.local + 14, 0x12345678, true);
    view.setUint32(record.central + 16, 0x12345678, true);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects corrupt DEFLATE payloads', async () => {
    const data = encoder.encode('PRIVATE_XML_MARKER'.repeat(100));
    const bytes = extras({ name: 'Resources/compressed.bin', data, method: 8 });
    const record = records(bytes).at(-1)!;
    bytes[record.data] = 0xff;
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it.each([0x801, 0x840, 0x841])('rejects encryption flags 0x%s', async (flags) => {
    await rejectedWithoutMutation(extras({ name: 'Resources/encrypted.bin', data: new Uint8Array(8), flags }), 'FILE_ENCRYPTED');
  });

  it('rejects truncated end records', async () => {
    await rejectedWithoutMutation(original.slice(0, -10), 'FILE_INVALID_PACKAGE');
  });

  it('rejects a truncated central-directory header even with a valid end record', async () => {
    const bytes = zip(validEntries);
    const view = new DataView(bytes.buffer);
    const centralOffset = view.getUint32(bytes.length - 6, true);
    const end = bytes.slice(-22);
    new DataView(end.buffer).setUint32(12, 20, true);
    await rejectedWithoutMutation(concat([bytes.slice(0, centralOffset + 20), end]), 'FILE_INVALID_PACKAGE');
  });

  it('rejects a truncated local header pointed at by the central directory', async () => {
    const bytes = zip(validEntries);
    const record = records(bytes)[0]!;
    const view = new DataView(bytes.buffer);
    view.setUint32(record.central + 42, bytes.length - 15, true);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it.each([
    ['central signature', (view: DataView, first: { central: number; local: number }) => view.setUint32(first.central, 0, true)],
    ['local signature', (view: DataView, first: { central: number; local: number }) => view.setUint32(first.local, 0, true)],
    ['local/central method mismatch', (view: DataView, first: { central: number; local: number }) => view.setUint16(first.local + 8, 8, true)],
    ['local/central CRC mismatch', (view: DataView, first: { central: number; local: number }) => view.setUint32(first.local + 14, 0, true)],
    ['local/central filename mismatch', (view: DataView, first: { central: number; local: number }) => view.setUint8(first.local + 30, 0x78)],
  ])('rejects %s', async (_label, mutate) => {
    const bytes = zip(validEntries);
    mutate(new DataView(bytes.buffer), records(bytes)[0]!);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects ZIP64 entry-size sentinel values', async () => {
    const bytes = zip(validEntries);
    const first = records(bytes)[0]!;
    const view = new DataView(bytes.buffer);
    view.setUint32(first.central + 24, 0xffffffff, true);
    view.setUint32(first.local + 22, 0xffffffff, true);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects ZIP64 entry-count sentinel values', async () => {
    const bytes = zip(validEntries);
    const view = new DataView(bytes.buffer);
    view.setUint16(bytes.length - 14, 0xffff, true);
    view.setUint16(bytes.length - 12, 0xffff, true);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects multi-disk ZIP archives', async () => {
    const bytes = zip(validEntries);
    new DataView(bytes.buffer).setUint16(bytes.length - 18, 1, true);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects a central-directory count that omits trailing entries', async () => {
    const bytes = zip(validEntries);
    const view = new DataView(bytes.buffer);
    view.setUint16(bytes.length - 14, validEntries.length - 1, true);
    view.setUint16(bytes.length - 12, validEntries.length - 1, true);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('rejects overlapping local-entry pointers', async () => {
    const bytes = zip(validEntries);
    const entries = records(bytes);
    new DataView(bytes.buffer).setUint32(entries[1]!.central + 42, entries[0]!.local, true);
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it.each([9, 12, 99])('rejects unverified compression method %i', async (method) => {
    await rejectedWithoutMutation(extras({ name: 'Resources/unsupported.bin', data: new Uint8Array(8), method }), 'FILE_INVALID_PACKAGE');
  });
});

describe('T-02 / AC-03 path safety and resource limits', () => {
  it.each([
    '../escape.xml', '/absolute.xml', 'C:/absolute.xml',
    'Contents\\escape.xml', 'Contents/../escape.xml',
    'Contents/%2e%2e/escape.xml', 'Contents/%73ection0.xml',
    'Contents/embedded\0name.xml', 'Contents/./section0.xml',
  ])('rejects ambiguous or escaping path %j', async (name) => {
    await rejectedWithoutMutation(extras({ name, data: encoder.encode('<x/>') }), 'FILE_INVALID_PACKAGE');
  });

  it('rejects duplicate exact entry names', async () => {
    await rejectedWithoutMutation(zip([...validEntries, validEntries[0]!]), 'FILE_INVALID_PACKAGE');
  });

  it('rejects canonically equivalent Unicode entry names', async () => {
    await rejectedWithoutMutation(zip([...validEntries,
      { name: 'Resources/caf\u00e9.bin', data: new Uint8Array(1) },
      { name: 'Resources/cafe\u0301.bin', data: new Uint8Array(1) },
    ]), 'FILE_INVALID_PACKAGE');
  });

  it('limits input bytes before package expansion', async () => {
    await rejectedWithoutMutation(original.slice(), 'RESOURCE_LIMIT', { maxInputBytes: original.length - 1 });
  });

  it('limits entry counts before package expansion', async () => {
    await rejectedWithoutMutation(original.slice(), 'RESOURCE_LIMIT', { maxEntries: validEntries.length - 1 });
  });

  it('limits declared uncompressed bytes before package expansion', async () => {
    await rejectedWithoutMutation(extras({ name: 'Resources/huge.bin', data: new Uint8Array(1), declaredSize: 500_000 }),
      'RESOURCE_LIMIT', { maxUncompressedBytes: 100_000 });
  });

  it('limits XML bytes independently of the package byte limit', async () => {
    await rejectedWithoutMutation(original.slice(), 'RESOURCE_LIMIT', { maxXmlBytes: 32 });
  });

  it('rejects DEFLATE data that expands past its forged declared size', async () => {
    const baseSize = validEntries.reduce((sum, entry) => sum + entry.data.length, 0);
    const bytes = extras({ name: 'Resources/expansion.bin', data: new Uint8Array(50_000).fill(65), method: 8, declaredSize: 1 });
    // zip.js independently validates decoded output against the declared size.
    // This forged size is a package-integrity error even when its would-be
    // expansion also exceeds the application's byte budget.
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE',
      { maxUncompressedBytes: baseSize + 100 });
  });

  it('rejects forged DEFLATE entry lengths even within the package byte budget', async () => {
    await rejectedWithoutMutation(extras({ name: 'Resources/forged-deflate.bin', data: new Uint8Array(200).fill(65),
      method: 8, declaredSize: 1 }), 'FILE_INVALID_PACKAGE');
  });

  it('rejects forged STORED entry lengths', async () => {
    await rejectedWithoutMutation(extras({ name: 'Resources/forged.bin', data: new Uint8Array(200), declaredSize: 1 }),
      'FILE_INVALID_PACKAGE');
  });
});

describe('T-02 / AC-03 XML and package-reference safety', () => {
  it.each([
    '<!DOCTYPE x [<!ENTITY marker "PRIVATE_XML_MARKER">]><x>&marker;</x>',
    '<!DOCTYPE x SYSTEM "https://outside.invalid/PRIVATE_XML_MARKER"><x/>',
    '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///PRIVATE_XML_MARKER">]><x>&secret;</x>',
  ])('rejects DTD and entity declarations without resolving them', async (xml) => {
    await rejectedWithoutMutation(extras({ name: 'Security/payload.xml', data: encoder.encode(xml) }), 'XML_UNSUPPORTED');
  });

  it('limits XML depth on every XML entry, including non-spine resources', async () => {
    const xml = '<x>'.repeat(12) + 'PRIVATE_XML_MARKER' + '</x>'.repeat(12);
    await rejectedWithoutMutation(extras({ name: 'Security/deep.xml', data: encoder.encode(xml) }),
      'RESOURCE_LIMIT', { maxXmlDepth: 10 });
  });

  it('limits XML attribute counts', async () => {
    const attributes = Array.from({ length: 12 }, (_, index) => `a${index}="x"`).join(' ');
    await rejectedWithoutMutation(extras({ name: 'Security/attributes.xml', data: encoder.encode(`<x ${attributes}/>` ) }),
      'RESOURCE_LIMIT', { maxAttributes: 10 });
  });

  it('limits XML text size', async () => {
    await rejectedWithoutMutation(extras({ name: 'Security/text.xml', data: encoder.encode(`<x>${'A'.repeat(5000)}</x>`) }),
      'RESOURCE_LIMIT', { maxXmlTextLength: 2000 });
  });

  it('rejects invalid UTF-8 rather than silently replacing bytes', async () => {
    await rejectedWithoutMutation(extras({ name: 'Security/invalid.xml', data: new Uint8Array([60, 120, 62, 0xc3, 0x28, 60, 47, 120, 62]) }),
      'XML_UNSUPPORTED');
  });

  it('rejects declared unsupported XML encoding', async () => {
    await rejectedWithoutMutation(extras({ name: 'Security/encoding.xml', data: encoder.encode('<?xml version="1.0" encoding="UTF-16"?><x/>') }),
      'XML_UNSUPPORTED');
  });

  it('rejects malformed XML without returning a successful package report', async () => {
    await rejectedWithoutMutation(extras({ name: 'Security/broken.xml', data: encoder.encode('<x><y></x>') }),
      ['XML_UNSUPPORTED', 'FILE_INVALID_PACKAGE']);
  });

  it('rejects external container rootfile references', async () => {
    const bytes = replaceXml('META-INF/container.xml', (xml) => {
      expect(xml).toContain('Contents/content.hpf');
      return xml.replace('Contents/content.hpf', 'https://outside.invalid/PRIVATE_XML_MARKER.hpf');
    });
    await rejectedWithoutMutation(bytes, 'XML_UNSUPPORTED');
  });

  it('rejects external OPF manifest resources', async () => {
    const bytes = replaceXml('Contents/content.hpf', (xml) => {
      expect(xml).toContain('section0.xml');
      return xml.replace('section0.xml', 'https://outside.invalid/PRIVATE_XML_MARKER.xml');
    });
    await rejectedWithoutMutation(bytes, 'XML_UNSUPPORTED');
  });

  it('rejects OPF resource path traversal', async () => {
    const bytes = replaceXml('Contents/content.hpf', (xml) => xml.replace('section0.xml', '../../escape.xml'));
    await rejectedWithoutMutation(bytes, 'FILE_INVALID_PACKAGE');
  });

  it('makes no fetch requests while inspecting valid or external-reference inputs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected network request');
    });
    try {
      expect((await preflight(original.slice(), 'sample.hwpx')).supportLevel).toBe('INSPECT_ONLY');
      await rejectedWithoutMutation(extras({ name: 'Security/external.xml',
        data: encoder.encode('<!DOCTYPE x SYSTEM "https://outside.invalid/PRIVATE_XML_MARKER"><x/>') }), 'XML_UNSUPPORTED');
      const bytes = replaceXml('Contents/content.hpf', (xml) => xml.replace('section0.xml',
        'https://outside.invalid/PRIVATE_XML_MARKER.xml'));
      await rejectedWithoutMutation(bytes, 'XML_UNSUPPORTED');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
