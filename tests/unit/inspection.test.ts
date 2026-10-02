import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { INSPECTION_MAX_ENTRY_PATH_LENGTH } from '../../src/domain/document';
import { RESOURCE_LIMITS } from '../../src/domain/limits';
import { inspectDocument, type InspectionParts } from '../../src/engine/inspection';
import { createNodeCatalog } from '../../src/engine/inspection/nodes';
import { indexXml } from '../../src/engine/xml/index';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HS = 'http://www.hancom.co.kr/hwpml/2011/section';
const HH = 'http://www.hancom.co.kr/hwpml/2011/head';
const fixture = unzipSync(new Uint8Array(readFileSync(new URL('../fixtures/01-plain-text.hwpx', import.meta.url))));
const header = fixture['Contents/header.xml']!;

function section(body: string): string {
  return `<hs:sec xmlns:hs="${HS}" xmlns:hp="${HP}">${body}</hs:sec>`;
}
function paragraph(text: string, id = '0'): string {
  return `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`;
}
function parts(source: string, headerBytes = header): InspectionParts {
  return { header: { path: 'Contents/header.xml', index: indexXml(headerBytes) }, sections: [{ path: 'Contents/section0.xml', index: indexXml(encoder.encode(source)) }] };
}
function tableParts(transform: (source: string) => string): InspectionParts {
  const entries = unzipSync(new Uint8Array(readFileSync(new URL('../fixtures/04-simple-table.hwpx', import.meta.url))));
  return parts(transform(decoder.decode(entries['Contents/section0.xml']!)));
}

describe('inspection text and conservative boundaries', () => {
  it('keeps interleaved text, CDATA, tabs and line breaks in exact order and source spans', () => {
    const source = '\ufeff' + section(paragraph('한😀 &amp;<![CDATA[<직접>]]><hp:tab/>끝<hp:lineBreak/>다음'));
    const bytes = encoder.encode(source);
    const result = inspectDocument(parts(source));
    const run = result.runs[0]!;
    expect(run.text).toBe('한😀 &<직접>\t끝\n다음');
    expect(run.segments.map((segment) => segment.kind)).toEqual(['TEXT', 'CDATA', 'TAB', 'TEXT', 'LINE_BREAK', 'TEXT']);
    const raw = run.segments.map((segment) => decoder.decode(bytes.subarray(segment.sourceSpan.startByte, segment.sourceSpan.endByte)));
    expect(raw).toEqual(['한😀 &amp;', '<![CDATA[<직접>]]>', '<hp:tab/>', '끝', '<hp:lineBreak/>', '다음']);
    expect(result.editingEnabled).toBe(false);
  });

  it('leaves unrecognized text controls explicit and read only', () => {
    const result = inspectDocument(parts(section(paragraph('앞<hp:nbSpace/>뒤'))));
    expect(result.runs[0]!.segments[1]).toMatchObject({ kind: 'UNKNOWN_CONTROL', text: '', elementName: 'paragraph:nbSpace' });
    expect(result.paragraphs[0]!.reasons).toContain('UNSUPPORTED_CONTROL');
    expect(result.paragraphs[0]!.correctionCandidate).toBe(false);
  });

  it('does not treat an element in another namespace as an HWPX tab', () => {
    const source = section(paragraph('앞<x:tab xmlns:x="urn:foreign"/>뒤'));
    const result = inspectDocument(parts(source));
    expect(result.runs[0]!.text).toBe('앞뒤');
    expect(result.runs[0]!.segments[1]!.kind).toBe('UNKNOWN_CONTROL');
    expect(result.paragraphs[0]!.reasons).toContain('UNKNOWN_NAMESPACE');
  });

  it('tracks field spans across paragraphs until their end marker', () => {
    const first = '<hp:p><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="1"/></hp:ctrl><hp:t>필드 시작</hp:t></hp:run></hp:p>';
    const last = '<hp:p><hp:run charPrIDRef="0"><hp:t>필드 끝</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1"/></hp:ctrl></hp:run></hp:p>';
    const result = inspectDocument(parts(section(first + paragraph('필드 내부', '1') + last + paragraph('필드 밖', '3'))));
    expect(result.paragraphs.map((entry) => entry.reasons.includes('FIELD_CONTROL'))).toEqual([true, true, true, false]);
  });

  it('does not close an active field on an unrelated end reference', () => {
    const begin = '<hp:p><hp:run><hp:ctrl><hp:fieldBegin id="1"/></hp:ctrl></hp:run></hp:p>';
    const wrongEnd = '<hp:p><hp:run><hp:ctrl><hp:fieldEnd beginIDRef="2"/></hp:ctrl></hp:run></hp:p>';
    const result = inspectDocument(parts(section(begin + wrongEnd + paragraph('아직 필드 내부'))));
    expect(result.paragraphs[2]!.reasons).toContain('FIELD_CONTROL');
    expect(result.paragraphs[2]!.correctionCandidate).toBe(false);
  });

  it('classifies header, footer and note paragraphs without leaking their text into carrier runs', () => {
    const inside = (name: string, text: string) => `<hp:p><hp:run charPrIDRef="0"><hp:ctrl><hp:${name}><hp:subList>${paragraph(text)}</hp:subList></hp:${name}></hp:ctrl></hp:run></hp:p>`;
    const result = inspectDocument(parts(section(inside('header', '머리말') + inside('footer', '꼬리말') + inside('footNote', '각주'))));
    expect(result.paragraphs.filter((entry) => entry.text).map((entry) => [entry.text, entry.context])).toEqual([['머리말', 'HEADER'], ['꼬리말', 'FOOTER'], ['각주', 'NOTE']]);
    expect(result.runs.filter((run) => !run.text)).toHaveLength(3);
    expect(result.paragraphs.every((entry) => !entry.correctionCandidate)).toBe(true);
  });

  it('assigns unique deterministic keys even when XML ids repeat', () => {
    const input = parts(section(paragraph('하나') + paragraph('둘')));
    const first = inspectDocument(input);
    const second = inspectDocument(input);
    expect(first.paragraphs.map((entry) => entry.sourceId)).toEqual(['0', '0']);
    expect(new Set(first.paragraphs.map((entry) => entry.nodeId)).size).toBe(2);
    expect(second).toEqual(first);
  });
});

describe('inspection table geometry', () => {
  it('preserves original row and cell order while rejecting duplicate cell addresses', () => {
    const result = inspectDocument(tableParts((source) => source.replace('colAddr="1" rowAddr="0"', 'colAddr="0" rowAddr="0"')));
    expect(result.cells.map((cell) => cell.text)).toEqual(['첫째 칸', '둘째 칸', '셋째 칸', '넷째 칸']);
    expect(result.tables[0]!.reasons).toContain('INVALID_TABLE_STRUCTURE');
    expect(result.cells.every((cell) => !cell.correctionCandidate)).toBe(true);
  });

  it('keeps malformed spans unknown instead of inventing one or zero', () => {
    const result = inspectDocument(tableParts((source) => source.replace('colSpan="1" rowSpan="1"', 'colSpan="0" rowSpan="n/a"')));
    expect(result.cells[0]).toMatchObject({ columnSpan: null, rowSpan: null });
    expect(result.tables[0]!.reasons).toContain('INVALID_TABLE_STRUCTURE');
  });

  it('never allocates a declared enormous grid', () => {
    const result = inspectDocument(tableParts((source) => source.replace('rowCnt="2" colCnt="2"', 'rowCnt="9007199254740991" colCnt="9007199254740991"')));
    expect(result.tables[0]).toMatchObject({ rows: Number.MAX_SAFE_INTEGER, columns: Number.MAX_SAFE_INTEGER });
    expect(result.rows).toHaveLength(2);
    expect(result.cells).toHaveLength(4);
    expect(result.tables[0]!.reasons).toContain('INVALID_TABLE_STRUCTURE');
  });

  it('makes foreign table children explicit instead of accepting their local name', () => {
    const result = inspectDocument(tableParts((source) => source.replace('<hp:cellMargin left="0" right="0" top="0" bottom="0"/>', '<x:cellMargin xmlns:x="urn:foreign"/>')));
    expect(result.tables[0]!.reasons).toContain('UNKNOWN_NAMESPACE');
    expect(result.cells[0]!.reasons).toContain('UNKNOWN_ELEMENT');
  });
});

describe('inspection report bounds', () => {
  it('bounds namespace and local-name amplification in descendant paths', () => {
    const uri = `urn:${'x'.repeat(8192)}`;
    const local = 'long' + 'x'.repeat(8192);
    const source = section(`<x:${local} xmlns:x="${uri}">${paragraph('합성').repeat(200)}</x:${local}>`);
    const result = inspectDocument(parts(source));
    expect(result.paragraphs).toHaveLength(200);
    expect(result.paragraphs.every((entry) => entry.structurePath.length <= 512)).toBe(true);
    expect(result.paragraphs.reduce((sum, entry) => sum + entry.structurePath.length, 0)).toBeLessThan(source.length * 2);
  });

  it('uses a complete ordinal ancestor path when descriptive paths would be long', () => {
    const wrappers = Array.from({ length: 35 }, (_, index) => `wrapper${index}`);
    const source = section(wrappers.map((name) => `<hp:${name}>`).join('') + paragraph('합성') + [...wrappers].reverse().map((name) => `</hp:${name}>`).join(''));
    const input = parts(source);
    const node = input.sections[0]!.index.elements.find((element) => element.local === 'p')!;
    const identity = createNodeCatalog('Contents/section0.xml', input.sections[0]!.index).identity(node);
    expect(identity.structurePath).toMatch(/^\/element-path\/0\//);
    expect(identity.structurePath.split('/')).toHaveLength(39);
    expect(identity.structurePath.length).toBeLessThan(512);
  });

  it('keeps short namespace identities distinct in structural paths', () => {
    const source = section(`<a:wrapper xmlns:a="urn:first">${paragraph('하나')}</a:wrapper><b:wrapper xmlns:b="urn:second">${paragraph('둘')}</b:wrapper>`);
    const result = inspectDocument(parts(source));
    expect(result.paragraphs[0]!.structurePath).not.toBe(result.paragraphs[1]!.structurePath);
    expect(result.paragraphs.every((entry) => entry.structurePath.includes('foreign-'))).toBe(true);
  });

  it('applies a package cumulative element plus text-node budget', () => {
    const input = parts(section(paragraph('합성')));
    const elements = input.header.index.elements.length + input.sections[0]!.index.elements.length;
    expect(() => inspectDocument(input, { ...RESOURCE_LIMITS, maxXmlElements: elements })).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });

  it('counts decoded text as UTF-8 bytes for the inspection aggregate limit', () => {
    const compactHeader = encoder.encode(`<hh:head xmlns:hh="${HH}"/>`);
    const input = parts(section('<hp:p><hp:run><hp:t>한글</hp:t></hp:run></hp:p>'), compactHeader);
    expect(() => inspectDocument(input, { ...RESOURCE_LIMITS, maxXmlTextLength: 5 })).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });

  it('rejects repeated entry paths that would alias node keys', () => {
    const input = parts(section(paragraph('합성')));
    input.sections.push(input.sections[0]!);
    expect(() => inspectDocument(input)).toThrowError(expect.objectContaining({ code: 'FILE_INVALID_PACKAGE' }));
  });

  it('bounds entry paths before multiplying them into model node keys and spans', () => {
    const input = parts(section(paragraph('합성')));
    input.sections[0]!.path = 'x'.repeat(INSPECTION_MAX_ENTRY_PATH_LENGTH + 1) + '.xml';
    expect(() => inspectDocument(input)).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });
});
