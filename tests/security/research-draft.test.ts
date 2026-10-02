import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import type { DocumentInspection } from '../../src/domain/document';
import { EngineError, safeError } from '../../src/domain/errors';
import {
  DRAFT_LIMITS, isDraftRole, isResearchDraftOptions, type ResearchDraftOptions, type ResearchDraftResult,
} from '../../src/domain/research';
import { createResearchDraft } from '../../src/engine/draft';
import { recommendDraft, validateDraftAssignments } from '../../src/engine/draft/plan';
import { inspectHwpx } from '../../src/engine/preflight';
import { createInspectionSession } from '../../src/engine/session';
import { indexXml } from '../../src/engine/xml/index';
import { makeResearchFixture } from '../helpers/research-fixture';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HS = 'http://www.hancom.co.kr/hwpml/2011/section';
const MARKER = 'PRIVATE_DRAFT_MARKER';
const plain = makeResearchFixture();
let plainInspection: DocumentInspection;

beforeAll(async () => {
  plainInspection = (await inspectHwpx(plain, 'synthetic.hwpx')).inspection;
});

function options(): ResearchDraftOptions {
  return {
    kind: 'competition', title: '합성 수업 연구 초안', subject: '합성 교과', grade: '가상 학년', studentCount: '',
    assignments: [{ paragraphId: 'Contents/section0.xml#element-1', sourceText: '합성 본문', role: 'need' }],
  };
}

function sourceOptions(inspection = plainInspection): ResearchDraftOptions {
  const recommendation = recommendDraft(inspection, 'competition');
  if (!recommendation.eligible) throw new Error('Trusted pure prose fixture must be eligible.');
  return {
    ...options(),
    assignments: recommendation.paragraphs.map((paragraph) => ({
      paragraphId: paragraph.paragraphId, sourceText: paragraph.text, role: paragraph.role,
    })),
  };
}

/** Rebuild only our small trusted synthetic fixture, never user ZIP input. */
function withSection(transform: (source: string) => string): Uint8Array {
  const entries = unzipSync(plain);
  const original = entries['Contents/section0.xml'];
  if (!original) throw new Error('Missing trusted synthetic section.');
  entries['Contents/section0.xml'] = encoder.encode(transform(decoder.decode(original)));
  return zipSync(entries, { level: 0 });
}

function withHeader(transform: (source: string) => string): Uint8Array {
  const entries = unzipSync(plain);
  const original = entries['Contents/header.xml'];
  if (!original) throw new Error('Missing trusted synthetic header.');
  entries['Contents/header.xml'] = encoder.encode(transform(decoder.decode(original)));
  return zipSync(entries, { level: 0 });
}

function rejectedAssignments(inspection: DocumentInspection, input: unknown, code = 'FILE_INVALID_PACKAGE'): void {
  let failure: unknown;
  try { validateDraftAssignments(inspection, input); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(EngineError);
  expect((failure as EngineError).code).toBe(code);
  expect(JSON.stringify(safeError(failure))).not.toContain(MARKER);
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const escapedText = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('\r', '&#13;');

function withFirstText(text: string): Uint8Array {
  return withSection((source) => source.replace(/(<hp:t>)[\s\S]*?(<\/hp:t>)/u,
    (_match, opening: string, closing: string) => opening + escapedText(text) + closing));
}

async function reopenedSource(result: ResearchDraftResult): Promise<DocumentInspection> {
  const { inspection } = await inspectHwpx(result.bytes, 'draft.hwpx');
  expect(result.packageVerified).toBe(true);
  expect(result.originalTextVerified).toBe(true);
  expect(result.manualValidation).toBe('NOT_RUN');
  expect(inspection.paragraphs).toHaveLength(result.outputParagraphCount);
  expect(inspection.tables).toHaveLength(0);
  return inspection;
}

function sourceParagraphs(inspection: DocumentInspection) {
  return inspection.paragraphs.filter((paragraph) => paragraph.sourceId !== null
    && /^\d+$/u.test(paragraph.sourceId) && Number(paragraph.sourceId) >= 1000);
}

describe('research draft request validation', () => {
  it.each(['__proto__', 'constructor', 'unknown', '<script>', null, 1])(
    'rejects an unregistered paragraph role (%#)',
    (role) => {
      expect(isDraftRole(role)).toBe(false);
      const invalid = options();
      expect(isResearchDraftOptions({ ...invalid, assignments: [{ ...invalid.assignments[0], role }] })).toBe(false);
    },
  );

  it('rejects duplicate source paragraph assignments instead of duplicating the content', () => {
    const input = options();
    input.assignments.push({ ...input.assignments[0]!, role: 'results' });
    expect(isResearchDraftOptions(input)).toBe(false);
  });

  it.each([
    { title: ' ' },
    { title: '가'.repeat(DRAFT_LIMITS.maxTitleCharacters + 1) },
    { subject: '가'.repeat(101) },
    { grade: '가'.repeat(51) },
    { studentCount: '0' },
    { studentCount: '-1' },
    { studentCount: '1.5' },
    { kind: 'unknown' },
    { assignments: [] },
  ])('rejects invalid or unbounded metadata (%#)', (change) => {
    expect(isResearchDraftOptions({ ...options(), ...change })).toBe(false);
  });

  it('bounds both source paragraph count and text before generation', () => {
    const input = options();
    expect(isResearchDraftOptions({
      ...input,
      assignments: Array.from({ length: DRAFT_LIMITS.maxParagraphs + 1 }, (_, index) => ({
        paragraphId: `paragraph-${index}`, sourceText: '가', role: 'need',
      })),
    })).toBe(false);
    expect(isResearchDraftOptions({
      ...input,
      assignments: [{ ...input.assignments[0], sourceText: '가'.repeat(DRAFT_LIMITS.maxTextCharacters + 1) }],
    })).toBe(false);
    expect(isResearchDraftOptions(input)).toBe(true);
  });

  it('bounds assignment identities and requires exact source text strings', () => {
    const input = options();
    for (const change of [{ paragraphId: '' }, { paragraphId: 'x'.repeat(385) }, { sourceText: null }]) {
      expect(isResearchDraftOptions({ ...input, assignments: [{ ...input.assignments[0], ...change }] })).toBe(false);
    }
  });
});

describe('draft roles remain bound to all exact current source paragraphs', () => {
  it('accepts complete current assignments without altering the reading model', () => {
    const input = sourceOptions();
    const before = structuredClone(plainInspection);
    expect(() => validateDraftAssignments(plainInspection, input)).not.toThrow();
    expect(plainInspection).toEqual(before);
  });

  it.each(['missing', 'duplicate', 'unknown', 'stale_text', 'whitespace_change', 'invalid_role'])(
    'rejects %s assignments with a fixed diagnostic',
    (caseName) => {
      const input = sourceOptions();
      const first = input.assignments[0]!;
      if (caseName === 'missing') input.assignments.pop();
      if (caseName === 'duplicate') input.assignments[1] = { ...first };
      if (caseName === 'unknown') first.paragraphId = MARKER;
      if (caseName === 'stale_text') first.sourceText = MARKER;
      if (caseName === 'whitespace_change') first.sourceText += '\n';
      if (caseName === 'invalid_role') Object.assign(first, { role: '__proto__' });
      rejectedAssignments(plainInspection, input);
    },
  );

  it('rejects old assignments after different content reuses the same structural IDs', async () => {
    const input = sourceOptions();
    const changed = withSection((source) => source.replace('</hp:t>', `${MARKER}</hp:t>`));
    const current = (await inspectHwpx(changed, 'synthetic.hwpx')).inspection;
    expect(current.paragraphs.map((paragraph) => paragraph.nodeId))
      .toEqual(plainInspection.paragraphs.map((paragraph) => paragraph.nodeId));
    rejectedAssignments(current, input);
  });
});

describe('draft reconstruction refuses to drop protected or unrecognized source content', () => {
  it.each([
    ['table', { includeTable: true }],
    ['note', { includeNote: true }],
    ['field', { includeField: true }],
  ] as const)('refuses a source containing a %s even if assignments cover the other body paragraphs', async (_label, settings) => {
    const input = makeResearchFixture(settings);
    const before = input.slice();
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    rejectedAssignments(inspection, sourceOptions(), 'FILE_UNSUPPORTED');
    expect(input).toEqual(before);
  });

  it.each([
    (source: string) => source.replace('<hp:p id="0"', `${MARKER}<hp:p id="0"`),
    (source: string) => source.replace('<hp:run charPrIDRef="0">', `${MARKER}<hp:run charPrIDRef="0">`),
    (source: string) => source.replace('<hp:run charPrIDRef="0">', `<hp:run charPrIDRef="0">${MARKER}`),
    (source: string) => source.replace('<hp:t>', '<hp:alien/><hp:t>'),
    (source: string) => source.replace('<hp:t>', '<foreign:t xmlns:foreign="urn:foreign"/> <hp:t>'),
  ])('refuses source text or controls outside the understood structure (%#)', async (transform) => {
    const inspection = (await inspectHwpx(withSection(transform), 'synthetic.hwpx')).inspection;
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    rejectedAssignments(inspection, sourceOptions(), 'FILE_UNSUPPORTED');
  });

  it('allows only exact inert section and column layout metadata for replacement', async () => {
    const layout = '<hp:secPr><hp:pagePr><hp:margin/></hp:pagePr></hp:secPr>' +
      '<hp:ctrl><hp:colPr><hp:colSz/></hp:colPr></hp:ctrl>';
    const input = withSection((source) => source.replace('<hp:t>', `${layout}<hp:t>`));
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(recommendDraft(inspection, 'competition').eligible).toBe(true);
    expect(inspection.runs[0]?.segments.filter((segment) => segment.kind === 'UNKNOWN_CONTROL')
      .map((segment) => segment.layoutControl)).toEqual([true, true]);
    expect(() => validateDraftAssignments(inspection, sourceOptions(inspection))).not.toThrow();
  });

  it.each([
    `<hp:secPr><hp:grid>${MARKER}</hp:grid></hp:secPr>`,
    '<hp:secPr><foreign:pagePr xmlns:foreign="urn:foreign"/></hp:secPr>',
    '<hp:secPr><hp:unknown/></hp:secPr>',
    '<hp:ctrl><hp:fieldBegin id="1"/><hp:fieldEnd beginIDRef="1"/></hp:ctrl>',
  ])('does not grant a layout exception to text, namespace spoofing or real controls (%#)', async (layout) => {
    const input = withSection((source) => source.replace('<hp:t>', `${layout}<hp:t>`));
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    rejectedAssignments(inspection, sourceOptions(), 'FILE_UNSUPPORTED');
  });

  it('replaces a valid line-layout cache without losing any source paragraph text', async () => {
    const cache = '<hp:linesegarray>\n<hp:lineseg textpos="0" vertpos="0"/>\n</hp:linesegarray>';
    const input = withSection((source) => source.replace('</hp:p>', `${cache}</hp:p>`));
    const before = input.slice();
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(recommendDraft(inspection, 'competition').eligible).toBe(true);
    const expectedText = inspection.paragraphs.map((paragraph) => paragraph.text);
    expect(expectedText).toEqual(plainInspection.paragraphs.map((paragraph) => paragraph.text));
    const result = await createResearchDraft(input, sourceOptions(inspection));
    const reopened = await reopenedSource(result);
    expect(sourceParagraphs(reopened).map((paragraph) => paragraph.text).sort()).toEqual([...expectedText].sort());
    const outputSection = unzipSync(result.bytes)['Contents/section0.xml'];
    expect(outputSection).toBeDefined();
    expect(indexXml(outputSection!).elements.some((element) => element.local.toLowerCase() === 'linesegarray')).toBe(false);
    expect(input).toEqual(before);
  });

  it.each([
    `<hp:linesegarray><hp:t>${MARKER}</hp:t></hp:linesegarray>`,
    `<hp:linesegarray>${MARKER}<hp:lineseg/></hp:linesegarray>`,
    '<hp:linesegarray><foreign:lineseg xmlns:foreign="urn:foreign"/></hp:linesegarray>',
    '<hp:linesegarray><hp:lineseg><hp:unknown/></hp:lineseg></hp:linesegarray>',
    '<hp:linesegarray>\u00a0<hp:lineseg/></hp:linesegarray>',
  ])('refuses hidden text or unrecognized children inside a claimed layout cache (%#)', async (cache) => {
    const input = withSection((source) => source.replace('</hp:p>', `${cache}</hp:p>`));
    const before = input.slice();
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(inspection.paragraphs[0]?.reasons).toContain('UNKNOWN_ELEMENT');
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    await expect(createResearchDraft(input, sourceOptions())).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' });
    expect(input).toEqual(before);
  });

  it.each([
    (source: string) => source.replace('<hp:p id="0"', '\u00a0<hp:p id="0"'),
    (source: string) => source.replace('<hp:run charPrIDRef="0">', '\u00a0<hp:run charPrIDRef="0">'),
    (source: string) => source.replace('<hp:t>', '\u00a0<hp:t>'),
    (source: string) => source.replace('<hp:t>', '<hp:secPr><hp:grid>\u00a0</hp:grid></hp:secPr><hp:t>'),
  ])('does not discard non-XML whitespace outside understood text nodes (%#)', async (transform) => {
    const input = withSection(transform);
    const before = input.slice();
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    await expect(createResearchDraft(input, sourceOptions())).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' });
    expect(input).toEqual(before);
  });

  it('preserves non-XML whitespace when it is actual paragraph text', async () => {
    const text = '\u00a0합성 문장\ufeff보존\u2028구분';
    const input = withFirstText(text);
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(inspection.paragraphs[0]?.text).toBe(text);
    expect(recommendDraft(inspection, 'competition').eligible).toBe(true);
    const result = await createResearchDraft(input, sourceOptions(inspection));
    const reopened = sourceParagraphs(await reopenedSource(result));
    expect(reopened.filter((paragraph) => paragraph.text === text)).toHaveLength(1);
  });

  it.each([
    ['supscript', 'case'],
    ['subscript', 'default'],
  ] as const)('protects possible %s semantics inside a compatibility %s', async (script, branch) => {
    const contents = branch === 'case'
      ? `<hp:case hp:required-namespace="${HP}"><hh:${script}/></hp:case><hp:default/>`
      : `<hp:case hp:required-namespace="${HP}"/><hp:default><hh:${script}/></hp:default>`;
    const input = withHeader((source) => source.replace('</hh:charPr>',
      `<hp:switch xmlns:hp="${HP}">${contents}</hp:switch></hh:charPr>`));
    const before = input.slice();
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    const format = inspection.runs[0]?.characterFormat;
    expect(format?.superscript).toBe(false);
    expect(format?.subscript).toBe(false);
    expect(format?.reasons).toContain('COMPATIBILITY_BRANCH');
    expect(format?.reasons).toContain('SUPERSCRIPT_OR_SUBSCRIPT');
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    await expect(createResearchDraft(input, sourceOptions())).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' });
    expect(input).toEqual(before);
  });

  it.each([
    ['0', 'supscript'],
    ['00', 'subscript'],
  ] as const)('refuses an ambiguous character shape whose duplicate %s can supply %s semantics', async (id, script) => {
    const input = withHeader((source) => source.replace('</hh:charProperties>',
      `<hh:charPr id="${id}" height="1100"><hh:${script}/></hh:charPr></hh:charProperties>`));
    const before = input.slice();
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    const reference = inspection.runs[0]?.characterFormat.reference;
    expect(reference?.resolved).toBe(false);
    expect(reference?.reasons).toContain('AMBIGUOUS_FORMAT_REFERENCE');
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    await expect(createResearchDraft(input, sourceOptions())).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' });
    expect(input).toEqual(before);
  });

  it('still replaces paragraph margins selected by a compatibility branch', async () => {
    const input = withHeader((source) => source.replace('</hh:paraPr>',
      `<hp:switch xmlns:hp="${HP}"><hp:case hp:required-namespace="${HP}"><hh:margin><hh:left value="100" unit="HWPUNIT"/></hh:margin></hp:case><hp:default><hh:margin><hh:left value="200" unit="HWPUNIT"/></hh:margin></hp:default></hp:switch></hh:paraPr>`));
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(inspection.paragraphs[0]?.reasons).toContain('COMPATIBILITY_BRANCH');
    expect(recommendDraft(inspection, 'competition').eligible).toBe(true);
    const result = await createResearchDraft(input, sourceOptions(inspection));
    expect(sourceParagraphs(await reopenedSource(result)).map((paragraph) => paragraph.text).sort())
      .toEqual(inspection.paragraphs.map((paragraph) => paragraph.text).sort());
  });

  it('bounds the real inspected paragraph count before reconstructing', async () => {
    const paragraphs = Array.from({ length: DRAFT_LIMITS.maxParagraphs + 1 }, (_, index) =>
      `<hp:p id="${index}"><hp:run><hp:t>합성</hp:t></hp:run></hp:p>`).join('');
    const input = withSection(() => `<hs:sec xmlns:hs="${HS}" xmlns:hp="${HP}">${paragraphs}</hs:sec>`);
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(inspection.paragraphs).toHaveLength(DRAFT_LIMITS.maxParagraphs + 1);
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    rejectedAssignments(inspection, sourceOptions(), 'FILE_UNSUPPORTED');
  });

  it('bounds real inspected text independently of paragraph count', async () => {
    const text = '가'.repeat(DRAFT_LIMITS.maxTextCharacters + 1);
    const input = withSection(() => `<hs:sec xmlns:hs="${HS}" xmlns:hp="${HP}"><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hs:sec>`);
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    expect(inspection.paragraphs[0]?.text.length).toBe(DRAFT_LIMITS.maxTextCharacters + 1);
    expect(recommendDraft(inspection, 'competition').eligible).toBe(false);
    rejectedAssignments(inspection, sourceOptions(), 'FILE_UNSUPPORTED');
  });

  it('does not repeatedly rescan a large whitespace prefix when recommending a role', async () => {
    const input = withFirstText('\n'.repeat(50_000) + '합성 문장');
    const inspection = (await inspectHwpx(input, 'synthetic.hwpx')).inspection;
    const started = performance.now();
    const recommendation = recommendDraft(inspection, 'competition');
    expect(recommendation.eligible).toBe(true);
    expect(recommendation.paragraphs[0]?.role).toBe('need');
    // The former cross-line greedy prefix takes seconds at this modest size.
    // Leave a generous margin for shared CI machines while catching that scan.
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('separate draft output has independent package and original-text evidence', () => {
  it.each(['competition', 'paper'] as const)('reopens a %s draft and preserves every original byte', async (kind) => {
    const input = new Uint8Array(plain);
    const original = input.slice();
    const originalHash = sha256(input);
    const session = await createInspectionSession(input, 'synthetic.hwpx');
    const settings = sourceOptions(session.inspection);
    settings.kind = kind;
    const result = await createResearchDraft(input, settings);
    const inspection = await reopenedSource(result);
    const source = sourceParagraphs(inspection);
    expect(result.kind).toBe(kind);
    expect(source).toHaveLength(settings.assignments.length);
    expect(result.sourceParagraphCount).toBe(settings.assignments.length);
    expect(new Set(source.map((paragraph) => paragraph.sourceId)).size).toBe(source.length);
    expect(source.map((paragraph) => paragraph.text).sort())
      .toEqual(settings.assignments.map((assignment) => assignment.sourceText).sort());
    expect(result.bytes.buffer).not.toBe(input.buffer);
    expect(input).toEqual(original);
    expect(sha256(input)).toBe(originalHash);
    expect(session.exportUnchanged()).toEqual(original);
    expect(session.originalSha256).toBe(originalHash);
    expect(sha256(result.bytes)).not.toBe(originalHash);
    // Use the real transfer operation: detaching the output cannot detach input.
    const copy = new Uint8Array(result.bytes);
    structuredClone(copy, { transfer: [copy.buffer] });
    expect(copy.byteLength).toBe(0);
    expect(input).toEqual(original);
  });

  it('escapes XML-looking source and metadata while preserving Korean, emoji, literal entities and line controls', async () => {
    const payload = '한글🙂 & <hp:script onclick="x">그대로</hp:script> "큰따옴표" \'작은따옴표\' ' +
      '&#x1f642; ]]>\t탭\n줄바꿈\r문자참조 CR https://outside.invalid/PRIVATE_DRAFT_MARKER';
    const input = withFirstText(payload);
    const original = input.slice();
    const settings = sourceOptions((await inspectHwpx(input, 'synthetic.hwpx')).inspection);
    settings.title = '한글🙂 <태그> & "제목" \'문자열\'';
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected draft network request.'));
    try {
      const result = await createResearchDraft(input, settings);
      const inspection = await reopenedSource(result);
      expect(sourceParagraphs(inspection).filter((paragraph) => paragraph.text === payload)).toHaveLength(1);
      expect(inspection.paragraphs.some((paragraph) => paragraph.text === settings.title)).toBe(true);
      // This is generated bounded output; unbounded user ZIPs never enter fflate.
      const entries = unzipSync(result.bytes);
      const section = entries['Contents/section0.xml'];
      const metadata = entries['Contents/content.hpf'];
      if (!section || !metadata) throw new Error('Missing generated package components.');
      expect(indexXml(section).elements.some((element) => element.local === 'script')).toBe(false);
      expect(indexXml(metadata).elements.some((element) => element.local === '태그')).toBe(false);
      const raw = decoder.decode(section);
      expect(raw).toContain('&lt;hp:script');
      expect(raw).toContain('&amp;#x1f642;');
      expect(raw).toContain(']]&gt;');
      expect(raw).toContain('&#13;');
      expect(raw).toContain('<hp:tab/>');
      expect(raw).toContain('<hp:lineBreak/>');
      expect(fetch).not.toHaveBeenCalled();
      expect(input).toEqual(original);
    } finally { fetch.mockRestore(); }
  });

  it('keeps canonical source order within a role when assignment requests are shuffled', async () => {
    const settings = sourceOptions();
    for (const assignment of settings.assignments) assignment.role = 'need';
    const expected = settings.assignments.map((assignment) => assignment.sourceText);
    settings.assignments.reverse();
    const unchanged = structuredClone(settings);
    const inspection = await reopenedSource(await createResearchDraft(plain, settings));
    expect(sourceParagraphs(inspection).map((paragraph) => paragraph.text)).toEqual(expected);
    expect(settings).toEqual(unchanged);
  });

  it('does not deduplicate distinct source paragraphs merely because their text matches', async () => {
    const repeated = '합성 반복 본문';
    const input = withSection((source) => {
      let matches = 0;
      return source.replace(/(<hp:t>)[\s\S]*?(<\/hp:t>)/gu, (original, opening: string, closing: string) =>
        matches++ < 2 ? opening + repeated + closing : original);
    });
    const settings = sourceOptions((await inspectHwpx(input, 'synthetic.hwpx')).inspection);
    const source = sourceParagraphs(await reopenedSource(await createResearchDraft(input, settings)));
    expect(source).toHaveLength(settings.assignments.length);
    expect(source.filter((paragraph) => paragraph.text === repeated)).toHaveLength(2);
  });

  it('owns both source bytes and reviewed assignments before asynchronous work yields', async () => {
    const session = await createInspectionSession(plain, 'synthetic.hwpx');
    const input = session.getWorkerBytes();
    const settings = sourceOptions(session.inspection);
    const expected = structuredClone(settings);
    const creating = createResearchDraft(input, settings);
    input.fill(0);
    settings.title = MARKER;
    settings.assignments[0]!.sourceText = MARKER;
    settings.assignments[0]!.role = 'appendix';
    const inspection = await reopenedSource(await creating);
    expect(sourceParagraphs(inspection).map((paragraph) => paragraph.text).sort())
      .toEqual(expected.assignments.map((assignment) => assignment.sourceText).sort());
    expect(inspection.paragraphs.some((paragraph) => paragraph.text === expected.title)).toBe(true);
    expect(inspection.paragraphs.some((paragraph) => paragraph.text === MARKER)).toBe(false);
    expect(session.exportUnchanged()).toEqual(plain);
  });

  it('imports no source resources or line-layout caches into the new template package', async () => {
    const entries = unzipSync(plain);
    entries[`Resources/${MARKER}.bin`] = encoder.encode('public synthetic unused resource');
    const input = zipSync(entries, { level: 0 });
    const settings = sourceOptions((await inspectHwpx(input, 'synthetic.hwpx')).inspection);
    const result = await createResearchDraft(input, settings);
    const output = unzipSync(result.bytes);
    expect(Object.keys(output).some((path) => path.includes(MARKER))).toBe(false);
    const section = output['Contents/section0.xml'];
    if (!section) throw new Error('Missing generated section.');
    const names = indexXml(section).elements.map((element) => element.local.toLowerCase());
    expect(names).not.toContain('linesegarray');
    expect(names).not.toContain('pic');
    expect(names).not.toContain('tbl');
    expect(names).not.toContain('fieldbegin');
    expect(names).not.toContain('footnote');
    await reopenedSource(result);
  });

  it.each(['\u0000', '\u0001', '\ud800', '\ufffe'])('rejects invalid XML characters in editable draft metadata (%#)', async (invalidCharacter) => {
    const settings = sourceOptions();
    settings.title = MARKER + invalidCharacter;
    const original = plain.slice();
    let failure: unknown;
    try { await createResearchDraft(plain, settings); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(EngineError);
    expect(JSON.stringify(safeError(failure))).not.toContain(MARKER);
    expect(plain).toEqual(original);
  });

  it('refuses stale assignment text through the full generation API without changing the source', async () => {
    const settings = sourceOptions();
    settings.assignments[0]!.sourceText = MARKER;
    const original = plain.slice();
    let failure: unknown;
    try { await createResearchDraft(plain, settings); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(EngineError);
    expect((failure as EngineError).code).toBe('FILE_INVALID_PACKAGE');
    expect(JSON.stringify(safeError(failure))).not.toContain(MARKER);
    expect(plain).toEqual(original);
  });

  it.each([
    { includeTable: true },
    { includeNote: true },
    { includeField: true },
  ])('refuses a protected source through the full generator instead of emitting a partial draft (%#)', async (settings) => {
    const input = makeResearchFixture(settings);
    const original = input.slice();
    let failure: unknown;
    try { await createResearchDraft(input, sourceOptions()); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(EngineError);
    expect((failure as EngineError).code).toBe('FILE_UNSUPPORTED');
    expect(input).toEqual(original);
  });

  it.each([
    ['DTD', (source: string) => source.replace('<?xml version="1.0" encoding="UTF-8"?>',
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE hs:sec SYSTEM "https://outside.invalid/${MARKER}">`)],
    ['ACTIVE_CONTENT', (source: string) => source.replace('<hp:t>', '<hp:script/><hp:t>')],
    ['EVENT_ATTRIBUTE', (source: string) => source.replace('<hp:t>', `<hp:t onclick="${MARKER}">`)],
    ['EXTERNAL_REFERENCE', (source: string) => source.replace('<hp:t>', `<hp:t href="https://outside.invalid/${MARKER}">`)],
  ] as const)('retains the %s XML security gate on the new generation entry point', async (reason, transform) => {
    const input = withSection(transform);
    const original = input.slice();
    let failure: unknown;
    try { await createResearchDraft(input, sourceOptions()); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(EngineError);
    expect(safeError(failure)).toMatchObject({ code: 'XML_UNSUPPORTED', xmlReason: reason });
    expect(JSON.stringify(safeError(failure))).not.toContain(MARKER);
    expect(input).toEqual(original);
  });
});
