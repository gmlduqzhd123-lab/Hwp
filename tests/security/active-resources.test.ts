import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError } from '../../src/domain/errors';
import { preflight } from '../../src/engine/preflight';

let fixture: Record<string, Uint8Array>;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

beforeAll(async () => {
  // Only the trusted, tiny committed synthetic fixture is unzipped in the test.
  fixture = unzipSync(new Uint8Array(await readFile(
    new URL('../fixtures/01-plain-text.hwpx', import.meta.url),
  )));
});

async function expectRejected(input: Uint8Array, code: string): Promise<void> {
  const original = input.slice();
  try {
    await preflight(input, 'PRIVATE_ACTIVE_RESOURCE_MARKER.hwpx');
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    const safe = error as EngineError;
    expect(safe.code).toBe(code);
    expect(safe.message).not.toContain('PRIVATE_ACTIVE_RESOURCE_MARKER');
    expect(input).toEqual(original);
    return;
  }
  throw new Error('The executable resource unexpectedly passed package inspection.');
}

describe('T-02 active HWPX resource policy', () => {
  it.each([
    'Scripts/headerScripts.js',
    'Scripts/sourceScripts.bin',
    'sCrIpTs/PRIVATE_ACTIVE_RESOURCE_MARKER.txt',
    'BinData/PRIVATE_ACTIVE_RESOURCE_MARKER.exe',
    'BinData/PRIVATE_ACTIVE_RESOURCE_MARKER.EXE',
    'BinData/PRIVATE_ACTIVE_RESOURCE_MARKER.dll',
    'BinData/PRIVATE_ACTIVE_RESOURCE_MARKER.vbs',
    'BinData/PRIVATE_ACTIVE_RESOURCE_MARKER.ps1',
  ])('rejects explicit script and executable resources: %s', async (name) => {
    const input = zipSync({ ...fixture, [name]: encode('SYNTHETIC INERT TEST PAYLOAD') }, { level: 0 });
    await expectRejected(input, 'FILE_UNSUPPORTED');
  });

  it('rejects an HWPX OLE element even when its binary resource has an inert suffix', async () => {
    const section = fixture['Contents/section0.xml'];
    if (!section) throw new Error('The trusted fixture has no section.');
    const source = new TextDecoder().decode(section);
    expect(source).toContain('</hs:sec>');
    const changed = source.replace('</hs:sec>',
      '<hp:ole binaryItemIDRef="object1" objectType="EMBEDDED"/></hs:sec>');
    const input = zipSync({
      ...fixture,
      'Contents/section0.xml': encode(changed),
      'BinData/object1.bin': encode('SYNTHETIC INERT TEST PAYLOAD'),
    }, { level: 0 });
    await expectRejected(input, 'XML_UNSUPPORTED');
  });

  it('continues to accept ordinary image bytes and unchanged export inputs', async () => {
    // A tiny valid PNG stays an opaque CRC-checked resource. No image renderer is invoked.
    const image = Uint8Array.from(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5YoAAAAASUVORK5CYII=',
      'base64',
    ));
    const input = zipSync({ ...fixture, 'BinData/image.png': image }, { level: 0 });
    const original = input.slice();
    const report = await preflight(input, 'synthetic.hwpx');
    expect(report.supportLevel).toBe('INSPECT_ONLY');
    expect(report.entryCount).toBe(Object.keys(fixture).length + 1);
    expect(input).toEqual(original);
  });
});
