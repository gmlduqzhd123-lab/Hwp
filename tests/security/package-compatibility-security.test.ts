import { readFile } from 'node:fs/promises';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import { unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../src/domain/limits';
import { preflight } from '../../src/engine/preflight';
import { makeHancomPackage } from '../helpers/hancom-package';

let entries: Record<string, Uint8Array>;
const encode = (source: string) => new TextEncoder().encode(source);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

beforeAll(async () => {
  const fixture = new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url)));
  entries = unzipSync(makeHancomPackage(fixture, { inertMetadata: false }));
});

function changed(path: string, transform: (source: string) => string, additions: Record<string, Uint8Array> = {}): Uint8Array {
  const bytes = entries[path];
  if (!bytes) throw new Error('Trusted synthetic component is missing.');
  const before = decode(bytes);
  const after = transform(before);
  expect(after).not.toBe(before);
  return zipSync({ ...entries, ...additions, [path]: encode(after) }, { level: 0 });
}

async function rejected(input: Uint8Array, code = 'FILE_INVALID_PACKAGE', limits?: Readonly<ResourceLimits>): Promise<void> {
  const original = new Uint8Array(input);
  await expect(preflight(input, 'synthetic.hwpx', limits)).rejects.toMatchObject({ code });
  expect(input).toEqual(original);
}

describe('Hancom path compatibility preserves local-path boundaries', () => {
  it('rejects different existing root-relative and package-relative targets', async () => {
    const header = entries['Contents/header.xml'];
    if (!header) throw new Error('Synthetic header is absent.');
    await rejected(changed('Contents/content.hpf', (source) => source.replace('href="Contents/header.xml"', 'href="header.xml"'), { 'header.xml': header }));
  });

  it('rejects root-style targets that also exist under the package directory', async () => {
    const header = entries['Contents/header.xml'];
    if (!header) throw new Error('Synthetic header is absent.');
    await rejected(zipSync({ ...entries, 'Contents/Contents/header.xml': header }, { level: 0 }));
  });

  it.each(['../Contents/header.xml', '/Contents/header.xml', 'C:/Contents/header.xml', 'Contents\\header.xml', 'Contents/%68eader.xml'])('rejects unsafe manifest href %s under the extended resolver', async (href) => {
    await rejected(changed('Contents/content.hpf', (source) => source.replace('href="Contents/header.xml"', `href="${href}"`)));
  });

  it('rejects qualified-only href decoys', async () => {
    await rejected(changed('Contents/content.hpf', (source) => source.replace('href="Contents/header.xml"', 'xmlns:decoy="urn:synthetic:decoy" decoy:href="Contents/header.xml"')));
  });
});

describe('Hancom namespace and spine compatibility remains explicit', () => {
  it.each([
    ['http://www.idpf.org/2007/opf//', 'FILE_INVALID_PACKAGE'],
    ['http://www.idpf.org/2007/opf/ ', 'XML_UNSUPPORTED'],
    ['urn:synthetic:opf', 'FILE_INVALID_PACKAGE'],
  ])('rejects an unrecognized package namespace %s', async (uri, code) => {
    await rejected(changed('Contents/content.hpf', (source) => source.replace('http://www.idpf.org/2007/opf/', uri)), code);
  });

  it('rejects mixed OPF URI aliases inside one package', async () => {
    await rejected(changed('Contents/content.hpf', (source) => source.replace('<opf:manifest>', '<opf:manifest xmlns:opf="http://www.idpf.org/2007/opf">')));
  });

  it('rejects repeated verified header spine references', async () => {
    await rejected(changed('Contents/content.hpf', (source) => source.replace('</opf:spine>', '<opf:itemref idref="header" linear="yes"/></opf:spine>')));
  });

  it('rejects a header-only spine', async () => {
    await rejected(changed('Contents/content.hpf', (source) => source.replace('<opf:itemref idref="section0" linear="yes"/>', '')));
  });

  it('rejects duplicate body sections with a valid header present', async () => {
    await rejected(changed('Contents/content.hpf', (source) => source.replace('</opf:spine>', '<opf:itemref idref="section0" linear="yes"/></opf:spine>')));
  });
});

describe('auxiliary container rootfiles remain bounded and unambiguous', () => {
  it('rejects two actual OPF package roots', async () => {
    const packageXml = entries['Contents/content.hpf'];
    if (!packageXml) throw new Error('Synthetic package is absent.');
    await rejected(changed('META-INF/container.xml', (source) => source.replace('</rootfiles>', '<rootfile full-path="Contents/second.hpf" media-type="application/hwpml-package+xml"/></rootfiles>'), { 'Contents/second.hpf': packageXml }));
  });

  it('rejects repeated primary package rootfile declarations', async () => {
    await rejected(changed('META-INF/container.xml', (source) => source.replace('</rootfiles>', '<rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles>')));
  });

  it('rejects repeated auxiliary rootfile paths', async () => {
    await rejected(changed('META-INF/container.xml', (source) => source.replace('</rootfiles>', '<rootfile full-path="Preview/PrvText.txt" media-type="text/xml"/></rootfiles>')));
  });

  it('rejects undeclared auxiliary paths despite a familiar MIME type', async () => {
    await rejected(changed('META-INF/container.xml', (source) => source.replace('Preview/PrvText.txt', 'Preview/Unknown.txt'), { 'Preview/Unknown.txt': encode('inert') }));
  });

  it.each(['__proto__', 'constructor'])('rejects inherited object-property names as auxiliary rootfiles: %s', async (path) => {
    const container = entries['META-INF/container.xml'];
    if (!container) throw new Error('Synthetic container is absent.');
    const updated = new Map(Object.entries(entries));
    updated.set('META-INF/container.xml', encode(decode(container).replace('Preview/PrvText.txt', path)));
    updated.set(path, encode('inert'));
    // fflate's test writer has an object-key hazard for __proto__. Native zip.js
    // produces the actual ZIP record, so the application receives the intended input.
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false, dataDescriptor: false, zip64: false, extendedTimestamp: false });
    for (const [name, bytes] of updated) await writer.add(name, new Uint8ArrayReader(bytes), { level: 0 });
    await rejected(await writer.close());
  });

  it('requires declared auxiliary paths to exist', async () => {
    const missing = { ...entries };
    delete missing['Preview/PrvText.txt'];
    await rejected(zipSync(missing, { level: 0 }));
  });

  it('rejects contradictory auxiliary MIME types', async () => {
    await rejected(changed('META-INF/container.xml', (source) => source.replace('media-type="text/xml"', 'media-type="application/pdf"')));
  });

  it('retains case-insensitive recognized auxiliary MIME types', async () => {
    const input = changed('META-INF/container.xml', (source) => source.replace('text/xml', 'TEXT/XML').replace('application/rdf+xml', 'APPLICATION/RDF+XML'));
    expect((await preflight(input, 'synthetic.hwpx')).sectionPaths).toEqual(['Contents/section0.xml']);
  });

  it('rejects a declared RDF resource with the wrong XML namespace', async () => {
    await rejected(changed('META-INF/container.rdf', () => '<rdf:RDF xmlns:rdf="urn:synthetic:wrong-rdf"/>'));
  });

  it('rejects DTD in auxiliary RDF before identity selection', async () => {
    await rejected(changed('META-INF/container.rdf', () => '<!DOCTYPE rdf:RDF [<!ENTITY x "inert">]><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">&x;</rdf:RDF>'), 'XML_UNSUPPORTED');
  });

  it('rejects active external href attributes even within an otherwise recognized RDF document', async () => {
    await rejected(changed('META-INF/container.rdf', () => '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description href="https://example.invalid/active-resource"/></rdf:RDF>'), 'XML_UNSUPPORTED');
  });

  it('enforces per-XML declared bytes for RDF, before decompression', async () => {
    const oversized = changed('META-INF/container.rdf', () => `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${' '.repeat(8000)}</rdf:RDF>`);
    await rejected(oversized, 'RESOURCE_LIMIT', { ...RESOURCE_LIMITS, maxXmlBytes: 4000 });
  });

  it('enforces parser depth bounds on RDF', async () => {
    const deep = changed('META-INF/container.rdf', () => `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${'<rdf:Description>'.repeat(20)}${'</rdf:Description>'.repeat(20)}</rdf:RDF>`);
    await rejected(deep, 'RESOURCE_LIMIT', { ...RESOURCE_LIMITS, maxXmlDepth: 10 });
  });

  it('rejects contradictory historical target application declarations', async () => {
    await rejected(changed('version.xml', (source) => source.replace('targetApplication="WORDPROCESSOR"', 'tagetApplication="SPREADSHEET"')));
  });
});
