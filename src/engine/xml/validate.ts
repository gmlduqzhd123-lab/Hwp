import { SaxesParser } from 'saxes';
import { EngineError, type XmlUnsupportedReason } from '../../domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../domain/limits';

export interface XmlElement {
  local: string;
  uri: string;
  /** Unqualified attributes use their local name; qualified attributes retain their QName. */
  attributes: Record<string, string>;
  /** Original UTF-16 source offset at the opening '<', not a byte patch position. */
  start: number;
  /** Exclusive original UTF-16 source offset after the closing tag, not a byte patch position. */
  end: number;
}

export interface XmlDocument {
  /** Elements appear in document order; elements[0] is the root. */
  elements: XmlElement[];
}

const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';
const XSI_URI = 'http://www.w3.org/2001/XMLSchema-instance';
const RDF_URI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
// Hancom's public model uses the slash form; the OPF standard uses the other.
// These are explicit supported names, never prefix or arbitrary URI normalization.
const OPF_URIS = new Set(['http://www.idpf.org/2007/opf', 'http://www.idpf.org/2007/opf/']);
const ACTIVE_ELEMENTS = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'ole']);
const INVALID_MESSAGE = 'XML 구조가 올바르지 않습니다. 원본은 변경되지 않았습니다.';
const UNSUPPORTED_MESSAGE = '안전하게 검사할 수 없는 XML 구조입니다. 원본은 변경되지 않았습니다.';
const LIMIT_MESSAGE = 'XML 검사 제한을 초과했습니다. 원본은 변경되지 않았습니다.';

function invalid(): never {
  throw new EngineError('FILE_INVALID_PACKAGE', INVALID_MESSAGE);
}

function unsupported(reason: XmlUnsupportedReason): never {
  throw new EngineError('XML_UNSUPPORTED', UNSUPPORTED_MESSAGE, reason);
}

function checkLength(length: number, maximum: number): void {
  if (length > maximum) throw new EngineError('RESOURCE_LIMIT', LIMIT_MESSAGE);
}

function isXmlSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

/**
 * Bound raw lexical buffers before handing them to the parser. This is not an XML
 * parser: saxes remains responsible for all grammar and namespace validation.
 * Comments and CDATA are skipped as data, so a quoted DTD example is harmless.
 */
function checkTokens(source: string, maximum: number): void {
  let position = 0;
  while (position < source.length) {
    if (source[position] !== '<') {
      const next = source.indexOf('<', position);
      const end = next === -1 ? source.length : next;
      checkLength(end - position, maximum);
      position = end;
      continue;
    }

    const quotedSection = source.startsWith('<!--', position)
      ? { start: position + 4, delimiter: '-->' }
      : source.startsWith('<![CDATA[', position)
        ? { start: position + 9, delimiter: ']]>' }
        : source.startsWith('<?', position)
          ? { start: position + 2, delimiter: '?>' }
          : undefined;
    if (quotedSection) {
      const end = source.indexOf(quotedSection.delimiter, quotedSection.start);
      if (end === -1) invalid();
      checkLength(end - quotedSection.start, maximum);
      position = end + quotedSection.delimiter.length;
      continue;
    }

    if (/^<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source.slice(position, position + 32))) unsupported('DTD');

    position += 1;
    let tokenStart = position;
    while (position < source.length && source[position] !== '>') {
      const character = source[position];
      if (character === '"' || character === "'") {
        checkLength(position - tokenStart, maximum);
        const end = source.indexOf(character, position + 1);
        if (end === -1) invalid();
        checkLength(end - position - 1, maximum);
        position = end + 1;
        tokenStart = position;
      } else if (isXmlSpace(character) || character === '=' || character === '/') {
        checkLength(position - tokenStart, maximum);
        position += 1;
        tokenStart = position;
      } else {
        position += 1;
      }
    }
    checkLength(position - tokenStart, maximum);
    if (position === source.length) invalid();
    position += 1;
  }
}

function hasExternalReference(value: string): boolean {
  // Character references have already been decoded by saxes. Remove controls and
  // spaces to catch obfuscated schemes without ever resolving or fetching a URL.
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, '');
  // Browsers and Windows also interpret UNC and mixed-slash prefixes as remote
  // network paths. Checking only '//' leaves those equivalent forms unchecked.
  return /(?:https?|ftp|file|javascript|data|vbscript):/i.test(compact) || /^[\\/]{2}/u.test(compact);
}

interface ExpandedName {
  uri: string;
  local: string;
}

/**
 * These exact XML metadata roles describe values; this reader never resolves
 * schema hints, dereferences RDF identifiers, renders markup or fetches URLs.
 * Other attributes, including resource href/src/path, keep their rejection rule.
 */
function isInertMetadataAttribute(
  tag: ExpandedName,
  attribute: ExpandedName,
  parent: XmlElement | undefined,
  root: XmlElement | undefined,
): boolean {
  if (attribute.uri === XSI_URI
    && (attribute.local === 'schemaLocation' || attribute.local === 'noNamespaceSchemaLocation')) return true;

  if (OPF_URIS.has(tag.uri) && tag.local === 'meta'
    && parent?.uri === tag.uri && parent.local === 'metadata'
    && attribute.uri === '' && attribute.local === 'content') return true;

  if (root?.uri !== RDF_URI || root.local !== 'RDF' || tag.uri !== RDF_URI || attribute.uri !== RDF_URI) return false;
  if (tag.local === 'Description' && attribute.local === 'about') return true;
  return tag.local === 'type' && attribute.local === 'resource'
    && parent?.uri === RDF_URI && parent.local === 'Description';
}

/**
 * Validate immutable UTF-8 bytes and collect bounded, namespace-aware metadata.
 * There is no XML serializer or writer. Saxes positions are character offsets;
 * Korean characters and a retained BOM make them different from byte offsets.
 */
export function validateXml(
  bytes: Uint8Array,
  inputLimits: Readonly<ResourceLimits> = RESOURCE_LIMITS,
): XmlDocument {
  const limits = Object.freeze({ ...inputLimits });
  // This API is also used directly, without the package metadata validator.
  // NaN/Infinity otherwise silently disable comparisons instead of bounding XML.
  for (const key of ['maxXmlBytes', 'maxXmlDepth', 'maxAttributes', 'maxXmlTextLength', 'maxXmlElements'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new EngineError('RESOURCE_LIMIT', LIMIT_MESSAGE);
    }
  }
  checkLength(bytes.byteLength, limits.maxXmlBytes);
  let source: string;
  try {
    // Preserve the BOM in the source so reported offsets refer to the decoded
    // original, while rejecting malformed and non-UTF-8 input without replacement.
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    unsupported('ENCODING');
  }
  checkTokens(source, limits.maxXmlTextLength);

  const parser = new SaxesParser({ xmlns: true, position: true });
  const elements: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let attributeCount = 0;
  let textLength = 0;

  parser.on('error', () => invalid());
  parser.on('doctype', () => unsupported('DTD'));
  parser.on('xmldecl', (declaration) => {
    if (declaration.encoding && declaration.encoding.toLowerCase() !== 'utf-8') unsupported('ENCODING');
    if (declaration.version !== '1.0') unsupported('XML_VERSION');
  });
  parser.on('processinginstruction', () => unsupported('PROCESSING_INSTRUCTION'));
  parser.on('opentagstart', (tag) => {
    attributeCount = 0;
    checkLength(tag.name.length, limits.maxXmlTextLength);
    checkLength(stack.length + 1, limits.maxXmlDepth);
    checkLength(elements.length + 1, limits.maxXmlElements);
  });
  parser.on('attribute', (attribute) => {
    attributeCount += 1;
    checkLength(attributeCount, limits.maxAttributes);
    checkLength(attribute.name.length, limits.maxXmlTextLength);
    checkLength(attribute.value.length, limits.maxXmlTextLength);
    // Saxes trims namespace bindings before resolving them. Such a trim changes
    // the declared namespace identity, so reject it instead of accepting a
    // whitespace-disguised trusted HWPX namespace.
    if ((attribute.name === 'xmlns' || attribute.prefix === 'xmlns')
      && attribute.value !== attribute.value.trim()) unsupported('NAMESPACE');
  });
  parser.on('opentag', (tag) => {
    if (ACTIVE_ELEMENTS.has(tag.local.toLowerCase())) unsupported('ACTIVE_CONTENT');
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === XMLNS_URI || attribute.name === 'xmlns' || attribute.prefix === 'xmlns') continue;
      if (/^on[a-z]+$/i.test(attribute.local)) unsupported('EVENT_ATTRIBUTE');
      if (hasExternalReference(attribute.value)
        && !isInertMetadataAttribute(tag, attribute, stack.at(-1), elements[0])) unsupported('EXTERNAL_REFERENCE');
      const key = attribute.uri === '' ? attribute.local : attribute.name;
      attributes[key] = attribute.value;
    }
    const element: XmlElement = {
      local: tag.local,
      uri: tag.uri,
      attributes,
      start: source.lastIndexOf('<', parser.position - 1),
      end: -1,
    };
    elements.push(element);
    stack.push(element);
  });
  parser.on('closetag', () => {
    const element = stack.pop();
    if (!element) invalid();
    element.end = parser.position;
  });
  const onText = (text: string): void => {
    textLength += text.length;
    checkLength(textLength, limits.maxXmlTextLength);
  };
  parser.on('text', onText);
  parser.on('cdata', onText);

  try {
    // Small writes avoid duplicating a large document inside the parser's chunk.
    // XML byte, lexical, element, attribute, depth and text bounds remain enforced.
    for (let offset = 0; offset < source.length; offset += 4096) {
      parser.write(source.slice(offset, offset + 4096));
    }
    parser.close();
  } catch (error) {
    if (error instanceof EngineError) throw error;
    invalid();
  }
  if (elements.length === 0 || stack.length !== 0) invalid();
  return { elements };
}
