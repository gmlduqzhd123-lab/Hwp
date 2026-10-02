import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/lib/zip-core-native.js';
import { FONT_LANGUAGES } from '../../domain/document';
import { getEffectiveDraftProfile, SCHOOL_LEVEL_LABELS } from '../../domain/competitions';
import type { DraftProfile } from '../../domain/competition-types';
import { EngineError } from '../../domain/errors';
import { RESOURCE_LIMITS } from '../../domain/limits';
import { DRAFT_SOURCE_ID_BASE, DRAFT_SUPPLEMENT_ID_BASE, isResearchDraftOptions, type DraftPage, type ResearchDraftOptions, type ResearchDraftResult } from '../../domain/research';
import { inspectHwpx } from '../preflight';
import { attributeValue, elementChildren, indexXml } from '../xml/index';
import { validateDraftAssignments } from './plan';
import { makeResearchDraft } from './writer';

const PARAGRAPH_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HEAD_NS = 'http://www.hancom.co.kr/hwpml/2011/head';
type ExpectedStyle = 'body' | 'title' | 'heading' | 'cover' | 'toc' | 'references';
interface ExpectedParagraph { id: number; text: string; style: ExpectedStyle; pageBreak: boolean }

function invalidOutput(): never {
  throw new EngineError('FILE_INVALID_PACKAGE', 'The draft did not pass independent validation.');
}

/** Independent expectations from the accepted request, never from a writer plan. */
function expectedOutput(options: ResearchDraftOptions, profile: DraftProfile): ExpectedParagraph[] {
  const result: ExpectedParagraph[] = [{ id: 0, text: '', style: 'body', pageBreak: false }];
  const selected = options.summaryParagraphIds === undefined ? null : new Set(options.summaryParagraphIds);
  const source = options.assignments.map((assignment, ordinal) => ({ ...assignment, ordinal }))
    .filter((assignment) => !selected || selected.has(assignment.paragraphId));
  if (profile.policy === 'format-only') return [...result, ...source.map((assignment) => ({
    id: DRAFT_SOURCE_ID_BASE + assignment.ordinal, text: assignment.sourceText, style: 'body' as const, pageBreak: false,
  }))];
  const covers: string[] = [profile.coverHeading, options.title];
  for (const field of profile.coverFields) {
    switch (field) {
      case 'schoolLevel': covers.push(`학교급: ${SCHOOL_LEVEL_LABELS[options.schoolLevel ?? 'elementary']}`); break;
      case 'subject': covers.push(`출품교과: ${options.subject}`); if (profile.id === 'innovation-report') covers.push('관리번호: '); break;
      case 'researchType': covers.push(`연구형태: ${options.researchType === 'individual' ? '개인연구' : options.researchType === 'joint' ? '공동연구' : ''}`); break;
      case 'grade': covers.push(`학년: ${options.grade}`); break;
      case 'studentCount': covers.push(`학생수: ${options.studentCount}`); break;
    }
  }
  let scaffoldId = 1;
  for (const [ordinal, text] of covers.entries()) result.push({ id: scaffoldId++, text, style: ordinal === 1 ? 'title' : 'cover', pageBreak: false });
  // Derive the complete expected sequence, including source/supplement interleaving.
  const outline = profile.roles.flatMap((role) => [
    { text: profile.labels[role], style: 'heading' as const, pageBreak: role === 'appendix' || role === 'need' || role === 'summary' && options.kind === 'competition' && profile.documentType !== 'summary' },
    ...source.filter((assignment) => assignment.role === role).map((assignment) => ({ id: DRAFT_SOURCE_ID_BASE + assignment.ordinal, text: assignment.sourceText, style: role === 'references' ? 'references' as const : 'body' as const, pageBreak: false })),
    ...(options.supplements ?? []).map((supplement, ordinal) => ({ ...supplement, ordinal })).filter((supplement) => supplement.role === role)
      .map((supplement) => ({ id: DRAFT_SUPPLEMENT_ID_BASE + supplement.ordinal, text: supplement.text, style: role === 'references' ? 'references' as const : 'body' as const, pageBreak: false })),
    ...(role === 'summary' && profile.includeToc ? [{ text: '목차', style: 'heading' as const, pageBreak: true },
      ...profile.roles.map((item) => ({ text: profile.labels[item], style: 'toc' as const, pageBreak: false }))] : []),
  ]);
  if (profile.includeToc && !profile.roles.includes('summary')) outline.unshift({ text: '목차', style: 'heading', pageBreak: true },
    ...profile.roles.map((role) => ({ text: profile.labels[role], style: 'toc' as const, pageBreak: false })));
  for (const entry of outline) result.push({ ...entry, id: 'id' in entry ? entry.id : scaffoldId++ });
  return result;
}

function expectedFontSize(style: ExpectedStyle, page: DraftPage): number {
  if (style === 'body') return page.fontSizePt;
  return page.fontSizes?.[style] ?? (style === 'title' ? 16 : style === 'heading' || style === 'references' ? page.fontSizePt : 12);
}

/** Reopen actual ZIP/XML and verify every emitted paragraph, reference and value. */
async function verifyDraftOutput(bytes: Uint8Array, options: ResearchDraftOptions, profile: DraftProfile): Promise<number> {
  const page = profile.page;
  const expected = expectedOutput(options, profile);
  const { report, inspection } = await inspectHwpx(bytes, 'research-draft.hwpx');
  if (report.sectionPaths.length !== 1 || inspection.tables.length || inspection.paragraphs.length !== expected.length
    || inspection.paragraphs.some((paragraph) => paragraph.context !== 'BODY')) invalidOutput();
  const runs = new Map(inspection.runs.map((run) => [run.nodeId, run]));
  for (const [ordinal, paragraph] of inspection.paragraphs.entries()) {
    const entry = expected[ordinal];
    if (!entry || paragraph.sourceId !== String(entry.id) || paragraph.text !== entry.text || paragraph.runIds.length !== 1) invalidOutput();
    const format = paragraph.paragraphFormat;
    const bodyStyle = entry.style === 'body' || entry.style === 'references';
    const alignment = bodyStyle ? 'JUSTIFY' : entry.style === 'title' ? 'CENTER' : 'LEFT';
    if (!format.reference.resolved || !paragraph.styleReference.resolved || format.lineSpacing.value !== page.lineSpacingPercent
      || format.lineSpacingType.value !== 'PERCENT' || format.alignment.value !== alignment
      || format.indent.value !== (bodyStyle ? page.indent / 100 : 0)
      || format.beforeSpacing.value !== page.beforeSpacing / 100 || format.afterSpacing.value !== page.afterSpacing / 100
      || format.leftMargin.value !== 0 || format.rightMargin.value !== 0) invalidOutput();
    const run = runs.get(paragraph.runIds[0]!);
    if (!run || !run.characterFormat.reference.resolved || run.characterFormat.fontSize.value !== expectedFontSize(entry.style, page)
      || run.characterFormat.superscript || run.characterFormat.subscript
      || FONT_LANGUAGES.some((language) => run.characterFormat.fonts[language].value !== page.fontFace
        || run.characterFormat.ratio[language].value !== 100 || run.characterFormat.spacing[language].value !== 0
        || run.characterFormat.relativeSize[language].value !== 100 || run.characterFormat.offset[language].value !== 0)
      || entry.id !== 0 && run.segments.some((segment) => segment.kind === 'UNKNOWN_CONTROL')) invalidOutput();
  }
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, useCompressionStream: false, checkSignature: true });
  try {
    const entries = await reader.getEntries();
    const read = async (path: string) => {
      const entry = entries.find((candidate) => candidate.filename === path);
      if (!entry || entry.directory || entry.uncompressedSize > RESOURCE_LIMITS.maxXmlBytes) invalidOutput();
      return entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false, checkSignature: true });
    };
    const index = indexXml(await read(report.sectionPaths[0]!));
    const header = indexXml(await read('Contents/header.xml'));
    if (index.elements.some((element) => ['linesegarray', 'lineSegArray', 'pic', 'tbl', 'fieldBegin', 'fieldEnd', 'footNote', 'endNote', 'header', 'footer'].includes(element.local))) invalidOutput();
    const paragraphs = elementChildren(index.root, PARAGRAPH_NS, 'p');
    if (paragraphs.length !== expected.length) invalidOutput();
    for (const [ordinal, paragraph] of paragraphs.entries()) {
      const entry = expected[ordinal]!;
      const run = elementChildren(paragraph, PARAGRAPH_NS, 'run')[0];
      const styleId = attributeValue(paragraph, '', 'styleIDRef');
      const styles = header.elements.filter((element) => element.uri === HEAD_NS && element.local === 'style' && attributeValue(element, '', 'id') === styleId);
      const style = styles[0];
      if (!run || styles.length !== 1 || !style || attributeValue(paragraph, '', 'id') !== String(entry.id)
        || entry.id !== 0 && attributeValue(paragraph, '', 'pageBreak') !== (entry.pageBreak ? '1' : '0')
        || attributeValue(style, '', 'paraPrIDRef') !== attributeValue(paragraph, '', 'paraPrIDRef')
        || attributeValue(style, '', 'charPrIDRef') !== attributeValue(run, '', 'charPrIDRef')) invalidOutput();
      const character = header.elements.find((element) => element.uri === HEAD_NS && element.local === 'charPr' && attributeValue(element, '', 'id') === attributeValue(run, '', 'charPrIDRef'));
      if (!character || elementChildren(character, HEAD_NS, 'bold').length !== (entry.style === 'heading' || entry.style === 'title' ? 1 : 0)) invalidOutput();
    }
    const pages = index.elements.filter((element) => element.uri === PARAGRAPH_NS && element.local === 'pagePr');
    const margins = index.elements.filter((element) => element.uri === PARAGRAPH_NS && element.local === 'margin' && element.parent?.uri === PARAGRAPH_NS && element.parent.local === 'pagePr');
    const settings = pages[0];
    const margin = margins[0];
    if (pages.length !== 1 || margins.length !== 1 || !settings || !margin
      || attributeValue(settings, '', 'width') !== String(page.width) || attributeValue(settings, '', 'height') !== String(page.height)
      || attributeValue(settings, '', 'landscape') !== 'WIDELY') invalidOutput();
    for (const [name, value] of Object.entries(page.margins)) if (attributeValue(margin, '', name) !== String(value)) invalidOutput();
  } finally { await reader.close(); }
  return inspection.paragraphs.length;
}

/** A separate local draft; source bytes/resources are never edited or included. */
export async function createResearchDraft(input: Uint8Array, inputOptions: unknown): Promise<ResearchDraftResult> {
  if (!isResearchDraftOptions(inputOptions)) throw new EngineError('FILE_INVALID_PACKAGE', 'Invalid draft request.');
  if (input.byteLength > RESOURCE_LIMITS.maxInputBytes) throw new EngineError('RESOURCE_LIMIT', 'Draft source exceeds its limit.');
  const original = new Uint8Array(input);
  const options = structuredClone(inputOptions);
  try {
    const profile = getEffectiveDraftProfile(options);
    const { inspection } = await inspectHwpx(original, 'source.hwpx');
    validateDraftAssignments(inspection, options);
    const assignments = new Map(options.assignments.map((assignment) => [assignment.paragraphId, assignment]));
    options.assignments = inspection.paragraphs.map((paragraph) => {
      const assignment = assignments.get(paragraph.nodeId);
      if (!assignment) invalidOutput();
      return assignment;
    });
    const bytes = await makeResearchDraft(options, structuredClone(profile.page));
    if (bytes.byteLength > RESOURCE_LIMITS.maxInputBytes) throw new EngineError('RESOURCE_LIMIT', 'Draft output exceeds its limit.');
    const outputParagraphCount = await verifyDraftOutput(bytes, options, profile);
    const includedParagraphCount = options.summaryParagraphIds?.length ?? options.assignments.length;
    return { bytes, kind: options.kind, sourceParagraphCount: options.assignments.length, outputParagraphCount,
      packageVerified: true, originalTextVerified: true, manualValidation: 'NOT_RUN',
      profileId: profile.id, profileLabel: profile.label, profileYear: profile.year, profileVersion: profile.version,
      addedParagraphCount: options.supplements?.length ?? 0, includedParagraphCount,
      excludedParagraphCount: options.assignments.length - includedParagraphCount,
      sourceSelection: options.summaryParagraphIds === undefined ? 'all' : 'summary-selection' };
  } finally { original.fill(0); }
}
