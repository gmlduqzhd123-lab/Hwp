import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import { EngineError, ERROR_MESSAGES } from '../../domain/errors';
import { RESOURCE_LIMITS } from '../../domain/limits';
import { isResearchDraftOptions, DRAFT_LIMITS, DRAFT_SOURCE_ID_BASE as SOURCE_DRAFT_PARAGRAPH_ID_BASE, DRAFT_SUPPLEMENT_ID_BASE, type DraftPage, type ResearchDraftOptions } from '../../domain/research';
import { getEffectiveDraftProfile, SCHOOL_LEVEL_LABELS } from '../../domain/competitions';
import type { DraftProfile } from '../../domain/competition-types';
import { elementChildren, indexXml, type XmlIndexedElement } from '../xml/index';
import { createDraftHeader, type DraftStyleName } from './styles';
import { getBlankTemplateBytes } from './template';
import { PAPER_PAGE } from './plan';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const OPF = 'http://www.idpf.org/2007/opf/';
const CONTAINER = 'urn:oasis:names:tc:opendocument:xmlns:container';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function invalid(): never { throw new EngineError('FILE_INVALID_PACKAGE', ERROR_MESSAGES.FILE_INVALID_PACKAGE); }
function limit(): never { throw new EngineError('RESOURCE_LIMIT', ERROR_MESSAGES.RESOURCE_LIMIT); }

/** Validate XML 1.0 characters before creating text or attribute tokens. */
function xmlText(text: string): string {
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (!(point === 9 || point === 10 || point === 13 || point >= 0x20 && point <= 0xd7ff
      || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff)) invalid();
  }
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;').replace(/\r/gu, '&#13;');
}

function textTokens(text: string): string {
  return text.split(/([\t\n])/u).map((part) => part === '\t' ? '<hp:tab/>' : part === '\n' ? '<hp:lineBreak/>' : xmlText(part)).join('');
}

function validatePage(page: DraftPage): void {
  const height = Math.round(page?.fontSizePt * 100);
  if (!page || typeof page.fontFace !== 'string' || !page.fontFace.trim() || page.fontFace.length > 128
    || /[\u0000-\u001f\u007f]/u.test(page.fontFace)
    || !Number.isFinite(page.fontSizePt) || page.fontSizePt < 6 || page.fontSizePt > 72
    || !Number.isSafeInteger(height) || Math.abs(height - page.fontSizePt * 100) > Number.EPSILON * Math.max(1, Math.abs(page.fontSizePt * 100)) * 4
    || !Number.isSafeInteger(page.lineSpacingPercent) || page.lineSpacingPercent < 80 || page.lineSpacingPercent > 300 || !page.margins) invalid();
  xmlText(page.fontFace);
  for (const value of [page.width, page.height]) if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) invalid();
  for (const key of ['top', 'bottom', 'left', 'right', 'header', 'footer', 'gutter'] as const) {
    const value = page.margins[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > Math.max(page.width, page.height)) invalid();
  }
  if (page.margins.left + page.margins.right + page.margins.gutter >= page.width
    || page.margins.top + page.margins.bottom >= page.height) invalid();
  for (const value of [page.indent, page.beforeSpacing, page.afterSpacing]) if (!Number.isSafeInteger(value) || Math.abs(value) > 0x7fffffff) invalid();
  if (page.beforeSpacing < 0 || page.afterSpacing < 0) invalid();
}

/** Only serializes nodes from our pinned public blank, never an uploaded XML. */
function templateElement(element: XmlIndexedElement, replacements: ReadonlyMap<XmlIndexedElement, Readonly<Record<string, string>>>, omitted: ReadonlySet<XmlIndexedElement>): string {
  if (omitted.has(element)) return '';
  const attributes = { ...element.attributes, ...replacements.get(element) };
  const opening = `<${element.qname}${Object.entries(attributes).map(([name, value]) => ` ${name}="${xmlText(value)}"`).join('')}`;
  if (element.children.length === 0) return opening + '/>';
  return opening + '>' + element.children.map((child) => child.kind === 'element'
    ? templateElement(child, replacements, omitted) : xmlText(child.text)).join('') + `</${element.qname}>`;
}

interface Emission { id: number; text: string; style: DraftStyleName; pageBreak: boolean }

function draftParagraphs(options: ResearchDraftOptions, profile: DraftProfile): Emission[] {
  const result: Emission[] = [];
  if (profile.policy === 'guide-only') throw new EngineError('FILE_UNSUPPORTED', 'Unsupported draft profile.');
  if (options.assignments.some((assignment) => !profile.roles.includes(assignment.role)
    || profile.documentType === 'summary' && assignment.role !== 'summary')
    || options.supplements?.some((supplement) => !profile.roles.includes(supplement.role))) invalid();
  const selected = options.summaryParagraphIds === undefined ? null : new Set(options.summaryParagraphIds);
  if (selected && (profile.documentType !== 'summary' || profile.policy === 'format-only'
    || [...selected].some((id) => !options.assignments.some((assignment) => assignment.paragraphId === id)))) invalid();
  if (profile.policy === 'format-only') {
    if (options.supplements?.length) invalid();
    return options.assignments.map((assignment, order) => ({ id: SOURCE_DRAFT_PARAGRAPH_ID_BASE + order,
      text: assignment.sourceText, style: 'body', pageBreak: false }));
  }
  let addedId = 1;
  const add = (text: string, style: DraftStyleName, pageBreak = false) => result.push({ id: addedId++, text, style, pageBreak });
  add(profile.coverHeading, 'cover');
  add(options.title, 'title');
  for (const field of profile.coverFields) {
    const text = field === 'schoolLevel' ? `학교급: ${SCHOOL_LEVEL_LABELS[options.schoolLevel ?? 'elementary']}`
      : field === 'subject' ? `출품교과: ${options.subject}`
      : field === 'researchType' ? `연구형태: ${options.researchType === 'individual' ? '개인연구' : options.researchType === 'joint' ? '공동연구' : ''}`
      : field === 'grade' ? `학년: ${options.grade}` : `학생수: ${options.studentCount}`;
    add(text, 'cover');
    if (profile.id === 'innovation-report' && field === 'subject') add('관리번호: ', 'cover');
  }
  const toc = () => {
    add('목차', 'heading', true);
    for (const item of profile.roles) add(profile.labels[item], 'toc');
  };
  if (profile.includeToc && !profile.roles.includes('summary')) toc();
  for (const role of profile.roles) {
    add(profile.labels[role], 'heading', role === 'appendix' || role === 'need' || role === 'summary' && options.kind === 'competition' && profile.documentType !== 'summary');
    for (const [order, assignment] of options.assignments.entries()) {
      if (assignment.role === role && (!selected || selected.has(assignment.paragraphId))) result.push({ id: SOURCE_DRAFT_PARAGRAPH_ID_BASE + order, text: assignment.sourceText,
        style: role === 'references' ? 'references' : 'body', pageBreak: false });
    }
    for (const [order, supplement] of (options.supplements ?? []).entries()) {
      if (supplement.role === role) result.push({ id: DRAFT_SUPPLEMENT_ID_BASE + order, text: supplement.text,
        style: role === 'references' ? 'references' : 'body', pageBreak: false });
    }
    if (role === 'summary' && profile.includeToc) toc();
  }
  if (addedId >= SOURCE_DRAFT_PARAGRAPH_ID_BASE) invalid();
  return result;
}

function sectionBytes(template: Uint8Array, page: DraftPage, styles: ReturnType<typeof createDraftHeader>['styles'], emissions: readonly Emission[]): Uint8Array<ArrayBuffer> {
  const index = indexXml(template);
  const paragraph = elementChildren(index.root, HP, 'p')[0];
  const run = paragraph && elementChildren(paragraph, HP, 'run')[0];
  const sectionProperties = run && elementChildren(run, HP, 'secPr')[0];
  const paper = sectionProperties && elementChildren(sectionProperties, HP, 'pagePr')[0];
  const margin = paper && elementChildren(paper, HP, 'margin')[0];
  if (!paragraph || !run || !sectionProperties || !paper || !margin) invalid();
  const replacements = new Map<XmlIndexedElement, Record<string, string>>([
    [paragraph, { id: '0', paraPrIDRef: styles.body.paraPrId, styleIDRef: styles.body.styleId }],
    [run, { charPrIDRef: styles.body.charPrId }],
    [paper, { width: String(page.width), height: String(page.height) }],
    [margin, Object.fromEntries(Object.entries(page.margins).map(([name, value]) => [name, String(value)]))],
  ]);
  const omitted = new Set(index.elements.filter((element) => element.uri === HP && element.local === 'linesegarray'));
  const carrier = templateElement(paragraph, replacements, omitted);
  const body = emissions.map((emission) => {
    const style = styles[emission.style] ?? styles.body;
    return `<hp:p id="${emission.id}" paraPrIDRef="${style.paraPrId}" styleIDRef="${style.styleId}" pageBreak="${emission.pageBreak ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="${style.charPrId}"><hp:t>${textTokens(emission.text)}</hp:t></hp:run></hp:p>`;
  }).join('');
  // Retain the complete root opening tag, including all namespace declarations.
  const prefix = decoder.decode(template.subarray(0, paragraph.sourceSpan.startByte));
  const bytes = encoder.encode(prefix + carrier + body + `</${index.root.qname}>`);
  if (bytes.byteLength > RESOURCE_LIMITS.maxXmlBytes) limit();
  return bytes;
}

function metadataBytes(template: Uint8Array, title: string): Uint8Array<ArrayBuffer> {
  const index = indexXml(template);
  const metadata = elementChildren(index.root, OPF, 'metadata')[0];
  const titleElement = metadata && elementChildren(metadata, OPF, 'title')[0];
  if (!titleElement) invalid();
  const edits = [{ element: titleElement, text: `<${titleElement.qname}>${xmlText(title)}</${titleElement.qname}>` }];
  // A new document does not inherit the public template's author or dates.
  const cleared = new Set(['creator', 'lastsaveby', 'CreatedDate', 'ModifiedDate', 'date']);
  for (const element of elementChildren(metadata!, OPF, 'meta')) {
    if (!cleared.has(element.attributes.name ?? '')) continue;
    edits.push({ element, text: `<${element.qname}${Object.entries(element.attributes).map(([name, value]) => ` ${name}="${xmlText(value)}"`).join('')}/>` });
  }
  edits.sort((left, right) => left.element.sourceSpan.startByte - right.element.sourceSpan.startByte);
  let cursor = 0;
  let output = '';
  for (const edit of edits) {
    output += decoder.decode(template.subarray(cursor, edit.element.sourceSpan.startByte)) + edit.text;
    cursor = edit.element.sourceSpan.endByte;
  }
  return encoder.encode(output + decoder.decode(template.subarray(cursor)));
}

function settingsBytes(template: Uint8Array, firstParagraphId: number): Uint8Array<ArrayBuffer> {
  const index = indexXml(template);
  const caret = index.elements.find((element) => element.uri === 'http://www.hancom.co.kr/hwpml/2011/app' && element.local === 'CaretPosition');
  if (!caret) invalid();
  const replacement = templateElement(caret, new Map([[caret, { listIDRef: '0', paraIDRef: String(firstParagraphId), pos: '0' }]]), new Set());
  return encoder.encode(decoder.decode(template.subarray(0, caret.sourceSpan.startByte)) + replacement + decoder.decode(template.subarray(caret.sourceSpan.endByte)));
}

function containerBytes(template: Uint8Array): Uint8Array<ArrayBuffer> {
  const index = indexXml(template);
  const rootfiles = elementChildren(index.root, CONTAINER, 'rootfiles')[0];
  const rootfile = rootfiles && elementChildren(rootfiles, CONTAINER, 'rootfile')[0];
  if (!rootfiles || !rootfile) invalid();
  const prefix = decoder.decode(template.subarray(0, rootfiles.sourceSpan.startByte));
  const suffix = decoder.decode(template.subarray(rootfiles.sourceSpan.endByte));
  return encoder.encode(prefix + `<${rootfiles.qname}><${rootfile.qname} full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><${rootfile.qname} full-path="Preview/PrvText.txt" media-type="text/xml"/></${rootfiles.qname}>` + suffix);
}

/** Shared bounded ZIP assembly uses only the pinned public blank. */
async function buildPackage(emissions: readonly Emission[], page: DraftPage, title: string): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new ZipReader(new Uint8ArrayReader(getBlankTemplateBytes()), { useWebWorkers: false, useCompressionStream: false, checkSignature: true });
  try {
    const entries = await reader.getEntries();
    const parts = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const entry of entries) {
      if (entry.directory || !entry.getData || entry.uncompressedSize > RESOURCE_LIMITS.maxXmlBytes) invalid();
      parts.set(entry.filename, await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false, checkSignature: true }));
    }
    const header = parts.get('Contents/header.xml');
    const section = parts.get('Contents/section0.xml');
    const metadata = parts.get('Contents/content.hpf');
    const container = parts.get('META-INF/container.xml');
    const settings = parts.get('settings.xml');
    if (!header || !section || !metadata || !container || !settings) invalid();
    const formats = createDraftHeader(header, page);
    parts.set('Contents/header.xml', formats.bytes);
    parts.set('Contents/section0.xml', sectionBytes(section, page, formats.styles, emissions));
    parts.set('Contents/content.hpf', metadataBytes(metadata, title));
    parts.set('META-INF/container.xml', containerBytes(container));
    parts.set('settings.xml', settingsBytes(settings, emissions[0]?.id ?? 0));
    parts.delete('Preview/PrvImage.png');
    parts.set('Preview/PrvText.txt', encoder.encode(emissions.map((emission) => emission.text).join('\n')));
    let retainedNodes = 0;
    let textBytes = 0;
    for (const [path, bytes] of parts) {
      if (!/\.(?:xml|hpf)$/iu.test(path)) continue;
      const index = indexXml(bytes);
      retainedNodes += index.elements.length;
      for (const element of index.elements) {
        for (const child of element.children) {
          if (child.kind === 'element') continue;
          retainedNodes += 1;
          textBytes += encoder.encode(child.text).byteLength;
        }
      }
      if (retainedNodes > RESOURCE_LIMITS.maxXmlElements || textBytes > RESOURCE_LIMITS.maxXmlTextLength) limit();
    }
    // The sink bounds final output independently of compressed size estimates.
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    let exceeded = false;
    const stream = new WritableStream<Uint8Array>({ write(chunk) {
      size += chunk.byteLength;
      if (size > RESOURCE_LIMITS.maxInputBytes) { exceeded = true; limit(); }
      chunks.push(new Uint8Array(chunk));
    } });
    const writer = new ZipWriter(stream, { zip64: false, dataDescriptor: false, extendedTimestamp: false, useWebWorkers: false, useCompressionStream: false });
    const entryMap = new Map(entries.map((entry) => [entry.filename, entry]));
    try {
      const names = ['mimetype', ...parts.keys()].filter((name, order, array) => array.indexOf(name) === order);
      for (const name of names) {
        const bytes = parts.get(name);
        if (!bytes) invalid();
        await writer.add(name, new Uint8ArrayReader(bytes), {
          level: name === 'mimetype' ? 0 : 6, entry: entryMap.get(name),
          lastModDate: entryMap.get(name)?.lastModDate ?? new Date(2000, 0, 1),
          useWebWorkers: false, useCompressionStream: false, extendedTimestamp: false,
        });
      }
      await writer.close();
    } catch (error) {
      if (exceeded) limit();
      throw error;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return invalid();
  } finally { await reader.close(); }
}

/** Build a separate draft locally. Uploaded XML and original package bytes are never modified. */
export async function makeResearchDraft(input: ResearchDraftOptions, inputPage: DraftPage): Promise<Uint8Array<ArrayBuffer>> {
  if (!isResearchDraftOptions(input)) invalid();
  validatePage(inputPage);
  // Own every caller value before the first async ZIP operation.
  const options = structuredClone(input);
  const page = structuredClone(inputPage);
  const profile = getEffectiveDraftProfile(options);
  return buildPackage(draftParagraphs(options, profile), page, options.title);
}

/** New source from explicitly entered text, never an extraction from an uploaded file. */
export async function makePlainTextSource(text: string): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof text !== 'string' || !text.trim()) invalid();
  if (text.length > DRAFT_LIMITS.maxTextCharacters) limit();
  const lines = text.split('\n');
  // The public blank contributes one empty section-properties carrier paragraph.
  if (lines.length >= DRAFT_LIMITS.maxParagraphs) limit();
  xmlText(text);
  const page = structuredClone(PAPER_PAGE);
  validatePage(page);
  return buildPackage(lines.map((line, ordinal) => ({ id: SOURCE_DRAFT_PARAGRAPH_ID_BASE + ordinal,
    text: line, style: 'body', pageBreak: false })), page, '직접 입력한 원고');
}
