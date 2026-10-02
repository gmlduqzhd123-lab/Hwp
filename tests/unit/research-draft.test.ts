import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { DRAFT_ROLES, DRAFT_SOURCE_ID_BASE, type DraftPage, type ResearchDraftOptions } from '../../src/domain/research';
import { DRAFT_ROLE_LABELS, OFFICIAL_PROFILE } from '../../src/engine/draft/plan';
import { getBlankTemplateBytes } from '../../src/engine/draft/template';
import { makeResearchDraft } from '../../src/engine/draft/writer';
import { inspectHwpx, preflight } from '../../src/engine/preflight';
import { scanZipMetadata } from '../../src/engine/package/metadata';
import { elementChildren, indexXml } from '../../src/engine/xml/index';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const OPF = 'http://www.idpf.org/2007/opf/';
const decoder = new TextDecoder();

function options(kind: 'competition' | 'paper' = 'competition'): ResearchDraftOptions {
  return {
    kind, title: '[합성] 연구 초안', subject: '국어', grade: '3학년', studentCount: '21',
    assignments: [
      { paragraphId: 'synthetic-0', sourceText: '실행 결과  21명\t5분\n원문\r\n& < > " \' 😀', role: 'results' },
      { paragraphId: 'synthetic-1', sourceText: '연구의 필요성을 담은 합성 원문', role: 'need' },
      { paragraphId: 'synthetic-2', sourceText: '', role: 'need' },
      { paragraphId: 'synthetic-3', sourceText: '자료: https://example.invalid/synthetic', role: 'references' },
    ],
  };
}
function page(): DraftPage { return { ...OFFICIAL_PROFILE.page, margins: { ...OFFICIAL_PROFILE.page.margins } }; }

describe('local research draft writer', () => {
  it('embeds the exact licensed public blank without a template fetch', () => {
    const first = getBlankTemplateBytes();
    expect(createHash('sha256').update(first).digest('hex')).toBe('d28f55cd622b6d0cade2d8ae3b5d53f1ed5c4154289e463a4c390d9be157aa6d');
    first.fill(0);
    expect(getBlankTemplateBytes()[0]).toBe(0x50);
  });

  it.each(['competition', 'paper'] as const)('preserves each %s source paragraph exactly while grouping roles', async (kind) => {
    const input = options(kind);
    const bytes = await makeResearchDraft(input, page());
    const { inspection } = await inspectHwpx(bytes, 'synthetic-draft.hwpx');
    const sources = inspection.paragraphs.filter((entry) => Number(entry.sourceId) >= DRAFT_SOURCE_ID_BASE);
    expect(sources.map((entry) => entry.sourceId)).toEqual(['1001', '1002', '1000', '1003']);
    for (const [index, assignment] of input.assignments.entries()) {
      expect(sources.find((entry) => entry.sourceId === String(DRAFT_SOURCE_ID_BASE + index))?.text).toBe(assignment.sourceText);
    }
    expect(new Set(sources.map((entry) => entry.sourceId)).size).toBe(input.assignments.length);
    expect(inspection.paragraphs).toHaveLength(input.assignments.length + (kind === 'competition' ? 26 : 11));
    expect(inspection.editingEnabled).toBe(false);
  });

  it('sets actual font, character and paragraph values with complete references', async () => {
    const bytes = await makeResearchDraft(options(), page());
    const { inspection } = await inspectHwpx(bytes, 'synthetic-draft.hwpx');
    for (const paragraph of inspection.paragraphs.filter((entry) => Number(entry.sourceId) >= DRAFT_SOURCE_ID_BASE)) {
      expect(paragraph.styleReference.resolved).toBe(true);
      expect(paragraph.paragraphFormat.reference.resolved).toBe(true);
      expect(paragraph.paragraphFormat.lineSpacing).toMatchObject({ value: 160, unit: '%' });
      expect(paragraph.paragraphFormat.indent).toMatchObject({ value: 10, unit: 'pt' });
      expect(paragraph.paragraphFormat.beforeSpacing.value).toBe(5);
      expect(paragraph.paragraphFormat.afterSpacing.value).toBe(0);
      for (const id of paragraph.runIds) {
        const run = inspection.runs.find((entry) => entry.nodeId === id)!;
        expect(run.characterFormat.reference.resolved).toBe(true);
        expect(run.characterFormat.fontSize).toMatchObject({ value: 12, rawValue: '1200', unit: 'pt' });
        expect(Object.values(run.characterFormat.fonts).map((font) => font.value)).toEqual(Array(7).fill('휴먼명조'));
      }
    }
  });

  it('creates all role headings and a page-number-free competition table of contents', async () => {
    const input = options();
    const { inspection } = await inspectHwpx(await makeResearchDraft(input, page()), 'synthetic-draft.hwpx');
    const added = inspection.paragraphs.filter((entry) => Number(entry.sourceId) > 0 && Number(entry.sourceId) < DRAFT_SOURCE_ID_BASE);
    const texts = added.map((entry) => entry.text);
    expect(texts.slice(0, 8)).toEqual([
      '2026학년도 수업혁신사례연구대회 보고서', input.title, '학교급: 초등학교', '출품교과: 국어',
      '관리번호: ', '연구형태: ', '학년: 3학년', '학생수: 21',
    ]);
    expect(added[1]!.sourceId).toBe('2');
    expect(texts).toContain('학교급: 초등학교');
    expect(texts).toContain('출품교과: 국어');
    expect(texts).toContain('학년: 3학년');
    expect(texts).toContain('학생수: 21');
    expect(texts).toContain('목차');
    for (const role of DRAFT_ROLES) expect(texts.filter((text) => text === DRAFT_ROLE_LABELS.competition[role])).toHaveLength(2);
    expect(texts).not.toContain('미입력');
  });

  it.each([['individual', '개인연구'], ['joint', '공동연구']] as const)('prints only the explicitly selected research type %s', async (researchType, label) => {
    const input = { ...options(), researchType };
    const { inspection } = await inspectHwpx(await makeResearchDraft(input, page()), 'synthetic-draft.hwpx');
    expect(inspection.paragraphs.find((entry) => entry.sourceId === '6')?.text).toBe(`연구형태: ${label}`);
    expect(inspection.paragraphs.find((entry) => entry.sourceId === '5')?.text).toBe('관리번호: ');
    expect(inspection.paragraphs.find((entry) => entry.sourceId === '2')?.text).toBe(input.title);
  });

  it('keeps unprovided cover fields blank and rejects invented research type values', async () => {
    const input = { ...options(), subject: '', grade: '', studentCount: '' };
    const { inspection } = await inspectHwpx(await makeResearchDraft(input, page()), 'synthetic-draft.hwpx');
    const cover = inspection.paragraphs.filter((entry) => Number(entry.sourceId) >= 3 && Number(entry.sourceId) <= 8).map((entry) => entry.text);
    expect(cover).toEqual(['학교급: 초등학교', '출품교과: ', '관리번호: ', '연구형태: ', '학년: ', '학생수: ']);
    await expect(makeResearchDraft({ ...input, researchType: 'invented' } as unknown as ResearchDraftOptions, page())).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it('uses paper labels without inventing cover fields or table of contents', async () => {
    const { inspection } = await inspectHwpx(await makeResearchDraft(options('paper'), page()), 'synthetic-draft.hwpx');
    const texts = inspection.paragraphs.map((entry) => entry.text);
    expect(texts).toContain('초록');
    expect(texts).toContain('서론');
    expect(texts).not.toContain('목차');
    expect(texts).not.toContain('학교급: 초등학교');
    expect(texts.some((text) => text.startsWith('연구형태:') || text.startsWith('관리번호:') || text.startsWith('출품교과:'))).toBe(false);
  });

  it('preserves A4 template orientation and applies all explicit page margins', async () => {
    const bytes = await makeResearchDraft(options(), page());
    const entries = unzipSync(bytes);
    const section = indexXml(entries['Contents/section0.xml']!);
    const paper = section.elements.find((entry) => entry.uri === HP && entry.local === 'pagePr')!;
    expect(paper.attributes).toMatchObject({ width: '59528', height: '84188', landscape: 'WIDELY' });
    const margins = elementChildren(paper, HP, 'margin')[0]!;
    expect(margins.attributes).toEqual({ top: '4252', bottom: '4252', left: '7087', right: '7087', header: '4252', footer: '4252', gutter: '2835' });
    expect(section.elements.some((entry) => entry.local === 'linesegarray')).toBe(false);
    expect(section.elements.some((entry) => entry.local === 'secPr')).toBe(true);
  });

  it('updates metadata and text preview while creating no preview image', async () => {
    const input = options();
    const bytes = await makeResearchDraft(input, page());
    const entries = unzipSync(bytes);
    expect(entries['Preview/PrvImage.png']).toBeUndefined();
    const metadata = indexXml(entries['Contents/content.hpf']!);
    const title = metadata.elements.find((entry) => entry.uri === OPF && entry.local === 'title')!;
    expect(title.children[0]).toMatchObject({ kind: 'text', text: input.title });
    for (const name of ['creator', 'lastsaveby', 'CreatedDate', 'ModifiedDate', 'date']) {
      const value = metadata.elements.find((entry) => entry.uri === OPF && entry.local === 'meta' && entry.attributes.name === name)!;
      expect(value.children).toHaveLength(0);
    }
    const settings = indexXml(entries['settings.xml']!);
    const caret = settings.elements.find((entry) => entry.local === 'CaretPosition')!;
    expect(caret.attributes).toEqual({ listIDRef: '0', paraIDRef: '1', pos: '0' });
    const { inspection } = await inspectHwpx(bytes, 'synthetic-draft.hwpx');
    const texts = inspection.paragraphs.filter((entry) => entry.sourceId !== '0').map((entry) => entry.text);
    expect(decoder.decode(entries['Preview/PrvText.txt'])).toBe(texts.join('\n'));
    expect(await preflight(bytes, 'synthetic-draft.hwpx')).toMatchObject({ entryCount: 9, sectionPaths: ['Contents/section0.xml'] });
  });

  it('writes a stored first mimetype and keeps every original fixed template resource', async () => {
    const bytes = await makeResearchDraft(options(), page());
    const metadata = scanZipMetadata(bytes);
    expect(metadata.entries[0]).toMatchObject({ name: 'mimetype', method: 0, localOffset: 0, uncompressedSize: 19 });
    const template = unzipSync(getBlankTemplateBytes());
    const result = unzipSync(bytes);
    for (const path of ['version.xml', 'META-INF/manifest.xml']) expect(result[path]).toEqual(template[path]);
  });

  it('escapes source text as inert XML data and never makes a network request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    try {
      const input = options();
      input.assignments[0]!.sourceText = '<script onload="https://example.invalid">&字</script>\t\n\r';
      const { inspection } = await inspectHwpx(await makeResearchDraft(input, page()), 'synthetic-draft.hwpx');
      expect(inspection.paragraphs.find((entry) => entry.sourceId === '1000')!.text).toBe(input.assignments[0]!.sourceText);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('snapshots options and page values before asynchronous template extraction', async () => {
    const input = options();
    const profile = page();
    const expected = input.assignments[0]!.sourceText;
    const pending = makeResearchDraft(input, profile);
    input.assignments[0]!.sourceText = 'changed after call';
    input.title = 'changed';
    profile.fontFace = 'changed';
    profile.margins.top = 0;
    const { inspection } = await inspectHwpx(await pending, 'synthetic-draft.hwpx');
    expect(inspection.paragraphs.find((entry) => entry.sourceId === '1000')!.text).toBe(expected);
    expect(inspection.runs.find((entry) => entry.paragraphId === inspection.paragraphs.find((entry) => entry.sourceId === '1000')!.nodeId)!.characterFormat.fonts.HANGUL.value).toBe('휴먼명조');
  });

  it('produces identical bytes for the same explicit inputs', async () => {
    expect(await makeResearchDraft(options(), page())).toEqual(await makeResearchDraft(options(), page()));
  });

  it.each(['\u0000', '\ud800', '\udfff', '\ufffe', '\uffff'])('rejects invalid XML character %j before output', async (character) => {
    const input = options();
    input.assignments[0]!.sourceText = `synthetic${character}`;
    await expect(makeResearchDraft(input, page())).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it.each(['width', 'height', 'fontSizePt', 'lineSpacingPercent', 'indent', 'beforeSpacing', 'afterSpacing'] as const)('rejects a missing or non-finite page field %s', async (field) => {
    const profile = page();
    profile[field] = Number.NaN;
    await expect(makeResearchDraft(options(), profile)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it('rejects incomplete margins rather than inventing defaults', async () => {
    const profile = page();
    delete (profile.margins as Partial<DraftPage['margins']>).gutter;
    await expect(makeResearchDraft(options(), profile)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it('accepts exact hundredth-point sizes despite binary floating point noise', async () => {
    const profile = page();
    profile.fontSizePt = 11.23;
    const { inspection } = await inspectHwpx(await makeResearchDraft(options(), profile), 'synthetic-draft.hwpx');
    const paragraph = inspection.paragraphs.find((entry) => entry.sourceId === '1000')!;
    const run = inspection.runs.find((entry) => entry.paragraphId === paragraph.nodeId)!;
    expect(run.characterFormat.fontSize).toMatchObject({ value: 11.23, rawValue: '1123' });
  });

  it('rejects a combined element and text-node overflow before writing a ZIP', async () => {
    const input = options();
    input.assignments[0]!.sourceText = 'x\t'.repeat(60_000);
    await expect(makeResearchDraft(input, page())).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });
});
