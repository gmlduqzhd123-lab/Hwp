import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError } from '../../src/domain/errors';
import { preflight } from '../../src/engine/preflight';
import { createDocumentSession } from '../../src/engine/session';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
let fixture: Record<string, Uint8Array>;
let multiSection: Record<string, Uint8Array>;

function modified(
  source: Record<string, Uint8Array>,
  path: string,
  change: (xml: string) => string,
): Uint8Array {
  const bytes = source[path];
  if (!bytes) throw new Error(`Missing trusted synthetic component ${path}`);
  const before = decode(bytes);
  const after = change(before);
  expect(after).not.toBe(before);
  return zipSync({ ...source, [path]: encode(after) }, { level: 0 });
}

async function expectRejectedIntact(bytes: Uint8Array): Promise<void> {
  const original = new Uint8Array(bytes);
  const hash = createHash('sha256').update(original).digest('hex');
  let caught: unknown;
  try {
    await createDocumentSession(bytes, 'PRIVATE_SYNTHETIC_FILENAME.hwpx');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineError);
  expect(caught).toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  expect((caught as EngineError).message).not.toContain('PRIVATE_SYNTHETIC_FILENAME');
  expect((caught as EngineError).message).not.toContain(hash);
  expect(bytes).toEqual(original);
}

beforeAll(async () => {
  fixture = unzipSync(new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url))));
  multiSection = unzipSync(new Uint8Array(await readFile(new URL('../fixtures/03-spine-order.hwpx', import.meta.url))));
});

describe('HWPX semantic package identity under adversarial declarations', () => {
  it('accepts trusted reconstructed packages and their explicitly declared order', async () => {
    expect((await preflight(zipSync(fixture, { level: 0 }), 'synthetic.hwpx')).sectionPaths)
      .toEqual(['Contents/section0.xml']);
    expect((await preflight(zipSync(multiSection, { level: 0 }), 'synthetic.hwpx')).sectionPaths)
      .toEqual(['Contents/section2.xml', 'Contents/section0.xml', 'Contents/section1.xml']);
  });

  it('rejects a declared spreadsheet application masquerading as HWPX', async () => {
    await expectRejectedIntact(modified(fixture, 'version.xml', (xml) =>
      xml.replace('targetApplication="WORDPROCESSOR"', 'targetApplication="SPREADSHEET"')));
  });

  it('rejects a container rootfile whose declared media type contradicts the package', async () => {
    await expectRejectedIntact(modified(fixture, 'META-INF/container.xml', (xml) =>
      xml.replace('media-type="application/hwpml-package+xml"', 'media-type="application/pdf"')));
  });

  it('rejects a declared section media type that contradicts its XML role', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('id="section0" href="section0.xml" media-type="application/xml"',
        'id="section0" href="section0.xml" media-type="application/pdf"')));
  });

  it('rejects a section declared in the manifest but absent from the spine', async () => {
    const header = multiSection['Contents/header.xml'];
    if (!header) throw new Error('Missing trusted synthetic header');
    const changedHeader = decode(header).replace('secCnt="3"', 'secCnt="2"');
    expect(changedHeader).not.toBe(decode(header));
    // Keep the header count consistent with the shortened spine so this tests
    // manifest completeness independently of the header-count check.
    const bytes = modified({ ...multiSection, 'Contents/header.xml': encode(changedHeader) }, 'Contents/content.hpf', (xml) =>
      xml.replace('<opf:itemref idref="section1" linear="yes"/>', ''));
    await expectRejectedIntact(bytes);
  });

  it('rejects conflicting duplicate rootfile declarations', async () => {
    await expectRejectedIntact(modified(fixture, 'META-INF/container.xml', (xml) =>
      xml.replace('</rootfiles>', '<rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles>')));
  });

  it('rejects a spine referring to an undeclared manifest ID', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('idref="section0"', 'idref="missingSection"')));
  });

  it('rejects duplicate section references in the spine', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('</opf:spine>', '<opf:itemref idref="section0" linear="yes"/></opf:spine>')));
  });

  it('rejects distinct manifest IDs that claim the same XML resource', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('</opf:manifest>', '<opf:item id="alias" href="section0.xml" media-type="application/xml"/></opf:manifest>')));
  });

  it('rejects a manifest ID that points to a missing package resource', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('href="section0.xml"', 'href="missing.xml"')));
  });

  it('rejects a section reference to a header document despite a valid manifest target', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('idref="section0"', 'idref="header"')));
  });

  it('rejects a section whose root local name matches but its namespace URI does not', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/section0.xml', (xml) =>
      xml.replace('http://www.hancom.co.kr/hwpml/2011/section', 'urn:synthetic:wrong-section')));
  });

  it('rejects a namespaced href masquerading as the required unqualified manifest href', async () => {
    await expectRejectedIntact(modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('href="section0.xml"', 'xmlns:decoy="urn:synthetic:decoy" decoy:href="section0.xml"')));
  });

  it('uses real unqualified identity attributes in the presence of foreign namespace attributes', async () => {
    const bytes = modified(fixture, 'Contents/content.hpf', (xml) =>
      xml.replace('href="section0.xml"',
        'xmlns:decoy="urn:synthetic:decoy" href="section0.xml" decoy:href="missing.xml" decoy:id="header"'));
    const session = await createDocumentSession(bytes, 'synthetic.hwpx');
    expect(session.report.sectionPaths).toEqual(['Contents/section0.xml']);
    expect(session.exportUnchanged()).toEqual(bytes);
  });

  it('recognizes equivalent case-insensitive MIME type declarations', async () => {
    const container = fixture['META-INF/container.xml'];
    const packageXml = fixture['Contents/content.hpf'];
    if (!container || !packageXml) throw new Error('Trusted package identity is absent');
    const bytes = zipSync({
      ...fixture,
      'META-INF/container.xml': encode(decode(container).replace('application/hwpml-package+xml', 'APPLICATION/HWPML-PACKAGE+XML')),
      'Contents/content.hpf': encode(decode(packageXml).replaceAll('application/xml', 'APPLICATION/XML')),
    }, { level: 0 });
    const session = await createDocumentSession(bytes, 'synthetic.hwpx');
    expect(session.report.sectionPaths).toEqual(['Contents/section0.xml']);
    expect(session.exportUnchanged()).toEqual(bytes);
  });

  it('keeps harmless undeclared opaque binary resources without inventing a format failure', async () => {
    const bytes = zipSync({ ...fixture, 'BinData/unused.bin': encode('inert synthetic data') }, { level: 0 });
    const session = await createDocumentSession(bytes, 'synthetic.hwpx');
    expect(session.report.supportLevel).toBe('INSPECT_ONLY');
    expect(session.exportUnchanged()).toEqual(bytes);
  });
});
