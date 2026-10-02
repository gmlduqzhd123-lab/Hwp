// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/lib/zip-core-native.js';
import { SaxesParser } from 'saxes';

const fixtureIds = ['01-plain-text', '02-alternate-prefixes', '03-spine-order', '04-simple-table', '05-unsupported-tables'];
const paragraphNamespace = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const opfNamespace = 'http://www.idpf.org/2007/opf';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function texts(xml: string) {
  const values: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  let collecting = false;
  parser.on('opentag', (tag) => {
    if (tag.uri === paragraphNamespace && tag.local === 't') { values.push(''); collecting = true; }
  });
  parser.on('text', (value) => { if (collecting) values[values.length - 1] += value; });
  parser.on('closetag', (tag) => { if (tag.uri === paragraphNamespace && tag.local === 't') collecting = false; });
  parser.write(xml).close();
  return values;
}

function declaredSections(xml: string) {
  const manifest = new Map<string, string>();
  const spine: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.uri !== opfNamespace) return;
    const value = (name: string) => Object.values(tag.attributes).find((attribute) => attribute.local === name)?.value;
    if (tag.local === 'item') manifest.set(value('id')!, value('href')!);
    if (tag.local === 'itemref') spine.push(value('idref')!);
  });
  parser.write(xml).close();
  return spine.map((id) => `Contents/${manifest.get(id)}`);
}

describe('hand-assembled public fixture goldens (T-01)', () => {
  it.each(fixtureIds)('%s has fixed package/entry bytes, URI-based texts and declared order', async (id) => {
    const bytes = await readFile(new URL(`./${id}.hwpx`, import.meta.url));
    const golden = JSON.parse(await readFile(new URL(`./${id}.golden.json`, import.meta.url), 'utf8'));
    expect(golden.synthetic).toBe(true);
    expect(golden.hancomValidation.status).toBe('NOT_RUN');
    expect(golden.expectedSupportLevel).toBe('INSPECT_ONLY');
    expect(bytes.byteLength).toBe(golden.packageByteLength);
    expect(sha256(bytes)).toBe(golden.packageSha256);
    const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, useCompressionStream: false });
    try {
      const entries = await reader.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(golden.entryNames);
      expect(entries[0]!.filename).toBe('mimetype');
      expect(entries[0]!.compressionMethod).toBe(0);
      const contents = new Map<string, string>();
      for (const entry of entries) {
        if (entry.directory) throw new Error('Unexpected directory in fixture');
        const extracted = await entry.getData(new Uint8ArrayWriter(), { checkSignature: true });
        expect(sha256(extracted)).toBe(golden.entrySha256[entry.filename]);
        contents.set(entry.filename, new TextDecoder('utf-8', { fatal: true }).decode(extracted));
      }
      expect(contents.get('mimetype')).toBe('application/hwp+zip');
      const order = declaredSections(contents.get(golden.packageEntry)!);
      expect(order).toEqual(golden.declaredSectionOrder);
      expect(order.flatMap((path) => texts(contents.get(path)!))).toEqual(golden.paragraphsInDeclaredOrder);
      for (const section of golden.sections) expect(texts(contents.get(section.entryPath)!)).toEqual(section.texts);
      if (id === '03-spine-order') {
        expect(order).toEqual(['Contents/section2.xml', 'Contents/section0.xml', 'Contents/section1.xml']);
      }
      if (id === '01-plain-text') {
        expect(golden.paragraphsInDeclaredOrder[1]).toBe('한글 공백  두 칸\t탭\n줄바꿈 & < > " \' © ∑ 😀');
      }
      if (id === '05-unsupported-tables') {
        expect(golden.tables.map((table: { reason: string }) => table.reason)).toEqual(['MERGED_TABLE', 'NESTED_TABLE', 'NESTED_TABLE']);
      }
    } finally {
      await reader.close();
    }
  });
});
