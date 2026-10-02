import { unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DRAFT_PROFILES, getCompetition, getEffectiveDraftProfile } from '../../src/domain/competitions';
import type { DraftProfile } from '../../src/domain/competition-types';
import { FONT_LANGUAGES, type DocumentInspection } from '../../src/domain/document';
import { DRAFT_SOURCE_ID_BASE, DRAFT_SUPPLEMENT_ID_BASE, type ResearchDraftOptions } from '../../src/domain/research';
import { createResearchDraft } from '../../src/engine/draft';
import { recommendDraft } from '../../src/engine/draft/plan';
import { makeResearchDraft } from '../../src/engine/draft/writer';
import * as writerModule from '../../src/engine/draft/writer';
import { inspectHwpx } from '../../src/engine/preflight';
import { elementChildren, indexXml } from '../../src/engine/xml/index';
import { makeResearchFixture } from '../helpers/research-fixture';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const profiles = DRAFT_PROFILES.filter((profile) => profile.policy !== 'guide-only' && profile.documentType !== 'custom');
let original: Uint8Array;
let inspection: DocumentInspection;
beforeAll(async () => {
  original = makeResearchFixture();
  inspection = (await inspectHwpx(original, 'synthetic-source.hwpx')).inspection;
});

function request(profile: DraftProfile): ResearchDraftOptions {
  const kind = profile.documentType === 'paper' ? 'paper' : 'competition';
  const selection = { profileId: profile.id, year: profile.year, stage: profile.allowedStages[0],
    schoolLevel: getCompetition(profile.competitionId)?.schoolLevels[0] ?? 'elementary' } as const;
  const recommendation = recommendDraft(inspection, kind, selection);
  expect(recommendation.eligible).toBe(true);
  return { kind, title: '[합성] 대회별 초안', subject: '국어', grade: '3학년', studentCount: '21', ...selection,
    assignments: recommendation.paragraphs.map((paragraph) => ({ paragraphId: paragraph.paragraphId, sourceText: paragraph.text, role: paragraph.role })) };
}

function sourceParagraphs(model: DocumentInspection) {
  return model.paragraphs.filter((paragraph) => Number(paragraph.sourceId) >= DRAFT_SOURCE_ID_BASE && Number(paragraph.sourceId) < DRAFT_SOURCE_ID_BASE + 2000);
}

describe('actual serialized competition profile drafts', () => {
  it.each(profiles)('reopens $id with exact profile body/style/page values and every source once', async (profile) => {
    const options = request(profile);
    const snapshot = new Uint8Array(original);
    const result = await createResearchDraft(original, options);
    expect(original).toEqual(snapshot);
    expect(result).toMatchObject({ profileId: profile.id, profileVersion: profile.version, profileYear: profile.year,
      sourceParagraphCount: inspection.paragraphs.length, includedParagraphCount: inspection.paragraphs.length,
      excludedParagraphCount: 0, addedParagraphCount: 0, sourceSelection: 'all', packageVerified: true, originalTextVerified: true, manualValidation: 'NOT_RUN' });
    const output = (await inspectHwpx(result.bytes, 'synthetic-output.hwpx')).inspection;
    const sources = sourceParagraphs(output);
    expect(sources).toHaveLength(options.assignments.length);
    for (const [ordinal, assignment] of options.assignments.entries()) {
      expect(sources.find((paragraph) => paragraph.sourceId === String(DRAFT_SOURCE_ID_BASE + ordinal))?.text).toBe(assignment.sourceText);
    }
    const nodes = new Map(output.runs.map((run) => [run.nodeId, run]));
    for (const paragraph of sources) {
      const ordinal = Number(paragraph.sourceId) - DRAFT_SOURCE_ID_BASE;
      const expectedSize = profile.policy !== 'format-only' && options.assignments[ordinal]!.role === 'references'
        ? profile.page.fontSizes?.references ?? profile.page.fontSizePt : profile.page.fontSizePt;
      expect(paragraph.paragraphFormat.lineSpacing).toMatchObject({ value: profile.page.lineSpacingPercent, unit: '%' });
      expect(paragraph.paragraphFormat.indent.value).toBe(profile.page.indent / 100);
      expect(paragraph.paragraphFormat.beforeSpacing.value).toBe(profile.page.beforeSpacing / 100);
      expect(paragraph.paragraphFormat.afterSpacing.value).toBe(profile.page.afterSpacing / 100);
      for (const runId of paragraph.runIds) {
        const run = nodes.get(runId)!;
        expect(run.characterFormat.fontSize.value).toBe(expectedSize);
        for (const language of FONT_LANGUAGES) expect(run.characterFormat.fonts[language].value).toBe(profile.page.fontFace);
      }
    }
    const section = indexXml(unzipSync(result.bytes)['Contents/section0.xml']!);
    const page = section.elements.find((element) => element.uri === HP && element.local === 'pagePr')!;
    expect(page.attributes).toMatchObject({ width: String(profile.page.width), height: String(profile.page.height), landscape: 'WIDELY' });
    const margin = elementChildren(page, HP, 'margin')[0]!;
    for (const [name, value] of Object.entries(profile.page.margins)) expect(margin.attributes[name]).toBe(String(value));
    expect(section.elements.some((element) => /^(?:linesegarray|lineSegArray|tbl|pic)$/u.test(element.local))).toBe(false);
  });

  it('format-only preserves source order and adds no cover, headings, TOC or teacher text', async () => {
    const profile = profiles.find((entry) => entry.policy === 'format-only')!;
    expect(profile).toBeDefined();
    const options = request(profile);
    options.assignments.reverse(); // Wrapper must restore the canonical source order.
    const output = (await inspectHwpx((await createResearchDraft(original, options)).bytes, 'synthetic-output.hwpx')).inspection;
    expect(output.paragraphs.map((paragraph) => paragraph.text)).toEqual(['', ...inspection.paragraphs.map((paragraph) => paragraph.text)]);
    expect(output.paragraphs.map((paragraph) => paragraph.sourceId)).toEqual(['0', ...inspection.paragraphs.map((_, ordinal) => String(DRAFT_SOURCE_ID_BASE + ordinal))]);
    const withSupplement = { ...options, supplements: [{ role: profile.roles[0]!, text: '[합성] 교사 보충 문단' }] };
    await expect(createResearchDraft(original, withSupplement)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
    await expect(makeResearchDraft(withSupplement, profile.page)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it.each(profiles.filter((profile) => profile.documentType === 'summary' || profile.id === 'innovation-report'))('serializes the $id summary heading with the appropriate page break', async (profile) => {
    const result = await createResearchDraft(original, request(profile));
    const output = (await inspectHwpx(result.bytes, 'synthetic-summary-layout.hwpx')).inspection;
    const heading = output.paragraphs.find((paragraph) => paragraph.text === profile.labels.summary)!;
    const section = indexXml(unzipSync(result.bytes)['Contents/section0.xml']!);
    const paragraph = elementChildren(section.root, HP, 'p').find((element) => element.attributes.id === heading.sourceId)!;
    expect(paragraph.attributes.pageBreak).toBe(profile.documentType === 'summary' ? '0' : '1');
    if (profile.documentType === 'summary') {
      expect(elementChildren(section.root, HP, 'p').some((element) => element.attributes.pageBreak === '1')).toBe(false);
    }
  });

  it('keeps explicitly approved teacher supplements separate, escaped and ordered after source paragraphs of each role', async () => {
    const profile = profiles.find((entry) => entry.id === 'innovation-report')!;
    const options = request(profile);
    options.supplements = [
      { role: 'results', text: '[합성] 교사 승인 <tag>&literal;&#13;\t\n\r 😀 결과' },
      { role: 'need', text: '[합성] 직접 입력한 필요성  ' },
      { role: 'references', text: '[합성] 승인된 참고문헌 문단' },
    ];
    const result = await createResearchDraft(original, options);
    expect(result.addedParagraphCount).toBe(3);
    const output = (await inspectHwpx(result.bytes, 'synthetic-output.hwpx')).inspection;
    const supplements = output.paragraphs.filter((paragraph) => Number(paragraph.sourceId) >= DRAFT_SUPPLEMENT_ID_BASE);
    expect(supplements.map((paragraph) => paragraph.sourceId)).toEqual(['10001', '10000', '10002']);
    for (const [ordinal, supplement] of options.supplements.entries()) {
      const target = output.paragraphs.findIndex((paragraph) => paragraph.sourceId === String(DRAFT_SUPPLEMENT_ID_BASE + ordinal));
      expect(output.paragraphs[target]!.text).toBe(supplement.text);
      for (const [sourceOrdinal, assignment] of options.assignments.entries()) if (assignment.role === supplement.role) {
        expect(output.paragraphs.findIndex((paragraph) => paragraph.sourceId === String(DRAFT_SOURCE_ID_BASE + sourceOrdinal))).toBeLessThan(target);
      }
    }
    expect(sourceParagraphs(output)).toHaveLength(options.assignments.length);
  });

  it('summary selection includes exactly the confirmed subset without renumbering source IDs', async () => {
    const profile = profiles.find((entry) => entry.documentType === 'summary')!;
    const options = request(profile);
    options.summaryParagraphIds = [options.assignments[8]!.paragraphId, options.assignments[1]!.paragraphId];
    options.summarySelectionConfirmed = true;
    const result = await createResearchDraft(original, options);
    expect(result).toMatchObject({ sourceParagraphCount: 10, includedParagraphCount: 2, excludedParagraphCount: 8, sourceSelection: 'summary-selection' });
    const output = (await inspectHwpx(result.bytes, 'synthetic-summary.hwpx')).inspection;
    expect(sourceParagraphs(output).map((paragraph) => paragraph.sourceId)).toEqual(['1001', '1008']);
    expect(sourceParagraphs(output).map((paragraph) => paragraph.text)).toEqual([inspection.paragraphs[1]!.text, inspection.paragraphs[8]!.text]);
    await expect(createResearchDraft(original, { ...options, summarySelectionConfirmed: false })).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
    await expect(createResearchDraft(original, { ...options, summaryParagraphIds: ['absent-source-id'] })).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it('rejects summary selections on reports and blocked national stages at both public entry points', async () => {
    const report = profiles.find((entry) => entry.id === 'innovation-report')!;
    const selectedReport = { ...request(report), summaryParagraphIds: [inspection.paragraphs[0]!.nodeId], summarySelectionConfirmed: true };
    await expect(createResearchDraft(original, selectedReport)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
    await expect(makeResearchDraft(selectedReport, report.page)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
    const blocked = profiles.find((entry) => !entry.allowedStages.includes('national'))!;
    expect(blocked).toBeDefined();
    const national = { ...request(blocked), stage: 'national' as const };
    expect(() => getEffectiveDraftProfile(national)).toThrow();
    expect(recommendDraft(inspection, national.kind, national)).toMatchObject({ eligible: false, paragraphs: [] });
    await expect(createResearchDraft(original, national)).rejects.toBeInstanceOf(Error);
    await expect(makeResearchDraft(national, blocked.page)).rejects.toBeInstanceOf(Error);
  });

  it('uses explicit custom labels and font sizes without claiming a verified official profile', async () => {
    const options: ResearchDraftOptions = { kind: 'competition', profileId: 'custom', title: '[합성] 사용자 초안', subject: '', grade: '', studentCount: '',
      custom: { name: '[합성] 사용자 양식', fontFace: '합성 글꼴', fontSizePt: 11.23, lineSpacingPercent: 145,
        marginMm: { top: 20, bottom: 20, left: 20, right: 20, header: 10, footer: 10, gutter: 0 }, labels: { need: '[합성] 사용자가 정한 목적' } },
      assignments: inspection.paragraphs.map((paragraph) => ({ paragraphId: paragraph.nodeId, sourceText: paragraph.text, role: 'need' })) };
    const result = await createResearchDraft(original, options);
    expect(result.profileId).toBe('custom');
    const output = (await inspectHwpx(result.bytes, 'synthetic-custom.hwpx')).inspection;
    expect(output.paragraphs.some((paragraph) => paragraph.text === '[합성] 사용자가 정한 목적')).toBe(true);
    for (const paragraph of sourceParagraphs(output)) for (const runId of paragraph.runIds) {
      const run = output.runs.find((entry) => entry.nodeId === runId)!;
      expect(run.characterFormat.fontSize.value).toBe(11.23);
      expect(run.characterFormat.fonts.HANGUL.value).toBe('합성 글꼴');
    }
  });

  it.each(['source-text', 'character-height', 'page-margin'] as const)('independent reopening rejects a faulty producer changing %s', async (fault) => {
    const profile = profiles.find((entry) => entry.id === 'innovation-report')!;
    const options = request(profile);
    const realWriter = writerModule.makeResearchDraft;
    const spy = vi.spyOn(writerModule, 'makeResearchDraft').mockImplementation(async (input, page) => {
      const entries = unzipSync(await realWriter(input, page));
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const section = indexXml(entries['Contents/section0.xml']!);
      if (fault === 'source-text') {
        const paragraph = section.elements.find((element) => element.uri === HP && element.local === 'p' && element.attributes.id === '1000')!;
        const text = section.elements.find((element) => element.uri === HP && element.local === 't' && element.parent?.parent === paragraph)!;
        const original = entries['Contents/section0.xml']!;
        entries['Contents/section0.xml'] = encoder.encode(decoder.decode(original.subarray(0, text.sourceSpan.startByte)) + '<hp:t>[합성] 변조된 원문</hp:t>' + decoder.decode(original.subarray(text.sourceSpan.endByte)));
      } else if (fault === 'character-height') {
        const paragraph = section.elements.find((element) => element.uri === HP && element.local === 'p' && element.attributes.id === '1000')!;
        const characterId = elementChildren(paragraph, HP, 'run')[0]!.attributes.charPrIDRef;
        const original = entries['Contents/header.xml']!;
        const character = indexXml(original).elements.find((element) => element.local === 'charPr' && element.attributes.id === characterId)!;
        const token = decoder.decode(original.subarray(character.sourceSpan.startByte, character.sourceSpan.endByte)).replace(/height="[0-9]+"/u, 'height="1300"');
        entries['Contents/header.xml'] = encoder.encode(decoder.decode(original.subarray(0, character.sourceSpan.startByte)) + token + decoder.decode(original.subarray(character.sourceSpan.endByte)));
      } else {
        const original = entries['Contents/section0.xml']!;
        const margin = section.elements.find((element) => element.uri === HP && element.local === 'margin' && element.parent?.local === 'pagePr')!;
        const token = decoder.decode(original.subarray(margin.sourceSpan.startByte, margin.sourceSpan.endByte)).replace(/left="[0-9]+"/u, 'left="0"');
        entries['Contents/section0.xml'] = encoder.encode(decoder.decode(original.subarray(0, margin.sourceSpan.startByte)) + token + decoder.decode(original.subarray(margin.sourceSpan.endByte)));
      }
      return new Uint8Array(zipSync(entries, { level: 0, mtime: new Date(2024, 0, 1) }));
    });
    try { await expect(createResearchDraft(original, options)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' }); }
    finally { spy.mockRestore(); }
  });
});
