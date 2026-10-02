import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/lib/zip-core-native.js';
import { FONT_LANGUAGES } from '../../domain/document';
import { EngineError } from '../../domain/errors';
import { RESOURCE_LIMITS } from '../../domain/limits';
import { DRAFT_ROLES, DRAFT_SOURCE_ID_BASE, isResearchDraftOptions, type DraftPage, type ResearchDraftOptions, type ResearchDraftResult } from '../../domain/research';
import { inspectHwpx } from '../preflight';
import { attributeValue, indexXml } from '../xml/index';
import { DRAFT_ROLE_LABELS, OFFICIAL_PROFILE, PAPER_PAGE, validateDraftAssignments } from './plan';
import { makeResearchDraft } from './writer';

const PARAGRAPH_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';

function invalidOutput(): never {
  throw new EngineError('FILE_INVALID_PACKAGE', 'The draft did not pass independent validation.');
}

/** Reopen the serialized output, rather than accepting the writer's model. */
async function verifyDraftOutput(bytes: Uint8Array, options: ResearchDraftOptions, page: DraftPage): Promise<number> {
  const { report, inspection } = await inspectHwpx(bytes, 'research-draft.hwpx');
  if (report.sectionPaths.length !== 1 || inspection.tables.length || inspection.paragraphs.some((paragraph) => paragraph.context !== 'BODY')) invalidOutput();
  const source = inspection.paragraphs.filter((paragraph) => paragraph.sourceId !== null && /^(?:0|[1-9][0-9]*)$/u.test(paragraph.sourceId) && Number(paragraph.sourceId) >= DRAFT_SOURCE_ID_BASE);
  if (source.length !== options.assignments.length) invalidOutput();
  const order = options.assignments.map((assignment, index) => ({ ...assignment, index }))
    .sort((left, right) => DRAFT_ROLES.indexOf(left.role) - DRAFT_ROLES.indexOf(right.role) || left.index - right.index);
  for (const [index, paragraph] of source.entries()) {
    const expected = order[index];
    if (!expected || paragraph.sourceId !== String(DRAFT_SOURCE_ID_BASE + expected.index) || paragraph.text !== expected.sourceText) invalidOutput();
    const format = paragraph.paragraphFormat;
    if (!format.reference.resolved || !paragraph.styleReference.resolved || format.lineSpacing.value !== page.lineSpacingPercent
      || format.lineSpacingType.value !== 'PERCENT' || format.indent.value !== page.indent / 100
      || format.beforeSpacing.value !== page.beforeSpacing / 100 || format.afterSpacing.value !== page.afterSpacing / 100) invalidOutput();
  }
  const sourceIds = new Set(source.map((paragraph) => paragraph.nodeId));
  const scaffold = inspection.paragraphs.filter((paragraph) => !sourceIds.has(paragraph.nodeId));
  const labels = DRAFT_ROLE_LABELS[options.kind];
  const expectedScaffold = options.kind === 'competition'
    ? ['', '2026학년도 수업혁신사례연구대회 보고서', options.title, '학교급: 초등학교', `출품교과: ${options.subject}`, '관리번호: ',
      `연구형태: ${options.researchType === 'individual' ? '개인연구' : options.researchType === 'joint' ? '공동연구' : ''}`, `학년: ${options.grade}`, `학생수: ${options.studentCount}`,
      labels.summary, '목차', ...DRAFT_ROLES.map((role) => labels[role]), ...DRAFT_ROLES.slice(1).map((role) => labels[role])]
    : ['', '논문 구성 초안', options.title, ...DRAFT_ROLES.map((role) => labels[role])];
  if (scaffold.length !== expectedScaffold.length || scaffold.some((paragraph, index) => paragraph.sourceId !== String(index) || paragraph.text !== expectedScaffold[index])) invalidOutput();
  for (const paragraph of inspection.paragraphs) {
    if (!paragraph.paragraphFormat.reference.resolved || !paragraph.styleReference.resolved) invalidOutput();
  }
  for (const run of inspection.runs.filter((run) => sourceIds.has(run.paragraphId))) {
    if (!run.characterFormat.reference.resolved || run.characterFormat.fontSize.value !== page.fontSizePt
      || FONT_LANGUAGES.some((language) => run.characterFormat.fonts[language].value !== page.fontFace)
      || run.segments.some((segment) => segment.kind === 'UNKNOWN_CONTROL')) invalidOutput();
  }
  // Body headings use the body's stated size too; the cover title is distinct.
  const ordinaryScaffold = new Set(scaffold.filter((paragraph) => paragraph.sourceId !== '2').map((paragraph) => paragraph.nodeId));
  for (const run of inspection.runs.filter((run) => ordinaryScaffold.has(run.paragraphId))) {
    if (!run.characterFormat.reference.resolved || run.characterFormat.fontSize.value !== page.fontSizePt
      || FONT_LANGUAGES.some((language) => run.characterFormat.fonts[language].value !== page.fontFace)) invalidOutput();
  }
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, useCompressionStream: false, checkCrc32: true });
  try {
    const entries = await reader.getEntries();
    const section = entries.find((entry) => entry.filename === report.sectionPaths[0]);
    if (!section || section.directory || section.uncompressedSize > RESOURCE_LIMITS.maxXmlBytes) invalidOutput();
    const xml = await section.getData(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false, checkCrc32: true });
    const index = indexXml(xml);
    if (index.elements.some((element) => ['linesegarray', 'lineSegArray'].includes(element.local) || ['pic', 'tbl', 'fieldBegin', 'fieldEnd', 'footNote', 'endNote', 'header', 'footer'].includes(element.local))) invalidOutput();
    const pages = index.elements.filter((element) => element.uri === PARAGRAPH_NS && element.local === 'pagePr');
    const margins = index.elements.filter((element) => element.uri === PARAGRAPH_NS && element.local === 'margin' && element.parent?.local === 'pagePr');
    const settings = pages[0];
    const margin = margins[0];
    if (pages.length !== 1 || margins.length !== 1 || !settings || !margin
      || attributeValue(settings, '', 'width') !== String(page.width) || attributeValue(settings, '', 'height') !== String(page.height)) invalidOutput();
    for (const [name, value] of Object.entries(page.margins)) if (attributeValue(margin, '', name) !== String(value)) invalidOutput();
  } finally {
    await reader.close();
  }
  return inspection.paragraphs.length;
}

/** A separate new text draft. Uploaded XML, resources and original bytes are never edited. */
export async function createResearchDraft(input: Uint8Array, inputOptions: unknown): Promise<ResearchDraftResult> {
  if (!isResearchDraftOptions(inputOptions)) throw new EngineError('FILE_INVALID_PACKAGE', 'Invalid draft request.');
  if (input.byteLength > RESOURCE_LIMITS.maxInputBytes) throw new EngineError('RESOURCE_LIMIT', 'Draft source exceeds its limit.');
  // Own both inputs before yielding; callers cannot swap text or roles mid-operation.
  const original = new Uint8Array(input);
  const options = structuredClone(inputOptions);
  try {
    const { inspection } = await inspectHwpx(original, 'source.hwpx');
    validateDraftAssignments(inspection, options);
    const assignments = new Map(options.assignments.map((assignment) => [assignment.paragraphId, assignment]));
    options.assignments = inspection.paragraphs.map((paragraph) => {
      const assignment = assignments.get(paragraph.nodeId);
      if (!assignment) invalidOutput();
      return assignment;
    });
    const page = options.kind === 'competition' ? OFFICIAL_PROFILE.page : PAPER_PAGE;
    const bytes = await makeResearchDraft(options, structuredClone(page));
    if (bytes.byteLength > RESOURCE_LIMITS.maxInputBytes) throw new EngineError('RESOURCE_LIMIT', 'Draft output exceeds its limit.');
    const outputParagraphCount = await verifyDraftOutput(bytes, options, page);
    return { bytes, kind: options.kind, sourceParagraphCount: options.assignments.length, outputParagraphCount,
      packageVerified: true, originalTextVerified: true, manualValidation: 'NOT_RUN' };
  } finally {
    original.fill(0);
  }
}
