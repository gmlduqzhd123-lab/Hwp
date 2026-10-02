import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import type { DocumentInspection } from '../../src/domain/document';
import { EngineError, safeError } from '../../src/domain/errors';
import {
  DRAFT_SOURCE_ID_BASE, DRAFT_SUPPLEMENT_ID_BASE, type CustomDraftSettings,
  isResearchDraftOptions, type ResearchDraftOptions, type ResearchDraftResult,
} from '../../src/domain/research';
import { createResearchDraft } from '../../src/engine/draft';
import { recommendDraft } from '../../src/engine/draft/plan';
import { inspectHwpx } from '../../src/engine/preflight';
import { createInspectionSession } from '../../src/engine/session';
import { indexXml } from '../../src/engine/xml/index';
import { isDraftResponseResult } from '../../src/workers/protocol';
import { makeResearchFixture } from '../helpers/research-fixture';

const fixture = makeResearchFixture();
const PRIVATE_MARKER = 'SYNTHETIC_PRIVATE_CATALOG_MARKER';
let inspection: DocumentInspection;
let validResponse: Omit<ResearchDraftResult, 'bytes'> & { bytes: ArrayBuffer };

const custom = (): CustomDraftSettings => ({
  name: '교사가 작성한 참고 기준', fontFace: '함초롬바탕', fontSizePt: 11.23, lineSpacingPercent: 145,
  marginMm: { top: 20, bottom: 20, left: 20, right: 20, header: 10, footer: 10, gutter: 0 },
  labels: { need: '연구 배경', results: '확인한 결과' },
});

function settings(profileId = 'field-report', changes: Partial<ResearchDraftOptions> = {}): ResearchDraftOptions {
  const options: ResearchDraftOptions = {
    kind: 'competition', title: '공개 합성 원고', subject: '', grade: '', studentCount: '',
    profileId, year: 2026, stage: 'planning', schoolLevel: 'elementary', assignments: [], ...changes,
  };
  const recommendation = recommendDraft(inspection, options.kind, options);
  if (!recommendation.eligible) throw new Error('The selected synthetic test profile must be available.');
  options.assignments = recommendation.paragraphs.map((paragraph) => ({
    paragraphId: paragraph.paragraphId, sourceText: paragraph.text, role: paragraph.role,
  }));
  return options;
}

/** Only reopen our own tiny generated test package; never handle real user ZIPs here. */
async function reopen(result: ResearchDraftResult): Promise<DocumentInspection> {
  const reopened = (await inspectHwpx(result.bytes, 'synthetic-catalog-draft.hwpx')).inspection;
  expect(reopened.paragraphs).toHaveLength(result.outputParagraphCount);
  expect(result.packageVerified).toBe(true);
  expect(result.originalTextVerified).toBe(true);
  expect(result.manualValidation).toBe('NOT_RUN');
  return reopened;
}

function originalParagraphs(output: DocumentInspection) {
  return output.paragraphs.filter((paragraph) => paragraph.sourceId !== null
    && Number(paragraph.sourceId) >= DRAFT_SOURCE_ID_BASE && Number(paragraph.sourceId) < DRAFT_SUPPLEMENT_ID_BASE);
}

function supplementParagraphs(output: DocumentInspection) {
  return output.paragraphs.filter((paragraph) => paragraph.sourceId !== null && Number(paragraph.sourceId) >= DRAFT_SUPPLEMENT_ID_BASE);
}

async function rejected(input: unknown): Promise<void> {
  const before = fixture.slice();
  let failure: unknown;
  try { await createResearchDraft(fixture, input); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(EngineError);
  expect(['FILE_INVALID_PACKAGE', 'FILE_UNSUPPORTED', 'RESOURCE_LIMIT']).toContain((failure as EngineError).code);
  expect(JSON.stringify(safeError(failure))).not.toContain(PRIVATE_MARKER);
  expect(fixture).toEqual(before);
}

beforeAll(async () => {
  inspection = (await inspectHwpx(fixture, 'synthetic-research.hwpx')).inspection;
  const result = await createResearchDraft(fixture, settings());
  validResponse = { ...result, bytes: result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) };
});

describe('competition restrictions at the actual draft engine boundary', () => {
  it.each(['unregistered-report', 'field-report-v2', '__proto__', 'constructor', '../field-report', 'data:text/xml'])
    ('rejects an unregistered or control-shaped profile (%#)', async (profileId) => {
      await rejected({ ...settings(), profileId, title: PRIVATE_MARKER });
    });

  it.each([2025, 2027, 2026.5, Number.NaN, Number.POSITIVE_INFINITY, '2026'])
    ('refuses a different or malformed rule year instead of silently using 2026 (%#)', async (year) => {
      await rejected({ ...settings(), year, title: PRIVATE_MARKER });
    });

  it.each(['national-submitted', 'unknown', 'PLANNING', null, 1])
    ('rejects a forged creation stage (%#)', async (stage) => {
      await rejected({ ...settings(), stage, title: PRIVATE_MARKER });
    });

  it.each(['university', 'unknown', '<script>', null, 1])
    ('rejects an unsupported or malformed school level (%#)', async (schoolLevel) => {
      await rejected({ ...settings(), schoolLevel, title: PRIVATE_MARKER });
    });

  it.each(['character-teacher-report', 'character-institution-report', 'ebs-posting-description', 'ebs-review-description'])
    ('blocks changed national-stage documents through direct engine calls (%#)', async (profileId) => {
      await rejected({ ...settings(), profileId, stage: 'national', title: PRIVATE_MARKER });
    });

  it('does not relabel the old teacher invention guidelines as a 2026 profile', async () => {
    await rejected({ ...settings(), profileId: 'teacher-invention-report', year: 2026, title: PRIVATE_MARKER });
  });

  it('rejects a kindergarten request for the digital school-management division', async () => {
    await rejected({ ...settings(), profileId: 'digital-management-report', schoolLevel: 'kindergarten', title: PRIVATE_MARKER });
  });

  it('rejects a profile whose kind differs from the selected document', async () => {
    await rejected({ ...settings(), kind: 'paper', title: PRIVATE_MARKER });
  });

  it('cannot apply manual rules while labeling the output as an official competition profile', async () => {
    await rejected({ ...settings(), custom: custom() });
    await rejected({ ...settings(), profileId: 'custom' });
  });
});

describe('reviewed summary selections preserve exact source identities', () => {
  it('includes exactly the reviewed paragraphs and reports excluded source paragraphs', async () => {
    const options = settings('field-summary');
    const chosen = [options.assignments[6]!, options.assignments[1]!, options.assignments[3]!];
    options.summaryParagraphIds = chosen.map((assignment) => assignment.paragraphId);
    options.summarySelectionConfirmed = true;
    const before = fixture.slice();
    const result = await createResearchDraft(fixture, options);
    const source = originalParagraphs(await reopen(result));
    expect(source.map((paragraph) => paragraph.text)).toEqual([1, 3, 6].map((ordinal) => options.assignments[ordinal]!.sourceText));
    expect(source.map((paragraph) => paragraph.sourceId)).toEqual([1, 3, 6].map((ordinal) => String(DRAFT_SOURCE_ID_BASE + ordinal)));
    expect(result.sourceParagraphCount).toBe(options.assignments.length);
    expect(result.includedParagraphCount).toBe(3);
    expect(result.excludedParagraphCount).toBe(options.assignments.length - 3);
    expect(result.sourceSelection).toBe('summary-selection');
    expect(fixture).toEqual(before);
  });

  it('keeps every paragraph when no subset was explicitly reviewed', async () => {
    const options = settings('field-summary');
    const result = await createResearchDraft(fixture, options);
    expect(originalParagraphs(await reopen(result)).map((paragraph) => paragraph.text))
      .toEqual(options.assignments.map((assignment) => assignment.sourceText));
    expect(result.includedParagraphCount).toBe(options.assignments.length);
    expect(result.excludedParagraphCount).toBe(0);
    expect(result.sourceSelection).toBe('all');
  });

  it.each([undefined, false, 'true', 1])('rejects a subset without an explicit valid confirmation (%#)', async (summarySelectionConfirmed) => {
    const options = settings('field-summary');
    await rejected({ ...options, summaryParagraphIds: [options.assignments[0]!.paragraphId], summarySelectionConfirmed });
  });

  it.each(['unknown-source-id', 'Contents/section0.xml#element-99999', PRIVATE_MARKER])
    ('rejects selected IDs outside the exact inspected original (%#)', async (id) => {
      await rejected({ ...settings('field-summary'), summaryParagraphIds: [id], summarySelectionConfirmed: true });
    });

  it('rejects a duplicate selection and an empty selection', async () => {
    const options = settings('field-summary');
    const id = options.assignments[0]!.paragraphId;
    await rejected({ ...options, summaryParagraphIds: [id, id], summarySelectionConfirmed: true });
    await rejected({ ...options, summaryParagraphIds: [], summarySelectionConfirmed: true });
  });

  it('requires complete original assignments even when most paragraphs are excluded from a summary', async () => {
    const options = settings('field-summary');
    await rejected({ ...options, assignments: options.assignments.slice(0, 1),
      summaryParagraphIds: [options.assignments[0]!.paragraphId], summarySelectionConfirmed: true });
  });

  it('rejects stale text in an excluded paragraph instead of bypassing source verification', async () => {
    const options = settings('field-summary');
    options.assignments[8]!.sourceText = PRIVATE_MARKER;
    await rejected({ ...options, summaryParagraphIds: [options.assignments[0]!.paragraphId], summarySelectionConfirmed: true });
  });

  it('never accepts a summary subset for a full research report', async () => {
    const options = settings();
    await rejected({ ...options, summaryParagraphIds: [options.assignments[0]!.paragraphId], summarySelectionConfirmed: true });
  });

  it('rejects report-only roles and additions in a summary document', async () => {
    const options = settings('field-summary');
    await rejected({ ...options, assignments: options.assignments.map((assignment, ordinal) => ordinal === 0 ? { ...assignment, role: 'need' } : assignment) });
    await rejected({ ...options, supplements: [{ role: 'need', text: PRIVATE_MARKER }] });
  });

  it.each(['ebs-posting-description', 'ebs-review-description'])('never drops source paragraphs from an EBS formatting request (%#)', async (profileId) => {
    const options = settings(profileId);
    await rejected({ ...options, summaryParagraphIds: [options.assignments[0]!.paragraphId], summarySelectionConfirmed: true });
    await rejected({ ...options, supplements: [{ role: 'need', text: PRIVATE_MARKER }] });
  });
});

describe('local custom settings and teacher-supplied content are inert text', () => {
  it('accepts exact decimal hundredths and rejects near-hundredth precision before serialization', async () => {
    const options = settings('custom', { custom: { ...custom(), fontSizePt: 11.23 } });
    expect(isResearchDraftOptions(options)).toBe(true);
    const output = await reopen(await createResearchDraft(fixture, options));
    const runs = new Map(output.runs.map((run) => [run.nodeId, run]));
    for (const paragraph of originalParagraphs(output)) {
      for (const id of paragraph.runIds) expect(runs.get(id)?.characterFormat.fontSize.value).toBe(11.23);
    }
    const overprecise = { ...options, custom: { ...options.custom!, fontSizePt: 11.230000000001 } };
    expect(isResearchDraftOptions(overprecise)).toBe(false);
    await rejected(overprecise);
  });

  it('copies only supported manual margin fields into actual XML attributes', async () => {
    const options = settings('custom', { custom: {
      ...custom(), marginMm: { ...custom().marginMm, 'xmlns:untrusted': PRIVATE_MARKER, untrusted: PRIVATE_MARKER },
    } as unknown as CustomDraftSettings });
    const result = await createResearchDraft(fixture, options);
    await reopen(result);
    const section = indexXml(unzipSync(result.bytes)['Contents/section0.xml']!);
    expect(section.elements.some((element) => Object.keys(element.attributes).some((key) => key.includes('untrusted')))).toBe(false);
  });

  it('independently reopens XML-shaped labels, font names and teacher additions without objects or external requests', async () => {
    const fontFace = '가상 " face="다른글꼴"/><script>font</script> & \'글꼴';
    const label = '<hp:footNote id="91"/> <script>label()</script> & 연구 배경';
    const text = `${PRIVATE_MARKER}\n</hp:t><hp:pic href="https://example.invalid/image"/>`;
    const options = settings('custom', {
      custom: { ...custom(), fontFace, labels: { need: label } },
      supplements: [{ role: 'need', text }, { role: 'results', text: '교사가 적은 결과: 0.25 & < 2\t탭\n줄바꿈\r😀' }],
    });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request.'));
    try {
      const result = await createResearchDraft(fixture, options);
      const output = await reopen(result);
      expect(network).not.toHaveBeenCalled();
      expect(originalParagraphs(output).map((paragraph) => paragraph.text).sort())
        .toEqual(options.assignments.map((assignment) => assignment.sourceText).sort());
      expect(supplementParagraphs(output).map((paragraph) => [paragraph.sourceId, paragraph.text]))
        .toEqual(options.supplements!.map((supplement, ordinal) => [String(DRAFT_SUPPLEMENT_ID_BASE + ordinal), supplement.text]));
      expect(result.addedParagraphCount).toBe(2);
      expect(result.includedParagraphCount).toBe(options.assignments.length);
      expect(output.paragraphs.some((paragraph) => paragraph.text === label)).toBe(true);
      const entries = unzipSync(result.bytes);
      const section = indexXml(entries['Contents/section0.xml']!);
      const header = indexXml(entries['Contents/header.xml']!);
      expect(section.elements.some((element) => ['script', 'pic', 'footNote', 'fieldBegin'].includes(element.local))).toBe(false);
      expect(header.elements.some((element) => element.local === 'script')).toBe(false);
      expect(output.runs.every((run) => run.characterFormat.fonts.HANGUL.value === fontFace)).toBe(true);
      expect(Object.keys(entries).some((path) => path.includes(PRIVATE_MARKER))).toBe(false);
    } finally { network.mockRestore(); }
  });

  it('owns deep copies of custom settings, source bytes, supplements and summary selection before the first await', async () => {
    const ownedSource = fixture.slice();
    const options = settings('custom', { custom: custom(), supplements: [{ role: 'results', text: '확인한 합성 관찰 3회' }] });
    const accepted = structuredClone(options);
    const creating = createResearchDraft(ownedSource, options);
    ownedSource.fill(0);
    options.profileId = 'unregistered-report';
    options.year = 2025;
    options.title = PRIVATE_MARKER;
    options.custom!.fontFace = PRIVATE_MARKER;
    options.custom!.marginMm.left = 80;
    options.custom!.labels!.need = PRIVATE_MARKER;
    options.supplements![0]!.text = PRIVATE_MARKER;
    options.assignments[0]!.sourceText = PRIVATE_MARKER;
    const output = await reopen(await creating);
    expect(originalParagraphs(output).map((paragraph) => paragraph.text).sort())
      .toEqual(accepted.assignments.map((assignment) => assignment.sourceText).sort());
    expect(supplementParagraphs(output).map((paragraph) => paragraph.text)).toEqual(['확인한 합성 관찰 3회']);
    expect(output.runs.every((run) => run.characterFormat.fonts.HANGUL.value === accepted.custom!.fontFace)).toBe(true);
    expect(output.paragraphs.some((paragraph) => paragraph.text === PRIVATE_MARKER)).toBe(false);

    const summary = settings('field-summary');
    summary.summaryParagraphIds = [summary.assignments[2]!.paragraphId];
    summary.summarySelectionConfirmed = true;
    const summaryCreating = createResearchDraft(fixture, summary);
    summary.summaryParagraphIds[0] = summary.assignments[7]!.paragraphId;
    summary.summarySelectionConfirmed = false;
    expect(originalParagraphs(await reopen(await summaryCreating)).map((paragraph) => paragraph.text))
      .toEqual([summary.assignments[2]!.sourceText]);
  });

  it.each(['\u0000', '\u0001', '\ud800', '\ufffe'])('rejects non-XML characters in new teacher content without leaking it (%#)', async (character) => {
    await rejected({ ...settings(), supplements: [{ role: 'results', text: PRIVATE_MARKER + character }] });
    await rejected({ ...settings('custom', { custom: custom() }),
      custom: { ...custom(), labels: { need: PRIVATE_MARKER + character } } });
  });

  it('bounds teacher additions and rejects duplicate or unregistered target sections', async () => {
    const options = settings();
    await rejected({ ...options, supplements: [{ role: 'results', text: '가'.repeat(20_001) }] });
    await rejected({ ...options, supplements: [{ role: 'results', text: ' ' }] });
    await rejected({ ...options, supplements: [{ role: 'results', text: '첫 문단' }, { role: 'results', text: '둘째 문단' }] });
    await rejected({ ...options, supplements: [{ role: '__proto__', text: PRIVATE_MARKER }] });
    await rejected({ ...options, supplements: Array.from({ length: 9 }, () => ({ role: 'need', text: PRIVATE_MARKER })) });
  });

  it.each([
    { fontSizePt: Number.NaN }, { fontSizePt: Number.POSITIVE_INFINITY }, { fontSizePt: 5 }, { fontSizePt: 72.01 },
    { fontSizePt: 11.234 }, { fontSizePt: '11' }, { lineSpacingPercent: 79 }, { lineSpacingPercent: 301 },
    { lineSpacingPercent: 145.5 }, { fontFace: '' }, { fontFace: 'bad\nfont' }, { fontFace: '가'.repeat(129) },
    { marginMm: { ...custom().marginMm, left: -1 } }, { marginMm: { ...custom().marginMm, top: Number.NaN } },
    { marginMm: { ...custom().marginMm, left: 80, right: 80, gutter: 50 } },
    { labels: { unknown: '알 수 없는 구성' } }, { labels: { need: '' } }, { labels: { need: '가'.repeat(101) } },
  ])('rejects malformed manual rule values before creating a package (%#)', async (change) => {
    await rejected({ ...settings('custom', { custom: custom() }), custom: { ...custom(), ...change } });
  });

  it('preserves byte-identical source download after successful custom and summary outputs', async () => {
    const session = await createInspectionSession(fixture.slice(), 'synthetic-research.hwpx');
    const unchanged = session.exportUnchanged();
    await createResearchDraft(session.exportUnchanged(), settings('custom', { custom: custom(), supplements: [{ role: 'need', text: '직접 추가한 가상 연구 배경' }] }));
    const summary = settings('field-summary');
    summary.summaryParagraphIds = [summary.assignments[0]!.paragraphId];
    summary.summarySelectionConfirmed = true;
    await createResearchDraft(session.exportUnchanged(), summary);
    expect(session.exportUnchanged()).toEqual(unchanged);
    expect(session.exportUnchanged()).toEqual(fixture);
  });
});

describe('worker result envelopes cannot claim impossible preservation counts', () => {
  it('accepts the actual independently verified generated result', () => {
    expect(isDraftResponseResult(validResponse)).toBe(true);
  });

  it.each([
    { manualValidation: 'PASSED' }, { profileYear: 2026.5 }, { profileVersion: '<script>' },
    { addedParagraphCount: 9 }, { addedParagraphCount: -1 }, { sourceSelection: 'automatic-summary' },
    { includedParagraphCount: 0 }, { includedParagraphCount: 1.5 }, { excludedParagraphCount: -1 },
    { includedParagraphCount: 1, excludedParagraphCount: 1 },
    { includedParagraphCount: undefined }, { excludedParagraphCount: undefined },
    { sourceSelection: 'all', includedParagraphCount: 1, excludedParagraphCount: 9 },
  ])('rejects forged or incomplete new result metadata (%#)', (change) => {
    expect(isDraftResponseResult({ ...validResponse, ...change })).toBe(false);
  });
});
