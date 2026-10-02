import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { DocumentInspection, InspectionNode, SourceSpan } from '../../src/domain/document';
import { inspectHwpx, preflight } from '../../src/engine/preflight';
import { createInspectionSession } from '../../src/engine/session';
import { makeHancomPackage } from '../helpers/hancom-package';

const fixtureNames = [
  '01-plain-text', '02-alternate-prefixes', '03-spine-order',
  '04-simple-table', '05-unsupported-tables',
] as const;

interface Golden {
  declaredSectionOrder: string[];
  paragraphsInDeclaredOrder: string[];
  tables: Array<{ id: string; rows: number; columns: number; reason: string }>;
}

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

async function fixture(name: (typeof fixtureNames)[number] = fixtureNames[0]): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../fixtures/${name}.hwpx`, import.meta.url)));
}

async function golden(name: string): Promise<Golden> {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.golden.json`, import.meta.url), 'utf8')) as Golden;
}

function changed(bytes: Uint8Array, path: string, transform: (xml: string) => string): Uint8Array {
  // Only tiny trusted synthetic input is expanded by this test helper.
  const entries = unzipSync(bytes);
  const entry = entries[path];
  if (!entry) throw new Error('Trusted synthetic component is absent.');
  const original = decode(entry);
  const modified = transform(original);
  expect(modified).not.toBe(original);
  return zipSync({ ...entries, [path]: encode(modified) }, { level: 0 });
}

function sliceSpan(entries: Record<string, Uint8Array>, span: SourceSpan): string {
  const entry = entries[span.entryPath];
  if (!entry) throw new Error('A model span points to a missing source entry.');
  expect(Number.isSafeInteger(span.startByte)).toBe(true);
  expect(Number.isSafeInteger(span.endByte)).toBe(true);
  expect(span.startByte).toBeGreaterThanOrEqual(0);
  expect(span.endByte).toBeGreaterThan(span.startByte);
  expect(span.endByte).toBeLessThanOrEqual(entry.byteLength);
  return decode(entry.subarray(span.startByte, span.endByte));
}

function nodes(inspection: DocumentInspection): InspectionNode[] {
  return [...inspection.sections, ...inspection.paragraphs, ...inspection.runs,
    ...inspection.tables, ...inspection.rows, ...inspection.cells];
}

function assertElementSpans(bytes: Uint8Array, inspection: DocumentInspection): void {
  const entries = unzipSync(bytes);
  const groups: Array<[InspectionNode[], string]> = [
    [inspection.sections, 'sec'], [inspection.paragraphs, 'p'], [inspection.runs, 'run'],
    [inspection.tables, 'tbl'], [inspection.rows, 'tr'], [inspection.cells, 'tc'],
  ];
  for (const [group, local] of groups) {
    for (const node of group) {
      const source = sliceSpan(entries, node.sourceSpan);
      expect(source).toMatch(new RegExp(`^<(?:[A-Za-z_][\\w.-]*:)?${local}(?=[\\s/>])`, 'u'));
      expect(source).toMatch(new RegExp(`(?:</(?:[A-Za-z_][\\w.-]*:)?${local}\\s*>|/>)$`, 'u'));
      expect(node.structurePath).not.toBe('');
      expect(node.supportLevel).toBe('INSPECT_ONLY');
    }
  }
}

describe('T-03 / AC-04–06 real package-to-inspection integration', () => {
  it.each(fixtureNames)('%s matches independent text, section order, and table goldens', async (name) => {
    const bytes = await fixture(name);
    const original = bytes.slice();
    const expected = await golden(name);
    const { report, inspection } = await inspectHwpx(bytes, `${name}.hwpx`);

    expect(report).toEqual(await preflight(bytes, `${name}.hwpx`));
    expect(inspection.supportLevel).toBe('INSPECT_ONLY');
    expect(inspection.editingEnabled).toBe(false);
    expect(inspection.sections.map((section) => section.entryPath)).toEqual(expected.declaredSectionOrder);
    expect(inspection.sections.map((section) => section.order)).toEqual(expected.declaredSectionOrder.map((_, index) => index));
    // A paragraph containing a table must not claim the text of its child cells.
    expect(inspection.paragraphs.filter((paragraph) => paragraph.text !== '').map((paragraph) => paragraph.text))
      .toEqual(expected.paragraphsInDeclaredOrder);
    expect(inspection.tables.map((table) => ({ id: table.sourceId, rows: table.rows, columns: table.columns })))
      .toEqual(expected.tables.map(({ id, rows, columns }) => ({ id, rows, columns })));
    const allNodes = nodes(inspection);
    expect(new Set(allNodes.map((node) => node.nodeId)).size).toBe(allNodes.length);
    expect(inspection.summary).toMatchObject({
      sectionCount: inspection.sections.length, paragraphCount: inspection.paragraphs.length,
      runCount: inspection.runs.length, tableCount: inspection.tables.length, cellCount: inspection.cells.length,
    });
    assertElementSpans(bytes, inspection);
    expect(bytes).toEqual(original);
    const session = await createInspectionSession(bytes, `${name}.hwpx`);
    expect(session.inspection).toEqual(inspection);
    expect(session.exportUnchanged()).toEqual(original);
    expect(session.originalSha256).toBe(createHash('sha256').update(original).digest('hex'));
    const reopened = await inspectHwpx(session.exportUnchanged(), `${name}.hwpx`);
    expect(reopened.inspection).toEqual(inspection);
  });

  it('preserves Korean, repeated spaces, literal tabs/newlines, symbols, and emoji with original XML tokens', async () => {
    const bytes = await fixture();
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const paragraph = inspection.paragraphs.find((item) => item.sourceId === '1');
    expect(paragraph?.text).toBe('한글 공백  두 칸\t탭\n줄바꿈 & < > " \' © ∑ 😀');
    const run = inspection.runs.find((item) => item.paragraphId === paragraph?.nodeId);
    expect(run?.text).toBe(paragraph?.text);
    if (!run) throw new Error('Expected synthetic run was not inspected.');
    const rawText = run.segments.map((segment) => sliceSpan(unzipSync(bytes), segment.sourceSpan)).join('');
    expect(rawText).toBe('한글 공백  두 칸\t탭\n줄바꿈 &amp; &lt; &gt; " \' © ∑ 😀');
    expect(run.segments.map((segment) => segment.text).join('')).toBe(paragraph?.text);
    expect(run.characterFormat.reference).toMatchObject({ requestedId: '1', resolved: true });
    expect(run.characterFormat.fontSize).toMatchObject({ value: 12, rawValue: '1200', unit: 'pt' });
    expect(run.characterFormat.fonts.HANGUL.value).toBe('함초롬바탕');
  });

  it('records actual format references and leaves absent values unknown instead of inventing zero', async () => {
    const { inspection } = await inspectHwpx(await fixture(), 'synthetic.hwpx');
    expect(inspection.formats.fonts).toHaveLength(7);
    expect(inspection.formats.characterShapes.map((shape) => shape.id)).toEqual(['0', '1']);
    const paragraph = inspection.paragraphs[0]!;
    expect(paragraph.paragraphFormat.reference).toMatchObject({ requestedId: '0', resolved: true });
    expect(paragraph.paragraphFormat.alignment.value).toBe('JUSTIFY');
    expect(paragraph.paragraphFormat.lineSpacing.value).toBeNull();
    expect(paragraph.paragraphFormat.lineSpacing.reasons).toContain('MISSING_FORMAT_VALUE');
    // The committed synthetic header deliberately has no style definitions.
    expect(paragraph.styleReference).toMatchObject({ requestedId: '0', resolved: false });
    expect(paragraph.styleReference.reasons).toContain('MISSING_FORMAT_REFERENCE');
  });

  it('keeps simple-table rows, addresses, spans, and cell paragraphs separate from the carrier paragraph', async () => {
    const { inspection } = await inspectHwpx(await fixture('04-simple-table'), 'synthetic.hwpx');
    const table = inspection.tables[0]!;
    expect(table).toMatchObject({ sourceId: '10', rows: 2, columns: 2, parentTableId: null });
    expect(table.rowIds).toHaveLength(2);
    expect(table.cellIds).toHaveLength(4);
    expect(table.reasons).not.toContain('MERGED_TABLE');
    expect(table.reasons).not.toContain('NESTED_TABLE');
    const cells = table.cellIds.map((id) => inspection.cells.find((cell) => cell.nodeId === id)!);
    expect(cells.map((cell) => [cell.rowAddress, cell.columnAddress, cell.rowSpan, cell.columnSpan, cell.text]))
      .toEqual([[0, 0, 1, 1, '첫째 칸'], [0, 1, 1, 1, '둘째 칸'], [1, 0, 1, 1, '셋째 칸'], [1, 1, 1, 1, '넷째 칸']]);
    for (const cell of cells) {
      expect(cell.paragraphIds).toHaveLength(1);
      const paragraph = inspection.paragraphs.find((item) => item.nodeId === cell.paragraphIds[0]);
      expect(paragraph).toMatchObject({ context: 'TABLE_CELL', parentCellId: cell.nodeId, text: cell.text });
    }
    expect(inspection.paragraphs.find((paragraph) => paragraph.sourceId === '1')?.text).toBe('');
  });

  it('protects merged and nested table boundaries without double counting nested cells', async () => {
    const { inspection } = await inspectHwpx(await fixture('05-unsupported-tables'), 'synthetic.hwpx');
    const merged = inspection.tables.find((table) => table.sourceId === '20')!;
    const outer = inspection.tables.find((table) => table.sourceId === '30')!;
    const nested = inspection.tables.find((table) => table.sourceId === '33')!;
    expect(merged.reasons).toContain('MERGED_TABLE');
    expect(outer.reasons).toContain('NESTED_TABLE');
    expect(nested.reasons).toContain('NESTED_TABLE');
    expect([merged.correctionCandidate, outer.correctionCandidate, nested.correctionCandidate]).toEqual([false, false, false]);
    expect(merged.cellIds).toHaveLength(3);
    expect(outer.cellIds).toHaveLength(1);
    expect(nested.cellIds).toHaveLength(1);
    expect(nested.parentTableId).toBe(outer.nodeId);
    const outerCell = inspection.cells.find((cell) => cell.nodeId === outer.cellIds[0])!;
    // Cell excerpts separate their own paragraphs with newlines, including the
    // empty paragraph carrying the nested table. Nested cell text stays separate.
    expect(outerCell.paragraphIds.map((id) => inspection.paragraphs.find((paragraph) => paragraph.nodeId === id)?.text))
      .toEqual(['바깥 칸', '']);
    expect(outerCell.text).toBe('바깥 칸\n');
    expect(inspection.cells.find((cell) => cell.nodeId === nested.cellIds[0])?.text).toBe('중첩된 칸');
    const spanned = inspection.cells.find((cell) => cell.tableId === merged.nodeId && cell.columnSpan === 2);
    expect(spanned).toMatchObject({ rowAddress: 0, columnAddress: 0, rowSpan: 1, columnSpan: 2 });
  });

  it('uses entry byte offsets after BOM, CRLF and multibyte text rather than UTF-16 character indices', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => '\ufeff' + xml.replaceAll('\n', '\r\n'));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const entry = unzipSync(bytes)['Contents/section0.xml']!;
    const xml = decode(entry);
    const paragraph = inspection.paragraphs.find((item) => item.sourceId === '1')!;
    const marker = '<hp:p id="1"';
    const characterIndex = xml.indexOf(marker);
    expect(characterIndex).toBeGreaterThan(0);
    const expectedByteStart = encode(xml.slice(0, characterIndex)).byteLength;
    expect(expectedByteStart).not.toBe(characterIndex);
    expect(paragraph.sourceSpan.startByte).toBe(expectedByteStart);
    const expectedXml = xml.slice(characterIndex, xml.indexOf('</hp:p>', characterIndex) + '</hp:p>'.length);
    expect(sliceSpan(unzipSync(bytes), paragraph.sourceSpan)).toBe(expectedXml);
    expect(expectedXml).toContain('\r\n');
    expect(paragraph.text).toBe((await golden('01-plain-text')).paragraphsInDeclaredOrder[1]);
    assertElementSpans(bytes, inspection);
    expect((await createInspectionSession(bytes, 'synthetic.hwpx')).exportUnchanged()).toEqual(bytes);
  });

  it('reads CDATA and explicit inline tab/line-break controls while preserving their original source tokens', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => xml.replace(
      '<hp:t>합성 연구 보고서</hp:t>', '<hp:t><![CDATA[가 & <원문>]]><hp:tab/>나<hp:lineBreak/>다 😀</hp:t>',
    ));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const paragraph = inspection.paragraphs[0]!;
    expect(paragraph.text).toBe('가 & <원문>\t나\n다 😀');
    const run = inspection.runs.find((item) => item.paragraphId === paragraph.nodeId)!;
    expect(run.segments.map((segment) => segment.kind)).toEqual(['CDATA', 'TAB', 'TEXT', 'LINE_BREAK', 'TEXT']);
    expect(run.segments.map((segment) => sliceSpan(unzipSync(bytes), segment.sourceSpan)))
      .toEqual(['<![CDATA[가 & <원문>]]>', '<hp:tab/>', '나', '<hp:lineBreak/>', '다 😀']);
    expect((await createInspectionSession(bytes, 'synthetic.hwpx')).exportUnchanged()).toEqual(bytes);
  });

  it('does not confuse repeated descriptive paragraph IDs with unique structural model keys', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => xml.replace('<hp:p id="1"', '<hp:p id="0"'));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    expect(inspection.paragraphs.map((paragraph) => paragraph.sourceId)).toEqual(['0', '0']);
    expect(new Set(inspection.paragraphs.map((paragraph) => paragraph.nodeId)).size).toBe(2);
    expect(new Set(inspection.paragraphs.map((paragraph) => paragraph.structurePath)).size).toBe(2);
    expect(inspection.paragraphs.map((paragraph) => paragraph.text)).toEqual((await golden('01-plain-text')).paragraphsInDeclaredOrder);
  });

  it('keeps mixed-format run order and references without combining runs or applying a uniform shape', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => xml.replace(
      '<hp:run charPrIDRef="0"><hp:t>합성 연구 보고서</hp:t></hp:run>',
      '<hp:run charPrIDRef="0"><hp:t>앞</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>뒤</hp:t></hp:run>',
    ));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const paragraph = inspection.paragraphs[0]!;
    const runs = paragraph.runIds.map((id) => inspection.runs.find((run) => run.nodeId === id)!);
    expect(paragraph.text).toBe('앞뒤');
    expect(runs.map((run) => run.text)).toEqual(['앞', '뒤']);
    expect(runs.map((run) => run.characterFormat.reference.requestedId)).toEqual(['0', '1']);
    expect(runs.map((run) => run.characterFormat.fontSize.value)).toEqual([11, 12]);
    assertElementSpans(bytes, inspection);
    expect((await createInspectionSession(bytes, 'synthetic.hwpx')).exportUnchanged()).toEqual(bytes);
  });

  it('marks a foreign namespace using the familiar text local name instead of pretending it is a supported run', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => xml.replace(
      '<hp:t>합성 연구 보고서</hp:t>', '<foreign:t xmlns:foreign="urn:synthetic:foreign">합성 연구 보고서</foreign:t>',
    ));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const paragraph = inspection.paragraphs[0]!;
    const run = inspection.runs.find((item) => item.paragraphId === paragraph.nodeId)!;
    expect(run.reasons).toContain('UNKNOWN_NAMESPACE');
    expect(run.correctionCandidate).toBe(false);
    expect(run.segments).toContainEqual(expect.objectContaining({ kind: 'UNKNOWN_CONTROL' }));
    expect(paragraph.correctionCandidate).toBe(false);
    expect(inspection.editingEnabled).toBe(false);
    expect((await createInspectionSession(bytes, 'synthetic.hwpx')).exportUnchanged()).toEqual(bytes);
  });

  it('marks a non-text object in a run as protected while retaining surrounding text and the original bytes', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => xml.replace(
      '<hp:t>합성 연구 보고서</hp:t>', '<hp:t>합성 연구 보고서</hp:t><hp:pic binaryItemIDRef="synthetic-image"/>',
    ));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const paragraph = inspection.paragraphs[0]!;
    const run = inspection.runs.find((item) => item.paragraphId === paragraph.nodeId)!;
    expect(paragraph.text).toBe('합성 연구 보고서');
    expect(run.reasons).toContain('NON_TEXT_OBJECT');
    expect(run.correctionCandidate).toBe(false);
    expect(paragraph.correctionCandidate).toBe(false);
    expect(run.segments).toContainEqual(expect.objectContaining({ kind: 'UNKNOWN_CONTROL' }));
    expect((await createInspectionSession(bytes, 'synthetic.hwpx')).exportUnchanged()).toEqual(bytes);
  });

  it.each([
    { opfNamespace: 'http://www.idpf.org/2007/opf', rootReferences: false, headerInSpine: false, auxiliaryRootfiles: false },
    { opfNamespace: 'http://www.idpf.org/2007/opf/', rootReferences: true, headerInSpine: true, auxiliaryRootfiles: true },
  ])('reads the same actual body from documented Hancom variant %j', async (options) => {
    const bytes = makeHancomPackage(await fixture('03-spine-order'), options);
    const { report, inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    expect(report.sectionPaths).toEqual((await golden('03-spine-order')).declaredSectionOrder);
    expect(inspection.paragraphs.map((paragraph) => paragraph.text)).toEqual((await golden('03-spine-order')).paragraphsInDeclaredOrder);
    expect(inspection.sections.map((section) => section.entryPath)).toEqual(report.sectionPaths);
    expect((await createInspectionSession(bytes, 'synthetic.hwpx')).exportUnchanged()).toEqual(bytes);
  });
});

describe('T-03 references remain inspect-only when information is missing or ambiguous', () => {
  it('marks a missing character shape without inventing a default font size', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => xml.replace('charPrIDRef="1"', 'charPrIDRef="999"'));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const run = inspection.runs.find((item) => item.characterFormat.reference.requestedId === '999')!;
    expect(run.characterFormat.reference.resolved).toBe(false);
    expect(run.characterFormat.reference.reasons).toContain('MISSING_FORMAT_REFERENCE');
    expect(run.characterFormat.fontSize.value).toBeNull();
    expect(run.correctionCandidate).toBe(false);
    expect((await createInspectionSession(bytes, 'synthetic.hwpx')).exportUnchanged()).toEqual(bytes);
  });

  it('marks a missing paragraph shape while keeping the actual text', async () => {
    const bytes = changed(await fixture(), 'Contents/section0.xml', (xml) => xml.replace('paraPrIDRef="0"', 'paraPrIDRef="999"'));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const paragraph = inspection.paragraphs.find((item) => item.paragraphFormat.reference.requestedId === '999')!;
    expect(paragraph.paragraphFormat.reference.resolved).toBe(false);
    expect(paragraph.paragraphFormat.alignment.value).toBeNull();
    expect(paragraph.paragraphFormat.reference.reasons).toContain('MISSING_FORMAT_REFERENCE');
    expect(paragraph.text).toBe('합성 연구 보고서');
    expect(paragraph.correctionCandidate).toBe(false);
  });

  it('marks a missing language-specific font reference without replacing its face', async () => {
    const bytes = changed(await fixture(), 'Contents/header.xml', (xml) => xml.replace('hangul="0"', 'hangul="999"'));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const run = inspection.runs.find((item) => item.characterFormat.reference.requestedId === '0')!;
    expect(run.characterFormat.fonts.HANGUL.value).toBeNull();
    expect(run.characterFormat.fonts.HANGUL.reasons).toContain('MISSING_FORMAT_REFERENCE');
    expect(run.characterFormat.fonts.LATIN.value).toBe('함초롬바탕');
    expect(run.characterFormat.fontSize.value).toBe(11);
  });

  it('marks duplicate format definitions as ambiguous rather than picking the last shape', async () => {
    const bytes = changed(await fixture(), 'Contents/header.xml', (xml) => xml.replace('<hh:charPr id="1"', '<hh:charPr id="0"'));
    const { inspection } = await inspectHwpx(bytes, 'synthetic.hwpx');
    const run = inspection.runs.find((item) => item.characterFormat.reference.requestedId === '0')!;
    expect(run.characterFormat.reference.resolved).toBe(false);
    expect(run.characterFormat.reference.reasons).toContain('AMBIGUOUS_FORMAT_REFERENCE');
    expect(run.characterFormat.fontSize.value).toBeNull();
    expect(run.correctionCandidate).toBe(false);
  });
});

describe('T-03 inspection session keeps models and original bytes independent', () => {
  it('returns deep model copies and fresh original/worker/export buffers', async () => {
    const bytes = await fixture();
    const original = bytes.slice();
    const session = await createInspectionSession(bytes, 'synthetic.hwpx');
    const expected = session.inspection;
    const exposed = session.inspection;
    expect(exposed).not.toBe(expected);
    exposed.paragraphs[0]!.text = 'changed';
    exposed.paragraphs[0]!.runIds.length = 0;
    exposed.runs[0]!.characterFormat.fonts.HANGUL.value = 'changed';
    exposed.runs[0]!.segments[0]!.text = 'changed';
    exposed.formats.characterShapes[0]!.attributes.height = '0';
    exposed.sections[0]!.sourceSpan.startByte = 0;
    bytes.fill(0);
    session.getOriginalBytes().fill(1);
    session.exportUnchanged().fill(2);
    const worker = session.getWorkerBytes();
    structuredClone(worker, { transfer: [worker.buffer] });
    expect(worker.byteLength).toBe(0);
    expect(session.inspection).toEqual(expected);
    expect(session.getOriginalBytes()).toEqual(original);
    expect(session.exportUnchanged()).toEqual(original);
    expect(session.originalSha256).toBe(createHash('sha256').update(original).digest('hex'));
  });
});
