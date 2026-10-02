import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { EngineError, safeError } from '../../src/domain/errors';
import { RESOURCE_LIMITS } from '../../src/domain/limits';
import { inspectHwpx, preflight } from '../../src/engine/preflight';

const plain = new Uint8Array(await readFile(new URL('../fixtures/01-plain-text.hwpx', import.meta.url)));
const spine = new Uint8Array(await readFile(new URL('../fixtures/03-spine-order.hwpx', import.meta.url)));
const section = (body: string) => strToU8('<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">' + body + '</hs:sec>');

describe('document reading retains package security and bounded output', () => {
  it.each([
    ['<!DOCTYPE r [<!ENTITY e SYSTEM "https://outside.invalid/PRIVATE_INSPECTION_MARKER">]><r>&e;</r>', 'DTD'],
    ['<r onclick="PRIVATE_INSPECTION_MARKER"/>', 'EVENT_ATTRIBUTE'],
    ['<r src="https://outside.invalid/PRIVATE_INSPECTION_MARKER"/>', 'EXTERNAL_REFERENCE'],
    ['<r><script>PRIVATE_INSPECTION_MARKER</script></r>', 'ACTIVE_CONTENT'],
  ])('refuses unsafe XML before returning any reading model (%#)', async (xml, reason) => {
    const entries = unzipSync(plain);
    entries['Contents/section0.xml'] = strToU8(xml);
    const input = zipSync(entries, { level: 0 });
    const original = input.slice();
    try {
      await inspectHwpx(input, 'PRIVATE_INSPECTION_FILENAME.hwpx');
      expect.fail('Unsafe input produced a model.');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect(safeError(error)).toMatchObject({ code: 'XML_UNSUPPORTED', xmlReason: reason });
      expect(JSON.stringify(safeError(error))).not.toContain('PRIVATE_INSPECTION');
    }
    expect(input).toEqual(original);
  });

  it('bounds retained text nodes across independently valid section entries', async () => {
    const entries = unzipSync(spine);
    const padding = Array.from({ length: 110 }, () => ' <!-- split --> ').join('');
    for (let index = 0; index < 3; index += 1) entries[`Contents/section${index}.xml`] = section(padding + '<hp:p><hp:run><hp:t>bounded</hp:t></hp:run></hp:p>');
    const input = zipSync(entries, { level: 0 });
    const limits = { ...RESOURCE_LIMITS, maxXmlElements: 250 };
    // Element-only preflight passes; the combined retained text-node model
    // would exceed the cap even though each individual index fits.
    await expect(preflight(input, 'synthetic.hwpx', limits)).resolves.toMatchObject({ supportLevel: 'INSPECT_ONLY' });
    await expect(inspectHwpx(input, 'synthetic.hwpx', limits)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('bounds retained reading text across the entire package', async () => {
    const entries = unzipSync(spine);
    for (let index = 0; index < 3; index += 1) entries[`Contents/section${index}.xml`] = section('<hp:p><hp:run><hp:t>' + '가'.repeat(1500) + '</hp:t></hp:run></hp:p>');
    const input = zipSync(entries, { level: 0 });
    const limits = { ...RESOURCE_LIMITS, maxXmlTextLength: 4000 };
    await expect(preflight(input, 'synthetic.hwpx', limits)).resolves.toMatchObject({ supportLevel: 'INSPECT_ONLY' });
    await expect(inspectHwpx(input, 'synthetic.hwpx', limits)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('refuses reading paths that would multiply into oversized model IDs without truncating original locations', async () => {
    const entries = unzipSync(plain);
    const longName = 'x'.repeat(300) + '.xml';
    const xml = entries['Contents/section0.xml'];
    const manifest = entries['Contents/content.hpf'];
    if (!xml || !manifest) throw new Error('Missing synthetic section or manifest.');
    entries[`Contents/${longName}`] = xml;
    delete entries['Contents/section0.xml'];
    entries['Contents/content.hpf'] = strToU8(new TextDecoder().decode(manifest).replace('href="section0.xml"', `href="${longName}"`));
    const input = zipSync(entries, { level: 0 });
    await expect(preflight(input, 'synthetic.hwpx')).resolves.toMatchObject({ sectionPaths: [`Contents/${longName}`] });
    await expect(inspectHwpx(input, 'synthetic.hwpx')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });
});
