import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/lib/zip-core-native.js';
import { FONT_LANGUAGES } from '../domain/document';
import { EngineError, ERROR_MESSAGES } from '../domain/errors';
import { RESOURCE_LIMITS } from '../domain/limits';
import { DRAFT_LIMITS, DRAFT_SOURCE_ID_BASE } from '../domain/research';
import { makePlainTextSource } from './draft/writer';
import { inspectHwpx } from './preflight';
import { attributeValue, elementChildren, indexXml } from './xml/index';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';

function invalid(): never {
  throw new EngineError('FILE_INVALID_PACKAGE', ERROR_MESSAGES.FILE_INVALID_PACKAGE);
}

/**
 * Build a new, local source from text the user deliberately entered. This never
 * reads, extracts, changes or carries objects from an uploaded original.
 */
export async function createPlainTextSource(input: unknown): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof input !== 'string' || !input.trim()) invalid();
  if (input.length > DRAFT_LIMITS.maxTextCharacters) throw new EngineError('RESOURCE_LIMIT', ERROR_MESSAGES.RESOURCE_LIMIT);
  // Strings are immutable; capture the exact input before the first async step.
  const text = input;
  const lines = text.split('\n');
  if (lines.length >= DRAFT_LIMITS.maxParagraphs) throw new EngineError('RESOURCE_LIMIT', ERROR_MESSAGES.RESOURCE_LIMIT);
  const bytes = await makePlainTextSource(text);
  if (!bytes.byteLength || bytes.byteLength > RESOURCE_LIMITS.maxInputBytes) throw new EngineError('RESOURCE_LIMIT', ERROR_MESSAGES.RESOURCE_LIMIT);

  // Reopen the actual ZIP through the independent package/inspection path.
  const { report, inspection } = await inspectHwpx(bytes, 'entered-text.hwpx');
  if (report.sectionPaths.length !== 1 || inspection.sections.length !== 1
    || inspection.paragraphs.length !== lines.length + 1 || inspection.runs.length !== lines.length + 1
    || inspection.tables.length || inspection.rows.length || inspection.cells.length) invalid();
  const runs = new Map(inspection.runs.map((run) => [run.nodeId, run]));
  for (const [ordinal, paragraph] of inspection.paragraphs.entries()) {
    const expectedId = ordinal === 0 ? 0 : DRAFT_SOURCE_ID_BASE + ordinal - 1;
    const expectedText = ordinal === 0 ? '' : lines[ordinal - 1];
    if (paragraph.sourceId !== String(expectedId) || paragraph.text !== expectedText || paragraph.context !== 'BODY'
      || paragraph.runIds.length !== 1 || !paragraph.styleReference.resolved
      || !paragraph.paragraphFormat.reference.resolved || paragraph.paragraphFormat.lineSpacing.value !== 160
      || paragraph.paragraphFormat.lineSpacingType.value !== 'PERCENT') invalid();
    const run = runs.get(paragraph.runIds[0]!);
    if (!run || !run.characterFormat.reference.resolved || run.characterFormat.fontSize.value !== 12
      || run.characterFormat.superscript || run.characterFormat.subscript
      || FONT_LANGUAGES.some((language) => run.characterFormat.fonts[language].value !== '함초롬바탕')
      || run.segments.some((segment) => segment.kind === 'UNKNOWN_CONTROL' && (ordinal !== 0 || !segment.layoutControl))) invalid();
  }
  if (inspection.paragraphs.slice(1).map((paragraph) => paragraph.text).join('\n') !== text) invalid();

  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, useCompressionStream: false, checkSignature: true });
  try {
    const entries = await reader.getEntries();
    const section = entries.find((entry) => entry.filename === report.sectionPaths[0]);
    if (!section || section.directory || section.uncompressedSize > RESOURCE_LIMITS.maxXmlBytes
      || entries.some((entry) => /^(?:BinData|Scripts)\//iu.test(entry.filename) || entry.filename === 'Preview/PrvImage.png')) invalid();
    const index = indexXml(await section.getData(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false, checkSignature: true }));
    if (index.elements.some((element) => ['linesegarray', 'lineSegArray', 'tbl', 'pic', 'fieldBegin', 'fieldEnd',
      'footNote', 'endNote', 'header', 'footer', 'equation', 'ole', 'chart', 'video'].includes(element.local))) invalid();
    const paragraphs = elementChildren(index.root, HP, 'p');
    if (paragraphs.length !== lines.length + 1) invalid();
    for (const [ordinal, paragraph] of paragraphs.entries()) {
      if (attributeValue(paragraph, '', 'id') !== String(ordinal === 0 ? 0 : DRAFT_SOURCE_ID_BASE + ordinal - 1)
        || ordinal !== 0 && attributeValue(paragraph, '', 'pageBreak') !== '0') invalid();
    }
  } finally { await reader.close(); }
  return bytes;
}
