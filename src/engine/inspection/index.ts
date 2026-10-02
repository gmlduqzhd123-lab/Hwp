import type {
  DocumentInspection, InspectionParagraph, InspectionReason, InspectionRun,
  InspectionTextSegment, ParagraphContext, SourceSpan,
} from '../../domain/document';
import { INSPECTION_MAX_ENTRY_PATH_LENGTH } from '../../domain/document';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../domain/limits';
import { invalidPackage, resourceLimit } from '../package/errors';
import { validateLimits } from '../package/metadata';
import { assertSafePath } from '../package/paths';
import { elementChildren, type XmlIndex, type XmlIndexedElement } from '../xml/index';
import { createFormatResolver } from './formats';
import { ancestor, createNodeCatalog, INSPECTION_NAMESPACES as NS, isElement, type NodeCatalog, uniqueReasons } from './nodes';
import { inspectTables } from './tables';

export interface InspectionXmlPart { path: string; index: XmlIndex }
export interface InspectionParts { header: InspectionXmlPart; sections: InspectionXmlPart[] }
const KNOWN_NAMESPACES = new Set<string>(Object.values(NS));

function paragraphContext(element: XmlIndexedElement, hasCell: boolean): ParagraphContext {
  for (let current = element.parent; current; current = current.parent) {
    if (current.uri !== NS.paragraph && current.uri !== NS.section) return 'UNKNOWN';
    if (current.uri === NS.paragraph) {
      if (current.local === 'header') return 'HEADER';
      if (current.local === 'footer') return 'FOOTER';
      if (['footNote', 'endNote', 'comment', 'hiddenComment'].includes(current.local)) return 'NOTE';
    }
  }
  if (hasCell) return 'TABLE_CELL';
  return element.parent && isElement(element.parent, NS.section, 'sec') ? 'BODY' : 'UNKNOWN';
}

function fieldParagraphs(index: XmlIndex): Set<XmlIndexedElement> {
  const affected = new Set<XmlIndexedElement>();
  const active: (string | null)[] = [];
  for (const element of index.elements) {
    if (isElement(element, NS.paragraph, 'p') && active.length > 0) affected.add(element);
    if (element.uri !== NS.paragraph || !['fieldBegin', 'fieldEnd'].includes(element.local)) continue;
    const paragraph = ancestor(element, (candidate) => isElement(candidate, NS.paragraph, 'p'));
    if (paragraph) affected.add(paragraph);
    if (element.local === 'fieldBegin') active.push(element.attributes.id ?? null);
    else if (active.at(-1) !== null && active.at(-1) === element.attributes.beginIDRef) active.pop();
  }
  return affected;
}

function inspectRunText(element: XmlIndexedElement, nodes: NodeCatalog): { segments: InspectionTextSegment[]; reasons: InspectionReason[] } {
  const segments: InspectionTextSegment[] = [];
  const reasons: InspectionReason[] = [];
  for (const child of element.children) {
    if (child.kind !== 'element') {
      if (child.text.trim()) {
        segments.push({ kind: child.kind === 'cdata' ? 'CDATA' : 'TEXT', text: child.text, elementName: null, sourceSpan: nodes.sourceSpan(child) });
        reasons.push('UNSUPPORTED_CONTROL');
      }
      continue;
    }
    if (!isElement(child, NS.paragraph, 't')) {
      reasons.push(child.uri === NS.paragraph ? 'NON_TEXT_OBJECT' : 'UNKNOWN_NAMESPACE');
      segments.push({ kind: 'UNKNOWN_CONTROL', text: '', elementName: `${nodes.namespaceLabel(child.uri)}:${child.local.length <= 32 ? child.local : 'element'}`, sourceSpan: nodes.sourceSpan(child) });
      continue;
    }
    for (const textChild of child.children) {
      if (textChild.kind !== 'element') {
        segments.push({ kind: textChild.kind === 'cdata' ? 'CDATA' : 'TEXT', text: textChild.text, elementName: null, sourceSpan: nodes.sourceSpan(textChild) });
      } else if (textChild.uri === NS.paragraph && ['tab', 'lineBreak'].includes(textChild.local) && textChild.children.length === 0) {
        segments.push({ kind: textChild.local === 'tab' ? 'TAB' : 'LINE_BREAK', text: textChild.local === 'tab' ? '\t' : '\n', elementName: textChild.local, sourceSpan: nodes.sourceSpan(textChild) });
      } else {
        reasons.push(textChild.uri === NS.paragraph ? 'UNSUPPORTED_CONTROL' : 'UNKNOWN_NAMESPACE');
        segments.push({ kind: 'UNKNOWN_CONTROL', text: '', elementName: `${nodes.namespaceLabel(textChild.uri)}:${textChild.local.length <= 32 ? textChild.local : 'element'}`, sourceSpan: nodes.sourceSpan(textChild) });
      }
    }
  }
  return { segments, reasons: uniqueReasons(reasons) };
}

function checkParts(parts: InspectionParts, limits: Readonly<ResourceLimits>): void {
  const paths = new Set<string>();
  let elements = 0;
  let textNodes = 0;
  let textBytes = 0;
  const encoder = new TextEncoder();
  for (const part of [parts.header, ...parts.sections]) {
    if (part.path.length > INSPECTION_MAX_ENTRY_PATH_LENGTH) resourceLimit();
    assertSafePath(part.path, false);
    if (paths.has(part.path)) invalidPackage();
    paths.add(part.path);
    elements += part.index.elements.length;
    for (const element of part.index.elements) {
      for (const child of element.children) {
        if (child.kind === 'element') continue;
        textNodes += 1;
        textBytes += encoder.encode(child.text).byteLength;
      }
    }
    if (elements + textNodes > limits.maxXmlElements || textBytes > limits.maxXmlTextLength) resourceLimit();
  }
  if (!isElement(parts.header.index.root, NS.head, 'head') || parts.sections.length === 0
    || parts.sections.some((part) => !isElement(part.index.root, NS.section, 'sec'))) invalidPackage();
}

/** Consume the already-safe package parts in declared spine order. Never writes XML. */
export function inspectDocument(parts: InspectionParts, limits: Readonly<ResourceLimits> = RESOURCE_LIMITS): DocumentInspection {
  validateLimits(limits);
  checkParts(parts, limits);
  const formats = createFormatResolver(parts.header);
  const result: DocumentInspection = {
    supportLevel: 'INSPECT_ONLY', editingEnabled: false,
    sections: [], paragraphs: [], runs: [], tables: [], rows: [], cells: [],
    formats: formats.catalog,
    summary: { sectionCount: parts.sections.length, paragraphCount: 0, runCount: 0, tableCount: 0, cellCount: 0, correctionCandidateParagraphCount: 0 },
  };
  for (const [order, part] of parts.sections.entries()) {
    const nodes = createNodeCatalog(part.path, part.index);
    const rootIdentity = nodes.identity(part.index.root);
    const section = { ...rootIdentity, entryPath: part.path, order, paragraphIds: [] as string[], tableIds: [] as string[] };
    const tableCatalog = inspectTables(part.index, nodes, section.nodeId);
    result.sections.push(section);
    result.tables.push(...tableCatalog.tables);
    result.rows.push(...tableCatalog.rows);
    result.cells.push(...tableCatalog.cells);
    section.tableIds = tableCatalog.tables.map((table) => table.nodeId);
    const affectedByField = fieldParagraphs(part.index);
    const ownParagraphsById = new Map<string, InspectionParagraph>();
    const ownRunsById = new Map<string, InspectionRun>();
    for (const element of part.index.elements) {
      if (!KNOWN_NAMESPACES.has(element.uri)) section.reasons.push('UNKNOWN_NAMESPACE');
      if (!isElement(element, NS.paragraph, 'p')) continue;
      const identity = nodes.identity(element);
      const cellElement = ancestor(element, (candidate) => tableCatalog.cellsByElement.has(candidate));
      const cell = cellElement ? tableCatalog.cellsByElement.get(cellElement) : undefined;
      const context = paragraphContext(element, Boolean(cell));
      const paragraphFormat = formats.resolveParagraph(element, identity.sourceSpan);
      const styleReference = formats.resolveStyle(element, identity.sourceSpan);
      const paragraph: InspectionParagraph = {
        ...identity, sectionId: section.nodeId, context, parentCellId: cell?.nodeId ?? null,
        runIds: [], text: '', styleReference, paragraphFormat,
      };
      if (context === 'HEADER' || context === 'FOOTER') paragraph.reasons.push('HEADER_FOOTER');
      if (context === 'NOTE') paragraph.reasons.push('NOTE_CONTEXT');
      if (context === 'UNKNOWN') paragraph.reasons.push('UNSUPPORTED_CONTEXT');
      if (affectedByField.has(element)) paragraph.reasons.push('FIELD_CONTROL');
      if (cell) paragraph.reasons.push(...cell.reasons);
      for (const candidate of elementChildren(element)) {
        if (isElement(candidate, NS.paragraph, 'run')) continue;
        if (candidate.uri === NS.paragraph && ['linesegarray', 'lineSegArray'].includes(candidate.local)) continue;
        paragraph.reasons.push(candidate.uri === NS.paragraph ? 'UNKNOWN_ELEMENT' : 'UNKNOWN_NAMESPACE');
      }
      for (const runElement of elementChildren(element, NS.paragraph, 'run')) {
        const runIdentity = nodes.identity(runElement);
        const text = inspectRunText(runElement, nodes);
        const characterFormat = formats.resolveCharacter(runElement, runIdentity.sourceSpan);
        const run: InspectionRun = {
          ...runIdentity, paragraphId: paragraph.nodeId,
          text: text.segments.map((segment) => segment.text).join(''), segments: text.segments,
          characterFormat, reasons: uniqueReasons([...text.reasons, ...characterFormat.reasons, ...characterFormat.reference.reasons]),
        };
        if (characterFormat.superscript || characterFormat.subscript) run.reasons.push('SUPERSCRIPT_OR_SUBSCRIPT');
        paragraph.runIds.push(run.nodeId);
        paragraph.text += run.text;
        paragraph.reasons.push(...run.reasons);
        ownRunsById.set(run.nodeId, run);
        result.runs.push(run);
      }
      paragraph.reasons = uniqueReasons([...paragraph.reasons, ...paragraphFormat.reasons, ...paragraphFormat.reference.reasons, ...styleReference.reasons]);
      paragraph.correctionCandidate = paragraph.reasons.length === 0 && paragraph.runIds.length > 0;
      for (const id of paragraph.runIds) {
        const run = ownRunsById.get(id);
        if (run) { run.reasons = uniqueReasons([...run.reasons, ...paragraph.reasons]); run.correctionCandidate = paragraph.correctionCandidate; }
      }
      if (cell) cell.paragraphIds.push(paragraph.nodeId);
      const nearestTable = ancestor(element, (candidate) => tableCatalog.tablesByElement.has(candidate));
      if (nearestTable) tableCatalog.tablesByElement.get(nearestTable)?.paragraphIds.push(paragraph.nodeId);
      section.paragraphIds.push(paragraph.nodeId);
      ownParagraphsById.set(paragraph.nodeId, paragraph);
      result.paragraphs.push(paragraph);
    }
    for (const cell of tableCatalog.cells) {
      const paragraphs = cell.paragraphIds.map((id) => ownParagraphsById.get(id)).filter((paragraph): paragraph is InspectionParagraph => paragraph !== undefined);
      cell.text = paragraphs.map((paragraph) => paragraph.text).join('\n');
      cell.reasons = uniqueReasons([...cell.reasons, ...paragraphs.flatMap((paragraph) => paragraph.reasons)]);
      cell.correctionCandidate = cell.reasons.length === 0 && paragraphs.length > 0 && paragraphs.every((paragraph) => paragraph.correctionCandidate);
    }
    const cellsById = new Map(tableCatalog.cells.map((cell) => [cell.nodeId, cell]));
    for (const table of tableCatalog.tables) table.correctionCandidate = table.reasons.length === 0 && table.cellIds.length > 0 && table.cellIds.every((id) => cellsById.get(id)?.correctionCandidate);
    for (const row of tableCatalog.rows) row.correctionCandidate = row.reasons.length === 0 && row.cellIds.length > 0 && row.cellIds.every((id) => cellsById.get(id)?.correctionCandidate);
    section.reasons = uniqueReasons(section.reasons);
  }
  result.summary.paragraphCount = result.paragraphs.length;
  result.summary.runCount = result.runs.length;
  result.summary.tableCount = result.tables.length;
  result.summary.cellCount = result.cells.length;
  result.summary.correctionCandidateParagraphCount = result.paragraphs.filter((paragraph) => paragraph.correctionCandidate).length;
  return result;
}

export type { SourceSpan };
