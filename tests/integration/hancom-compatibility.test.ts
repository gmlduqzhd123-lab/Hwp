import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { preflight } from '../../src/engine/preflight';
import { createDocumentSession } from '../../src/engine/session';
import { makeHancomPackage } from '../helpers/hancom-package';

let fixture: Uint8Array;
let multipleSections: Uint8Array;

beforeAll(async () => {
  fixture = new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url)));
  multipleSections = new Uint8Array(await readFile(new URL('../fixtures/03-spine-order.hwpx', import.meta.url)));
});

describe('documented Hancom HWPX package compatibility with synthetic bytes', () => {
  it.each(['http://www.idpf.org/2007/opf', 'http://www.idpf.org/2007/opf/'])('recognizes the exact OPF namespace %s', async (opfNamespace) => {
    const bytes = makeHancomPackage(fixture, { opfNamespace, auxiliaryRootfiles: false, rootReferences: false, headerInSpine: false });
    expect((await preflight(bytes, 'synthetic.hwpx')).sectionPaths).toEqual(['Contents/section0.xml']);
  });

  it('resolves documented ZIP-root manifest paths', async () => {
    const bytes = makeHancomPackage(fixture, { opfNamespace: 'http://www.idpf.org/2007/opf', auxiliaryRootfiles: false, headerInSpine: false });
    expect((await preflight(bytes, 'synthetic.hwpx')).sectionPaths).toEqual(['Contents/section0.xml']);
  });

  it('reads a verified header in the spine before body sections', async () => {
    const bytes = makeHancomPackage(fixture, { opfNamespace: 'http://www.idpf.org/2007/opf', auxiliaryRootfiles: false, rootReferences: false });
    expect((await preflight(bytes, 'synthetic.hwpx')).sectionPaths).toEqual(['Contents/section0.xml']);
  });

  it('recognizes one HWPX package plus documented preview and RDF rootfiles', async () => {
    const bytes = makeHancomPackage(fixture);
    const session = await createDocumentSession(bytes, 'synthetic.hwpx');
    expect(session.report).toMatchObject({ entryCount: 8, xmlCount: 6, formatVersion: '5.1.1.0', sectionPaths: ['Contents/section0.xml'], supportLevel: 'INSPECT_ONLY' });
    expect(session.exportUnchanged()).toEqual(bytes);
  });

  it('accepts an explicitly declared local PNG preview alongside the primary package', async () => {
    const entries = unzipSync(makeHancomPackage(fixture));
    const container = entries['META-INF/container.xml'];
    if (!container) throw new Error('Synthetic container is absent.');
    entries['META-INF/container.xml'] = new TextEncoder().encode(new TextDecoder().decode(container).replace('</rootfiles>', '<rootfile full-path="Preview/PrvImage.png" media-type="image/png"/></rootfiles>'));
    entries['Preview/PrvImage.png'] = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5YoAAAAASUVORK5CYII=', 'base64'));
    const bytes = zipSync(entries, { level: 0 });
    const session = await createDocumentSession(bytes, 'synthetic.hwpx');
    expect(session.report.sectionPaths).toEqual(['Contents/section0.xml']);
    expect(session.exportUnchanged()).toEqual(bytes);
  });

  it.each(['1.5', '1.31'] as const)('retains format XML version %s without claiming layout support', async (xmlVersion) => {
    const bytes = makeHancomPackage(multipleSections, { xmlVersion });
    const session = await createDocumentSession(bytes, 'synthetic.hwpx');
    expect(session.report.sectionPaths).toEqual(['Contents/section2.xml', 'Contents/section0.xml', 'Contents/section1.xml']);
    expect(session.exportUnchanged()).toEqual(bytes);
    expect((await preflight(session.exportUnchanged(), 'synthetic.hwpx')).sectionPaths).toEqual(session.report.sectionPaths);
  });

  it('recognizes the historical target application spelling written by Hancom’s public model', async () => {
    const entries = unzipSync(makeHancomPackage(fixture));
    const version = entries['version.xml'];
    if (!version) throw new Error('Synthetic version declaration is absent.');
    entries['version.xml'] = new TextEncoder().encode(new TextDecoder().decode(version).replace('targetApplication="WORDPROCESSOR"', 'tagetApplication="WORDPROCESSOR"'));
    const bytes = zipSync(entries, { level: 0 });
    expect((await preflight(bytes, 'synthetic.hwpx')).formatVersion).toBe('5.1.1.0');
  });
});
