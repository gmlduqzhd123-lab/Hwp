import { SaxesParser } from 'saxes';
import { EngineError, ERROR_MESSAGES } from '../../domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../domain/limits';
import { validateXml } from './validate';

/** Half-open positions in the original UTF-8 entry, including an initial BOM. */
export interface XmlByteSpan {
  readonly startByte: number;
  readonly endByte: number;
}

export interface XmlIndexAttribute {
  readonly qname: string;
  readonly local: string;
  readonly uri: string;
  readonly value: string;
}

export interface XmlIndexedElement {
  readonly kind: 'element';
  readonly qname: string;
  readonly local: string;
  readonly uri: string;
  /** Same keys as validateXml: plain local names, qualified original QNames. */
  readonly attributes: Readonly<Record<string, string>>;
  /** Expanded names allow callers to distinguish qualified attributes safely. */
  readonly attributeList: readonly XmlIndexAttribute[];
  readonly parent: XmlIndexedElement | null;
  /** Source order; comments and declarations are intentionally omitted. */
  readonly children: readonly XmlIndexNode[];
  /** Whole element, from the opening '<' through the closing '>'. */
  readonly sourceSpan: XmlByteSpan;
}

export interface XmlIndexText {
  readonly kind: 'text' | 'cdata';
  /** XML-decoded plain text, with XML 1.0 line-ending normalization. */
  readonly text: string;
  /** Original token: entities remain encoded; CDATA includes its delimiters. */
  readonly sourceSpan: XmlByteSpan;
}

export type XmlIndexNode = XmlIndexedElement | XmlIndexText;

export interface XmlIndex {
  readonly root: XmlIndexedElement;
  /** Elements in document order. Original XML strings/bytes are not retained. */
  readonly elements: readonly XmlIndexedElement[];
}

interface MutableElement extends Omit<XmlIndexedElement, 'children' | 'sourceSpan'> {
  children: XmlIndexNode[];
  sourceSpan: { startByte: number; endByte: number };
}

interface Token {
  kind: 'open' | 'close' | 'text' | 'cdata' | 'comment' | 'declaration';
  start: number;
  end: number;
}

function invalid(): never {
  throw new EngineError('FILE_INVALID_PACKAGE', ERROR_MESSAGES.FILE_INVALID_PACKAGE);
}

/**
 * Locate raw tokens only after validateXml has accepted the grammar. Saxes still
 * provides all decoded values and namespace identities. The lexer neither
 * decodes entities nor reconstructs XML, and never retains a token array.
 */
function tokenReader(source: string): () => Token {
  let position = source.startsWith('\ufeff') ? 1 : 0;
  return () => {
    const start = position;
    if (start >= source.length) invalid();
    if (source[start] !== '<') {
      const next = source.indexOf('<', start);
      position = next === -1 ? source.length : next;
      return { kind: 'text', start, end: position };
    }
    for (const [prefix, delimiter, kind] of [
      ['<!--', '-->', 'comment'],
      ['<![CDATA[', ']]>', 'cdata'],
      ['<?', '?>', 'declaration'],
    ] as const) {
      if (!source.startsWith(prefix, start)) continue;
      const end = source.indexOf(delimiter, start + prefix.length);
      if (end === -1) invalid();
      position = end + delimiter.length;
      return { kind, start, end: position };
    }
    let quote: string | undefined;
    position += 1;
    while (position < source.length) {
      const character = source[position];
      position += 1;
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        return { kind: source[start + 1] === '/' ? 'close' : 'open', start, end: position };
      }
    }
    return invalid();
  };
}

/** Scan UTF-8 once in source order; no full-size character-to-byte lookup table. */
function byteMapper(bytes: Uint8Array): (characterOffset: number) => number {
  let characterPosition = 0;
  let bytePosition = 0;
  return (characterOffset) => {
    if (!Number.isSafeInteger(characterOffset) || characterOffset < characterPosition) invalid();
    while (characterPosition < characterOffset) {
      const first = bytes[bytePosition];
      if (first === undefined) invalid();
      // Fatal UTF-8 validation has already excluded invalid/overlong sequences.
      const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      bytePosition += width;
      characterPosition += width === 4 ? 2 : 1;
    }
    if (characterPosition !== characterOffset || bytePosition > bytes.byteLength) invalid();
    return bytePosition;
  };
}

/**
 * Build a private reading index after the existing security gate. This is a
 * reader, not a serializer or patch writer. Index construction is O(input bytes
 * + nodes); retained element/text nodes share the maxXmlElements memory bound.
 */
export function indexXml(
  bytes: Uint8Array,
  inputLimits: Readonly<ResourceLimits> = RESOURCE_LIMITS,
): XmlIndex {
  const limits = Object.freeze({ ...inputLimits });
  // Snapshot before both passes so a caller-owned/shared buffer cannot change
  // after the security gate. Check its byte bound before allocating the copy.
  if (!Number.isSafeInteger(limits.maxXmlBytes) || limits.maxXmlBytes <= 0
    || bytes.byteLength > limits.maxXmlBytes) {
    throw new EngineError('RESOURCE_LIMIT', ERROR_MESSAGES.RESOURCE_LIMIT);
  }
  const originalBytes = new Uint8Array(bytes);
  const validated = validateXml(originalBytes, limits);
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes);
  const nextToken = tokenReader(source);
  const toByte = byteMapper(originalBytes);
  const parser = new SaxesParser({ xmlns: true, position: true });
  const elements: MutableElement[] = [];
  const stack: Array<{ element: MutableElement; end: number; selfClosing: boolean }> = [];
  let retainedNodes = 0;

  const retain = (): void => {
    retainedNodes += 1;
    if (retainedNodes > limits.maxXmlElements) {
      throw new EngineError('RESOURCE_LIMIT', ERROR_MESSAGES.RESOURCE_LIMIT);
    }
  };
  const token = (expected: Token['kind']): Token => {
    const result = nextToken();
    if (result.kind !== expected) invalid();
    return result;
  };
  const appendText = (kind: 'text' | 'cdata', text: string): void => {
    const raw = token(kind);
    const parent = stack.at(-1)?.element;
    // Legal whitespace outside the root is not document reading content.
    if (!parent) return;
    retain();
    parent.children.push(Object.freeze({
      kind,
      text,
      sourceSpan: Object.freeze({ startByte: toByte(raw.start), endByte: toByte(raw.end) }),
    }));
  };

  parser.on('error', () => invalid());
  parser.on('xmldecl', () => { token('declaration'); });
  parser.on('comment', () => { token('comment'); });
  parser.on('text', (text) => appendText('text', text));
  parser.on('cdata', (text) => appendText('cdata', text));
  parser.on('opentag', (tag) => {
    const raw = token('open');
    const original = validated.elements[elements.length];
    if (!original || original.start !== raw.start || original.uri !== tag.uri || original.local !== tag.local) invalid();
    retain();
    const parent = stack.at(-1)?.element ?? null;
    const attributeList = Object.values(tag.attributes)
      .filter((attribute) => attribute.name !== 'xmlns' && attribute.prefix !== 'xmlns')
      .map((attribute) => Object.freeze({
        qname: attribute.name, local: attribute.local, uri: attribute.uri, value: attribute.value,
      }));
    const element: MutableElement = {
      kind: 'element', qname: tag.name, local: tag.local, uri: tag.uri,
      attributes: Object.freeze(original.attributes), attributeList: Object.freeze(attributeList),
      parent, children: [], sourceSpan: { startByte: toByte(raw.start), endByte: -1 },
    };
    parent?.children.push(element);
    elements.push(element);
    stack.push({ element, end: original.end, selfClosing: tag.isSelfClosing });
  });
  parser.on('closetag', () => {
    const current = stack.pop();
    if (!current) invalid();
    if (!current.selfClosing && token('close').end !== current.end) invalid();
    current.element.sourceSpan.endByte = toByte(current.end);
    Object.freeze(current.element.sourceSpan);
    Object.freeze(current.element.children);
    Object.freeze(current.element);
  });

  try {
    for (let offset = 0; offset < source.length; offset += 4096) {
      parser.write(source.slice(offset, offset + 4096));
    }
    parser.close();
  } catch (error) {
    if (error instanceof EngineError) throw error;
    invalid();
  }
  const root = elements[0];
  if (!root || stack.length !== 0 || elements.length !== validated.elements.length) invalid();
  return Object.freeze({ root, elements: Object.freeze(elements) });
}

/** Plain text immediately inside an element, excluding text in child elements. */
export function directText(element: XmlIndexedElement): string {
  return element.children.flatMap((child) => child.kind === 'element' ? [] : [child.text]).join('');
}

/** Attribute lookup by exact expanded name, independent of the source prefix. */
export function attributeValue(element: XmlIndexedElement, uri: string, local: string): string | undefined {
  return element.attributeList.find((attribute) => attribute.uri === uri && attribute.local === local)?.value;
}

/** Direct element children; namespace matching uses exact expanded names. */
export function elementChildren(
  element: XmlIndexedElement,
  uri?: string,
  local?: string,
): XmlIndexedElement[] {
  return element.children.filter((child): child is XmlIndexedElement => child.kind === 'element'
    && (uri === undefined || child.uri === uri) && (local === undefined || child.local === local));
}
