import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { DRAFT_LIMITS, DRAFT_SOURCE_ID_BASE, type ResearchDraftOptions } from '../../src/domain/research';
import { createResearchDraft } from '../../src/engine/draft';
import { recommendDraft } from '../../src/engine/draft/plan';
import * as writer from '../../src/engine/draft/writer';
import { createPlainTextSource } from '../../src/engine/plain-text';
import { inspectHwpx } from '../../src/engine/preflight';
import { elementChildren, indexXml } from '../../src/engine/xml/index';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';

describe('explicitly entered text as a new local source', () => {
  it('round trips LF lines, CR, tabs, consecutive blank lines and outer whitespace exactly', async () => {
    const text = '\n  [합성] 연구의 필요성\t 공백  \r\n\n수업 실행\r단독 CR\n실행 결과 😀 & < > " \'\n';
    const bytes = await createPlainTextSource(text);
    const { report, inspection } = await inspectHwpx(bytes, 'synthetic-entered-text.hwpx');
    expect(report).toMatchObject({ sectionPaths: ['Contents/section0.xml'], supportLevel: 'INSPECT_ONLY' });
    expect(inspection.paragraphs.map((paragraph) => paragraph.sourceId)).toEqual(['0', ...text.split('\n').map((_, ordinal) => String(DRAFT_SOURCE_ID_BASE + ordinal))]);
    expect(inspection.paragraphs.map((paragraph) => paragraph.text)).toEqual(['', ...text.split('\n')]);
    expect(inspection.paragraphs.slice(1).map((paragraph) => paragraph.text).join('\n')).toBe(text);
    expect(inspection.paragraphs.every((paragraph) => paragraph.context === 'BODY')).toBe(true);
    expect(inspection.tables).toHaveLength(0);
    expect(inspection.editingEnabled).toBe(false);
    const parts = unzipSync(bytes);
    expect(new TextDecoder().decode(parts['Preview/PrvText.txt'])).toBe(text);
    expect(Object.keys(parts).some((path) => /^BinData\//u.test(path))).toBe(false);
    const section = indexXml(parts['Contents/section0.xml']!);
    const paragraphs = elementChildren(section.root, HP, 'p');
    expect(paragraphs.slice(1).every((paragraph) => paragraph.attributes.pageBreak === '0')).toBe(true);
    expect(section.elements.some((element) => element.local === 'linesegarray')).toBe(false);
  });

  it('treats script, XML declarations and object-looking content as inert user text', async () => {
    const text = '[합성] <script src="https://example.invalid/private">내용</script>\n<!DOCTYPE hp:sec SYSTEM "https://example.invalid/private">\n<hp:pic/><hp:fieldBegin name="x"/> &nbsp;';
    const source = await createPlainTextSource(text);
    const { inspection } = await inspectHwpx(source, 'synthetic-inert-text.hwpx');
    expect(inspection.paragraphs.slice(1).map((paragraph) => paragraph.text).join('\n')).toBe(text);
    const section = indexXml(unzipSync(source)['Contents/section0.xml']!);
    expect(section.elements.some((element) => ['script', 'pic', 'fieldBegin'].includes(element.local))).toBe(false);
  });

  it.each([null, undefined, false, 12, [], {}, new String('합성')] as unknown[])('rejects non-string input %s without coercion', async (input) => {
    await expect(createPlainTextSource(input)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it.each(['', ' \t\r\n', '\u0000', '[합성]\u0001', '[합성]\u000b', '[합성]\ufffe', '[합성]\ud800', '[합성]\udfff'])('rejects empty or invalid XML text %#', async (input) => {
    await expect(createPlainTextSource(input)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it('rejects oversized text and lines before generating a package', async () => {
    const spy = vi.spyOn(writer, 'makePlainTextSource');
    try {
      await expect(createPlainTextSource('가'.repeat(DRAFT_LIMITS.maxTextCharacters + 1))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
      await expect(createPlainTextSource(['[합성]', ...Array<string>(DRAFT_LIMITS.maxParagraphs - 1).fill('')].join('\n'))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('accepts the paragraph boundary including the section-properties carrier', async () => {
    const text = ['[합성]', ...Array<string>(DRAFT_LIMITS.maxParagraphs - 2).fill('')].join('\n');
    const { inspection } = await inspectHwpx(await createPlainTextSource(text), 'synthetic-paragraph-boundary.hwpx');
    expect(inspection.paragraphs).toHaveLength(DRAFT_LIMITS.maxParagraphs);
    expect(inspection.paragraphs.slice(1).map((paragraph) => paragraph.text).join('\n')).toBe(text);
  });

  it('accepts the text-character boundary through actual XML/ZIP validation', async () => {
    const text = '가'.repeat(DRAFT_LIMITS.maxTextCharacters);
    const { inspection } = await inspectHwpx(await createPlainTextSource(text), 'synthetic-text-boundary.hwpx');
    expect(inspection.paragraphs[1]?.text).toBe(text);
  });

  it('rejects a writer output that is valid HWPX but does not preserve the entered text', async () => {
    const wrongBytes = await writer.makePlainTextSource('[합성] 다른 텍스트');
    const spy = vi.spyOn(writer, 'makePlainTextSource').mockResolvedValueOnce(wrongBytes);
    try {
      await expect(createPlainTextSource('[합성] 요청한 텍스트')).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
    } finally { spy.mockRestore(); }
  });

  it('feeds the real draft pipeline while preserving every entered line and source bytes', async () => {
    const text = '  [합성] 실행 결과는 21명\t5분\r\n연구의 필요성은 읽기 활동\n\n수업 실행은 모둠 토의  \n';
    const source = await createPlainTextSource(text);
    const original = new Uint8Array(source);
    const { inspection } = await inspectHwpx(source, 'synthetic-manual-source.hwpx');
    const recommendation = recommendDraft(inspection, 'competition');
    expect(recommendation.eligible).toBe(true);
    const options: ResearchDraftOptions = { kind: 'competition', title: '[합성] 직접 입력 초안', subject: '', grade: '', studentCount: '',
      assignments: recommendation.paragraphs.map((paragraph) => ({ paragraphId: paragraph.paragraphId, sourceText: paragraph.text, role: paragraph.role })) };
    const result = await createResearchDraft(source, options);
    expect(source).toEqual(original);
    expect(result).toMatchObject({ packageVerified: true, originalTextVerified: true, manualValidation: 'NOT_RUN',
      sourceParagraphCount: text.split('\n').length + 1, includedParagraphCount: text.split('\n').length + 1, excludedParagraphCount: 0 });
    const output = (await inspectHwpx(result.bytes, 'synthetic-manual-draft.hwpx')).inspection;
    const sources = output.paragraphs.filter((paragraph) => Number(paragraph.sourceId) >= DRAFT_SOURCE_ID_BASE);
    expect(sources).toHaveLength(options.assignments.length);
    const restored = options.assignments.map((_, ordinal) => sources.find((paragraph) => paragraph.sourceId === String(DRAFT_SOURCE_ID_BASE + ordinal))?.text);
    expect(restored).toEqual(['', ...text.split('\n')]);
    expect(restored.slice(1).join('\n')).toBe(text);
  });
});
