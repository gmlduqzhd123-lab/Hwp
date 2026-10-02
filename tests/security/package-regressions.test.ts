import { readFile } from 'node:fs/promises';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import { unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { preflight } from '../../src/engine/preflight';

let fixture: Record<string, Uint8Array>;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

beforeAll(async () => {
  fixture = unzipSync(new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url))));
});

async function rejectIntact(input: Uint8Array): Promise<void> {
  const original = new Uint8Array(input);
  await expect(preflight(input, 'synthetic.hwpx')).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  expect(input).toEqual(original);
}

function centralRecord(input: Uint8Array, name: string): { offset: number; local: number } {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const end = input.length - 22;
  let offset = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(offset + 28, true);
    const decoded = new TextDecoder().decode(input.subarray(offset + 46, offset + 46 + nameLength));
    if (decoded === name) return { offset, local: view.getUint32(offset + 42, true) };
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error('Expected test central record is missing.');
}

describe('ZIP path hierarchy integrity', () => {
  it('accepts ordinary explicit parent directories', async () => {
    const input = zipSync({ ...fixture, 'Contents/': new Uint8Array(), 'Resources/': new Uint8Array(), 'Resources/ordinary.txt': encode('inert') }, { level: 0 });
    expect((await preflight(input, 'synthetic.hwpx')).supportLevel).toBe('INSPECT_ONLY');
  });

  it.each([
    ['Resources/item', 'Resources/item/'],
    ['Resources/item', 'Resources/item/child.txt'],
    ['Resources/item/child.txt', 'Resources/item'],
    ['RESOURCES/Item', 'Resources/item/child.txt'],
    ['Resources/가', 'Resources/가/child.txt'],
  ])('rejects file and directory hierarchy collisions: %s / %s', async (first, second) => {
    const input = zipSync({ ...fixture, [first]: new Uint8Array(), [second]: new Uint8Array() }, { level: 0 });
    await rejectIntact(input);
  });
});

describe('HWPX package declarations agree', () => {
  it.each(['META-INF/container.xml', 'Contents/content.hpf'])('rejects unimplemented XML Base reference semantics in %s', async (path) => {
    const xml = fixture[path];
    if (!xml) throw new Error('Trusted fixture identity document is missing.');
    const source = new TextDecoder().decode(xml);
    const changed = source.replace(path.endsWith('.hpf') ? '<opf:package ' : '<container ', path.endsWith('.hpf') ? '<opf:package xml:base="different/" ' : '<container xml:base="different/" ');
    expect(changed).not.toBe(source);
    await rejectIntact(zipSync({ ...fixture, [path]: encode(changed) }, { level: 0 }));
  });

  it('rejects a header section count that contradicts the complete OPF spine', async () => {
    const header = fixture['Contents/header.xml'];
    if (!header) throw new Error('Trusted fixture header is missing.');
    const changed = new TextDecoder().decode(header).replace('secCnt="1"', 'secCnt="2"');
    expect(changed).not.toBe(new TextDecoder().decode(header));
    await rejectIntact(zipSync({ ...fixture, 'Contents/header.xml': encode(changed) }, { level: 0 }));
  });

  it('rejects a header XML format version that contradicts version.xml', async () => {
    const header = fixture['Contents/header.xml'];
    if (!header) throw new Error('Trusted fixture header is missing.');
    const changed = new TextDecoder().decode(header).replace('version="1.5"', 'version="9.9"');
    expect(changed).not.toBe(new TextDecoder().decode(header));
    await rejectIntact(zipSync({ ...fixture, 'Contents/header.xml': encode(changed) }, { level: 0 }));
  });
});

describe('ZIP data descriptor boundaries', () => {
  it.each([false, true])('accepts a genuine descriptor whose CRC equals the optional signature (signature=%s)', async (signed) => {
    // CRC-32 of these four opaque bytes is 0x08074b50, also the descriptor signature.
    // The CRC is valid data and cannot decide whether the optional signature is present.
    const resource = Uint8Array.from([172, 10, 122, 213]);
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false, useCompressionStream: false, zip64: false,
      extendedTimestamp: false, msDosCompatible: true, dataDescriptorSignature: signed,
    });
    for (const [name, data] of Object.entries({ ...fixture, 'Resources/opaque.bin': resource })) {
      await writer.add(name, new Uint8ArrayReader(data), { level: 0, dataDescriptor: name !== 'mimetype' });
    }
    const input = await writer.close();
    const original = new Uint8Array(input);
    expect((await preflight(input, 'synthetic.hwpx')).entryCount).toBe(Object.keys(fixture).length + 1);
    expect(input).toEqual(original);
  });
});

describe('ZIP directory metadata agrees with effective content', () => {
  it('rejects a DEFLATE directory with no compressed stream instead of skipping its malformed content', async () => {
    const input = zipSync({ ...fixture, 'Resources/': new Uint8Array() }, { level: 0 });
    const record = centralRecord(input, 'Resources/');
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    view.setUint16(record.offset + 10, 8, true);
    view.setUint16(record.local + 8, 8, true);
    await rejectIntact(input);
  });

  it('rejects symlink resource metadata while preserving original bytes', async () => {
    const input = zipSync({ ...fixture, 'Resources/symlink.txt': encode('../Contents/section0.xml') }, { level: 0 });
    const record = centralRecord(input, 'Resources/symlink.txt');
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    view.setUint16(record.offset + 4, 0x0314, true);
    view.setUint32(record.offset + 38, (0xa1ff << 16) >>> 0, true);
    await rejectIntact(input);
  });
});
