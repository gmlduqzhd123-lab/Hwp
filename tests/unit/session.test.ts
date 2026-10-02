import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RESOURCE_LIMITS } from '../../src/domain/limits';
import { preflight } from '../../src/engine/preflight';
import { createDocumentSession } from '../../src/engine/session';
import { validateXml } from '../../src/engine/xml/validate';

async function syntheticInput(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url)));
}

describe('session ownership across asynchronous validation', () => {
  it('owns Node Buffer inputs and never exposes Buffer.slice aliases', async () => {
    const input = await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url));
    const expected = new Uint8Array(input);
    const pendingSession = createDocumentSession(input, 'buffer.hwpx');
    input.fill(0);
    const session = await pendingSession;
    const exported = session.exportUnchanged();
    expect(exported).toEqual(expected);
    expect(Buffer.isBuffer(exported)).toBe(false);
    exported.fill(1);
    session.getOriginalBytes().fill(2);
    session.getWorkerBytes().fill(3);
    expect(session.exportUnchanged()).toEqual(expected);
  });

  it('copies direct Node Buffer preflight input before any asynchronous processing', async () => {
    const input = await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url));
    const pending = preflight(input, 'buffer.hwpx');
    input.fill(0);
    expect((await pending).sectionPaths).toEqual(['Contents/section0.xml']);
  });

  it('captures the original before the caller can change its buffer during validation', async () => {
    const input = await syntheticInput();
    const expected = input.slice();
    const pendingSession = createDocumentSession(input, 'synthetic.hwpx');
    input.fill(0);
    const session = await pendingSession;
    expect(session.getOriginalBytes()).toEqual(expected);
    expect(session.exportUnchanged()).toEqual(expected);
    expect(session.report.formatVersion).toBe('5.1.0.0');
  });

  it('also captures direct preflight inputs before asynchronous ZIP reading', async () => {
    const input = await syntheticInput();
    const pendingReport = preflight(input, 'synthetic.hwpx');
    input.fill(0);
    expect((await pendingReport).sectionPaths).toEqual(['Contents/section0.xml']);
  });

  it('keeps custom limits stable when a caller changes its configuration during processing', async () => {
    const input = await syntheticInput();
    const limits = { ...RESOURCE_LIMITS };
    const pendingReport = preflight(input, 'synthetic.hwpx', limits);
    limits.maxUncompressedBytes = 1;
    limits.maxXmlBytes = 1;
    limits.maxXmlDepth = 1;
    expect((await pendingReport).supportLevel).toBe('INSPECT_ONLY');
  });

  it('does not expose a mutable shared report through the session', async () => {
    const session = await createDocumentSession(await syntheticInput(), 'synthetic.hwpx');
    const expected = session.report;
    const exposed = session.report;
    exposed.sectionPaths.push('untrusted.xml');
    exposed.sectionPaths[0] = 'replaced.xml';
    exposed.entryCount = 0;
    exposed.formatVersion = 'changed';
    expect(session.report).toEqual(expected);
    expect(session.report).not.toBe(expected);
    expect(session.report.sectionPaths).not.toBe(expected.sectionPaths);
  });

  it('returns distinct owned buffers for every unchanged export', async () => {
    const session = await createDocumentSession(await syntheticInput(), 'synthetic.hwpx');
    const first = session.exportUnchanged();
    const second = session.exportUnchanged();
    expect(first).toEqual(second);
    expect(first.buffer).not.toBe(second.buffer);
    structuredClone(first, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);
    expect(session.exportUnchanged()).toEqual(second);
  });

  it('bounds cumulative XML elements even when every XML file is individually within its budget', async () => {
    const input = await syntheticInput();
    const counts = Object.entries(unzipSync(input))
      .filter(([path]) => /\.(?:xml|hpf|opf)$/iu.test(path))
      .map(([, bytes]) => validateXml(bytes).elements.length);
    const largestXmlCount = Math.max(...counts);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(largestXmlCount);
    await expect(preflight(input, 'synthetic.hwpx', { ...RESOURCE_LIMITS, maxXmlElements: largestXmlCount }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(input).toEqual(await syntheticInput());
  });
});
