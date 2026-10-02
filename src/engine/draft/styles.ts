import { FONT_LANGUAGES } from '../../domain/document';
import { EngineError, ERROR_MESSAGES } from '../../domain/errors';
import type { DraftPage } from '../../domain/research';
import { INSPECTION_NAMESPACES as NS } from '../inspection/nodes';
import { attributeValue, elementChildren, indexXml, type XmlIndexedElement } from '../xml/index';

export type DraftStyleRole = 'body' | 'title' | 'heading' | 'cover' | 'toc';
export type DraftStyleName = DraftStyleRole | 'references';
export interface DraftStyleIds { charPrId: string; paraPrId: string; styleId: string }
export type DraftStyles = Record<DraftStyleRole, DraftStyleIds> & { references?: DraftStyleIds };
const ROLES: readonly DraftStyleRole[] = ['body', 'title', 'heading', 'cover', 'toc'];
const FONT_SIZE_ROLES = ['title', 'heading', 'cover', 'toc', 'references'] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
interface Patch { start: number; end: number; text: string }

function invalid(): never { throw new EngineError('FILE_INVALID_PACKAGE', ERROR_MESSAGES.FILE_INVALID_PACKAGE); }
function attribute(node: XmlIndexedElement, name: string): string { return attributeValue(node, '', name) ?? invalid(); }
function integer(raw: string): number {
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed <= 0xffffffff ? parsed : invalid();
}
function fontHeight(points: number): number {
  const height = Math.round(points * 100);
  // Decimal hundredths can carry binary floating-point noise (11.23 * 100).
  return Math.abs(height - points * 100) <= Number.EPSILON * Math.max(1, Math.abs(points * 100)) * 4 ? height : invalid();
}
function only(nodes: readonly XmlIndexedElement[]): XmlIndexedElement { return nodes.length === 1 && nodes[0] ? nodes[0] : invalid(); }
function child(parent: XmlIndexedElement, uri: string, local: string): XmlIndexedElement { return only(elementChildren(parent, uri, local)); }
function escapeAttribute(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

/** These byte edits apply only to our pinned, public blank template. */
function apply(bytes: Uint8Array, edits: readonly Patch[]): Uint8Array<ArrayBuffer> {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let size = bytes.byteLength;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)
      || edit.start < cursor || edit.end < edit.start || edit.end > bytes.byteLength) invalid();
    const replacement = encoder.encode(edit.text);
    parts.push(bytes.subarray(cursor, edit.start), replacement);
    size += replacement.byteLength - (edit.end - edit.start);
    cursor = edit.end;
  }
  parts.push(bytes.subarray(cursor));
  const result = new Uint8Array(size);
  cursor = 0;
  for (const part of parts) { result.set(part, cursor); cursor += part.byteLength; }
  return result;
}

/** Read quoted attributes lexically so text inside another value cannot match. */
function attributePatch(bytes: Uint8Array, node: XmlIndexedElement, name: string, replacement: string): Patch {
  attribute(node, name);
  const source = decoder.decode(bytes.subarray(node.sourceSpan.startByte, node.sourceSpan.endByte));
  let position = source.indexOf('<') + 1;
  while (position < source.length && !/[\s/>]/u.test(source[position]!)) position += 1;
  while (position < source.length) {
    while (/\s/u.test(source[position] ?? '')) position += 1;
    if (source[position] === '/' || source[position] === '>') break;
    const start = position;
    while (position < source.length && !/[\s=]/u.test(source[position]!)) position += 1;
    const qname = source.slice(start, position);
    while (/\s/u.test(source[position] ?? '')) position += 1;
    if (source[position++] !== '=') invalid();
    while (/\s/u.test(source[position] ?? '')) position += 1;
    const quote = source[position++];
    if (quote !== '"' && quote !== "'") invalid();
    const valueStart = position;
    const valueEnd = source.indexOf(quote, position);
    if (valueEnd === -1) invalid();
    position = valueEnd + 1;
    if (qname !== name) continue;
    return {
      start: node.sourceSpan.startByte + encoder.encode(source.slice(0, valueStart)).byteLength,
      end: node.sourceSpan.startByte + encoder.encode(source.slice(0, valueEnd)).byteLength,
      text: escapeAttribute(replacement),
    };
  }
  return invalid();
}

function insertBeforeClose(bytes: Uint8Array, node: XmlIndexedElement, text: string): Patch {
  const source = decoder.decode(bytes.subarray(node.sourceSpan.startByte, node.sourceSpan.endByte));
  const close = source.lastIndexOf(`</${node.qname}`);
  if (close < 0) invalid();
  const start = node.sourceSpan.startByte + encoder.encode(source.slice(0, close)).byteLength;
  return { start, end: start, text };
}

function fragment(bytes: Uint8Array, node: XmlIndexedElement, edits: readonly Patch[] = []): string {
  return decoder.decode(apply(bytes.subarray(node.sourceSpan.startByte, node.sourceSpan.endByte), edits.map((edit) => ({
    ...edit, start: edit.start - node.sourceSpan.startByte, end: edit.end - node.sourceSpan.startByte,
  }))));
}

function definition(container: XmlIndexedElement, local: string, id: number): XmlIndexedElement {
  return only(elementChildren(container, NS.head, local).filter((node) => integer(attribute(node, 'id')) === id));
}

function allocate(container: XmlIndexedElement, local: string, count: number): number {
  const children = elementChildren(container, NS.head, local);
  if (integer(attribute(container, 'itemCnt')) !== children.length) invalid();
  const ids = children.map((node) => integer(attribute(node, 'id')));
  if (new Set(ids).size !== ids.length) invalid();
  const next = Math.max(-1, ...ids) + 1;
  return next + count - 1 <= 0xffffffff ? next : invalid();
}

/**
 * Build new definitions in a public blank; never patch an uploaded document.
 * Original definition bytes stay intact. New role definitions copy every
 * non-target attribute and child, including emphasis, colors and borders.
 */
export function createDraftHeader(headerBytes: Uint8Array, page: DraftPage): {
  bytes: Uint8Array<ArrayBuffer>;
  styles: DraftStyles;
} {
  if (typeof page.fontFace !== 'string' || !page.fontFace.trim() || page.fontFace.length > 128
    || !Number.isFinite(page.fontSizePt) || page.fontSizePt < 6 || page.fontSizePt > 72
    || !Number.isInteger(page.lineSpacingPercent) || page.lineSpacingPercent < 80 || page.lineSpacingPercent > 300
    || ![page.indent, page.beforeSpacing, page.afterSpacing].every((number) => Number.isSafeInteger(number) && Math.abs(number) <= 0x7fffffff)
    || page.beforeSpacing < 0 || page.afterSpacing < 0) invalid();
  fontHeight(page.fontSizePt);
  if (page.fontSizes !== undefined) {
    if (typeof page.fontSizes !== 'object' || page.fontSizes === null || Array.isArray(page.fontSizes)) invalid();
    for (const [role, points] of Object.entries(page.fontSizes)) {
      if (!(FONT_SIZE_ROLES as readonly string[]).includes(role)) invalid();
      if (points === undefined) continue;
      if (typeof points !== 'number' || !Number.isFinite(points) || points < 6 || points > 72) invalid();
      fontHeight(points);
    }
  }
  const override = (role: Exclude<DraftStyleName, 'body'>): number | undefined =>
    page.fontSizes && Object.hasOwn(page.fontSizes, role) ? page.fontSizes[role] : undefined;
  const roles: readonly DraftStyleName[] = override('references') === undefined ? ROLES : [...ROLES, 'references'];
  const bytes = new Uint8Array(headerBytes);
  const index = indexXml(bytes);
  if (index.root.uri !== NS.head || index.root.local !== 'head') invalid();
  const refList = child(index.root, NS.head, 'refList');
  const characters = child(refList, NS.head, 'charProperties');
  const paragraphs = child(refList, NS.head, 'paraProperties');
  const styleDefinitions = child(refList, NS.head, 'styles');
  const charBase = definition(characters, 'charPr', 0);
  const paraBase = definition(paragraphs, 'paraPr', 3);
  const styleBase = definition(styleDefinitions, 'style', 0);
  const fontRef = child(charBase, NS.head, 'fontRef');
  const align = child(paraBase, NS.head, 'align');
  const branch = child(paraBase, NS.paragraph, 'switch');
  const fallback = child(branch, NS.paragraph, 'default');
  const margin = child(fallback, NS.head, 'margin');
  const lineSpacing = child(fallback, NS.head, 'lineSpacing');
  if (elementChildren(fallback).length !== 2) invalid();
  for (const name of ['intent', 'left', 'right', 'prev', 'next']) {
    if (attribute(child(margin, NS.core, name), 'unit') !== 'HWPUNIT') invalid();
  }
  if (attribute(lineSpacing, 'unit') !== 'HWPUNIT') invalid();
  const nextChar = allocate(characters, 'charPr', roles.length);
  const nextPara = allocate(paragraphs, 'paraPr', roles.length);
  const nextStyle = allocate(styleDefinitions, 'style', roles.length);
  const styles = Object.fromEntries(roles.map((role, order) => [role, {
    charPrId: String(nextChar + order), paraPrId: String(nextPara + order), styleId: String(nextStyle + order),
  }])) as DraftStyles;
  const edits: Patch[] = [];
  const fontfaces = child(refList, NS.head, 'fontfaces');
  const faces = elementChildren(fontfaces, NS.head, 'fontface');
  if (faces.length !== FONT_LANGUAGES.length || integer(attribute(fontfaces, 'itemCnt')) !== faces.length) invalid();
  for (const language of FONT_LANGUAGES) {
    const face = only(faces.filter((node) => attribute(node, 'lang') === language));
    const fonts = elementChildren(face, NS.head, 'font');
    if (integer(attribute(face, 'fontCnt')) !== fonts.length || fonts.some((font) => integer(attribute(font, 'id')) === 2)) invalid();
    const font = fonts[0] ?? invalid();
    const prefix = font.qname.includes(':') ? font.qname.split(':')[0] : null;
    const namespace = prefix ? `xmlns:${prefix}` : 'xmlns';
    // typeInfo is optional in the public font model. Omit PANOSE properties
    // rather than infer the requested face's metrics from a different font.
    const added = `<${font.qname} ${namespace}="${NS.head}" id="2" face="${escapeAttribute(page.fontFace)}" type="TTF" isEmbedded="0"/>`;
    edits.push(attributePatch(bytes, face, 'fontCnt', String(fonts.length + 1)), insertBeforeClose(bytes, face, added));
  }

  const chars: string[] = [];
  const paras: string[] = [];
  const styleXml: string[] = [];
  for (const role of roles) {
    const ids = styles[role] ?? invalid();
    const bodyParagraph = role === 'body' || role === 'references';
    const defaultSize = role === 'body' || role === 'heading' || role === 'references' ? page.fontSizePt : role === 'title' ? 16 : 12;
    const size = role === 'body' ? defaultSize : override(role) ?? defaultSize;
    const charEdits = [attributePatch(bytes, charBase, 'id', ids.charPrId), attributePatch(bytes, charBase, 'height', String(fontHeight(size))),
      ...FONT_LANGUAGES.map((language) => attributePatch(bytes, fontRef, language.toLowerCase(), '2'))];
    if ((role === 'title' || role === 'heading') && elementChildren(charBase, NS.head, 'bold').length === 0) {
      const prefix = charBase.qname.includes(':') ? `${charBase.qname.split(':')[0]}:` : '';
      charEdits.push(insertBeforeClose(bytes, charBase, `<${prefix}bold/>`));
    }
    chars.push(fragment(bytes, charBase, charEdits));
    const marginEdits = [attributePatch(bytes, child(margin, NS.core, 'intent'), 'value', String(bodyParagraph ? page.indent : 0)),
      attributePatch(bytes, child(margin, NS.core, 'prev'), 'value', String(page.beforeSpacing)),
      attributePatch(bytes, child(margin, NS.core, 'next'), 'value', String(page.afterSpacing))];
    const flattened = fragment(bytes, margin, marginEdits) + fragment(bytes, lineSpacing, [
      attributePatch(bytes, lineSpacing, 'type', 'PERCENT'), attributePatch(bytes, lineSpacing, 'value', String(page.lineSpacingPercent)),
    ]);
    paras.push(fragment(bytes, paraBase, [attributePatch(bytes, paraBase, 'id', ids.paraPrId),
      attributePatch(bytes, align, 'horizontal', bodyParagraph ? 'JUSTIFY' : role === 'title' ? 'CENTER' : 'LEFT'),
      { start: branch.sourceSpan.startByte, end: branch.sourceSpan.endByte, text: flattened }]));
    styleXml.push(fragment(bytes, styleBase, [attributePatch(bytes, styleBase, 'id', ids.styleId),
      attributePatch(bytes, styleBase, 'name', `연구 초안 ${role}`), attributePatch(bytes, styleBase, 'engName', `ResearchDraft-${role}`),
      attributePatch(bytes, styleBase, 'charPrIDRef', ids.charPrId), attributePatch(bytes, styleBase, 'paraPrIDRef', ids.paraPrId),
      attributePatch(bytes, styleBase, 'nextStyleIDRef', styles.body.styleId)]));
  }
  for (const [container, extra] of [[characters, chars], [paragraphs, paras], [styleDefinitions, styleXml]] as const) {
    edits.push(attributePatch(bytes, container, 'itemCnt', String(integer(attribute(container, 'itemCnt')) + roles.length)),
      insertBeforeClose(bytes, container, extra.join('')));
  }
  const result = apply(bytes, edits);
  indexXml(result);
  return { bytes: result, styles };
}
