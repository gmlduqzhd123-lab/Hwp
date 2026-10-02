import {
  FONT_LANGUAGES,
  type CharacterFormat, type FontDefinition, type FontLanguage, type FormatCatalog,
  type FormatDefinition, type FormatKind, type FormatReference, type FormatSource,
  type FormatValue, type InspectionReason, type ParagraphFormat, type SourceSpan,
} from '../../domain/document';
import { attributeValue, elementChildren, type XmlIndex, type XmlIndexedElement } from '../xml/index';
import { createNodeCatalog, INSPECTION_NAMESPACES as NS, uniqueReasons } from './nodes';

interface Definition {
  element: XmlIndexedElement;
  model: FormatDefinition;
  reasons: InspectionReason[];
}
type Definitions = Map<string, Definition[]>;
interface Selection {
  element: XmlIndexedElement | null;
  reasons: InspectionReason[];
}
interface Lookup {
  definition: Definition | null;
  reasons: InspectionReason[];
}

const UINT_MAX = 0xffffffff;
const INT_MIN = -0x80000000;
const INT_MAX = 0x7fffffff;
const ALIGNMENTS = new Set(['JUSTIFY', 'LEFT', 'RIGHT', 'CENTER', 'DISTRIBUTE', 'DISTRIBUTE_SPACE']);
const LINE_TYPES = new Set(['PERCENT', 'FIXED', 'BETWEEN_LINES', 'AT_LEAST']);
const CHARACTER_CHILDREN = new Set(['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic', 'bold',
  'underline', 'strikeout', 'outline', 'shadow', 'emboss', 'engrave', 'supscript', 'subscript']);
const PARAGRAPH_CHILDREN = new Set(['align', 'heading', 'breakSetting', 'margin', 'lineSpacing', 'border', 'autoSpacing']);

function structureReasons(definition: Definition): InspectionReason[] {
  const known = definition.model.kind === 'CHARACTER_SHAPE' ? CHARACTER_CHILDREN
    : definition.model.kind === 'PARAGRAPH_SHAPE' ? PARAGRAPH_CHILDREN : null;
  if (!known) return [];
  return uniqueReasons(elementChildren(definition.element).flatMap((child): InspectionReason[] => {
    if (child.uri === NS.paragraph && child.local === 'switch') return ['COMPATIBILITY_BRANCH'];
    if (child.uri !== NS.head) return ['UNKNOWN_NAMESPACE'];
    return known.has(child.local) ? [] : ['UNKNOWN_ELEMENT'];
  }));
}

function attribute(element: XmlIndexedElement, local: string): string | null {
  return attributeValue(element, '', local) ?? null;
}

/** IDs are decimal unsigned integers; 0 and 00 identify the same definition. */
function canonicalId(raw: string | null): string | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= UINT_MAX ? String(value) : null;
}

function value<T>(
  parsed: T | null, rawValue: string | null, rawUnit: string | null, unit: string | null,
  source: FormatSource | null, reasons: readonly InspectionReason[] = [],
): FormatValue<T> {
  return { value: parsed, rawValue, rawUnit, unit, source, reasons: uniqueReasons(reasons) };
}

function numeric(
  raw: string | null, rawUnit: string | null, unit: string | null, source: FormatSource | null,
  reasons: readonly InspectionReason[] = [], divisor = 1, minimum = INT_MIN, maximum = INT_MAX,
): FormatValue<number> {
  if (reasons.length) return value<number>(null, raw, rawUnit, unit, source, reasons);
  if (raw === null) return value<number>(null, null, rawUnit, unit, source, ['MISSING_FORMAT_VALUE']);
  const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return value<number>(null, raw, rawUnit, unit, source, ['INVALID_FORMAT_VALUE']);
  }
  return value(parsed / divisor, raw, rawUnit, unit, source);
}

/**
 * A compatibility switch may describe different values for different readers.
 * T-03 does not select an application profile or merge its case/default data.
 */
function property(parent: XmlIndexedElement, uri: string, local: string): Selection {
  const direct = elementChildren(parent, uri, local);
  const hasBranch = elementChildren(parent, NS.paragraph, 'switch').some((branch) => {
    const pending = [...elementChildren(branch)];
    while (pending.length) {
      const candidate = pending.pop();
      if (!candidate) break;
      if (candidate.uri === uri && candidate.local === local) return true;
      for (const child of elementChildren(candidate)) pending.push(child);
    }
    return false;
  });
  if (hasBranch) return { element: direct[0] ?? null, reasons: ['COMPATIBILITY_BRANCH'] };
  if (direct.length > 1) return { element: direct[0] ?? null, reasons: ['AMBIGUOUS_FORMAT_REFERENCE'] };
  return { element: direct[0] ?? null, reasons: [] };
}

export function createFormatResolver(header: { path: string; index: XmlIndex }) {
  const nodes = createNodeCatalog(header.path, header.index);
  const catalog: FormatCatalog = { fonts: [], characterShapes: [], paragraphShapes: [], styles: [] };
  const characterShapes: Definitions = new Map();
  const paragraphShapes: Definitions = new Map();
  const styles: Definitions = new Map();
  const fonts = new Map<FontLanguage, Definitions>();
  const lookups = new WeakMap<Definitions, Map<string, Lookup>>();
  // Values describe definitions, so runs share them. Only each requested
  // reference and its caller-owned source span vary across text nodes.
  const characterValues = new Map<Definition | string, CharacterFormat>();
  const paragraphValues = new Map<Definition | string, ParagraphFormat>();
  const refLists = elementChildren(header.index.root, NS.head, 'refList');

  function add(element: XmlIndexedElement, kind: FormatKind, map: Definitions, ambiguous: boolean): Definition {
    const id = attribute(element, 'id');
    const key = canonicalId(id);
    const reasons: InspectionReason[] = ambiguous ? ['AMBIGUOUS_FORMAT_REFERENCE'] : [];
    if (id === null) reasons.push('MISSING_FORMAT_REFERENCE');
    else if (key === null) reasons.push('INVALID_FORMAT_VALUE');
    const model: FormatDefinition = {
      nodeId: nodes.identity(element).nodeId, id, kind, sourceSpan: nodes.sourceSpan(element),
      attributes: { ...element.attributes }, reasons: [],
    };
    const definition = { element, model, reasons };
    if (key !== null) {
      const existing = map.get(key) ?? [];
      existing.push(definition);
      map.set(key, existing);
    }
    return definition;
  }

  function finish(map: Definitions): void {
    const resolved = new Map<string, Lookup>();
    for (const [id, definitions] of map) {
      if (definitions.length > 1) {
        for (const definition of definitions) definition.reasons.push('AMBIGUOUS_FORMAT_REFERENCE');
      }
      for (const definition of definitions) definition.model.reasons = uniqueReasons([...definition.reasons, ...structureReasons(definition)]);
      const single = definitions.length === 1 ? definitions[0] : undefined;
      resolved.set(id, {
        definition: single && single.reasons.length === 0 ? single : null,
        reasons: uniqueReasons(definitions.flatMap((definition) => definition.reasons)),
      });
    }
    lookups.set(map, resolved);
  }

  for (const [containerName, definitionName, kind, map, target] of [
    ['charProperties', 'charPr', 'CHARACTER_SHAPE', characterShapes, catalog.characterShapes],
    ['paraProperties', 'paraPr', 'PARAGRAPH_SHAPE', paragraphShapes, catalog.paragraphShapes],
    ['styles', 'style', 'STYLE', styles, catalog.styles],
  ] as const) {
    const containers = refLists.flatMap((list) => elementChildren(list, NS.head, containerName));
    for (const container of containers) {
      for (const element of elementChildren(container, NS.head, definitionName)) {
        const definition = add(element, kind, map, refLists.length > 1 || containers.length > 1);
        definition.model.reasons = uniqueReasons(definition.reasons);
        target.push(definition.model);
      }
    }
    finish(map);
  }

  const fontContainers = refLists.flatMap((list) => elementChildren(list, NS.head, 'fontfaces'));
  const faces = fontContainers.flatMap((container) => elementChildren(container, NS.head, 'fontface'));
  const faceCounts = new Map<string | null, number>();
  for (const face of faces) {
    const language = attribute(face, 'lang');
    faceCounts.set(language, (faceCounts.get(language) ?? 0) + 1);
  }
  for (const language of FONT_LANGUAGES) fonts.set(language, new Map());
  for (const face of faces) {
    const language = attribute(face, 'lang');
    const knownLanguage = FONT_LANGUAGES.find((candidate) => candidate === language);
    const map = knownLanguage ? fonts.get(knownLanguage)! : new Map<string, Definition[]>();
    const repeatedFace = (faceCounts.get(language) ?? 0) > 1;
    for (const element of elementChildren(face, NS.head, 'font')) {
      const definition = add(element, 'FONT', map, refLists.length > 1 || fontContainers.length > 1 || repeatedFace);
      const fontFace = attribute(element, 'face');
      if (!knownLanguage) definition.reasons.push('UNSUPPORTED_FORMAT');
      if (fontFace === null) definition.reasons.push('MISSING_FORMAT_VALUE');
      else if (!fontFace.trim()) definition.reasons.push('INVALID_FORMAT_VALUE');
      const model: FontDefinition = { ...definition.model, language, face: fontFace, reasons: uniqueReasons(definition.reasons) };
      definition.model = model;
      catalog.fonts.push(model);
    }
    if (!knownLanguage) finish(map);
  }
  for (const map of fonts.values()) finish(map);

  function source(definition: Definition): FormatSource {
    return {
      kind: definition.model.kind, definitionId: definition.model.id, nodeId: definition.model.nodeId,
      sourceSpan: { ...definition.model.sourceSpan }, viaStyleId: null,
    };
  }

  function lookup(map: Definitions, raw: string | null): Lookup {
    if (raw === null) return { definition: null, reasons: ['MISSING_FORMAT_REFERENCE'] };
    const key = canonicalId(raw);
    if (key === null) return { definition: null, reasons: ['INVALID_FORMAT_VALUE'] };
    // Duplicate-ID errors are aggregated once during catalog construction.
    // Repeated references never rescan a potentially large definition bucket.
    return lookups.get(map)?.get(key) ?? { definition: null, reasons: ['MISSING_FORMAT_REFERENCE'] };
  }

  function reference(element: XmlIndexedElement, name: string, kind: FormatKind, map: Definitions, span: SourceSpan) {
    const requestedId = attribute(element, name);
    const result = lookup(map, requestedId);
    const model: FormatReference = {
      kind, requestedId, resolved: result.definition !== null,
      definitionNodeId: result.definition?.model.nodeId ?? null,
      sourceSpan: { ...span }, viaStyleId: null, reasons: result.reasons,
    };
    return { model, ...result };
  }

  function resolveStyle(paragraph: XmlIndexedElement, span: SourceSpan): FormatReference {
    return reference(paragraph, 'styleIDRef', 'STYLE', styles, span).model;
  }

  function resolveCharacter(run: XmlIndexedElement, span: SourceSpan): CharacterFormat {
    const resolved = reference(run, 'charPrIDRef', 'CHARACTER_SHAPE', characterShapes, span);
    const definition = resolved.definition;
    const cacheKey = definition ?? resolved.reasons.join('|');
    const cached = characterValues.get(cacheKey);
    if (cached) return { ...cached, reference: resolved.model };
    const formatSource = definition ? source(definition) : null;
    const group = (name: string): Selection => definition
      ? property(definition.element, NS.head, name)
      : { element: null, reasons: resolved.reasons };
    const languageNumbers = (name: string, unsigned = false): Record<FontLanguage, FormatValue<number>> => {
      const selected = group(name);
      return Object.fromEntries(FONT_LANGUAGES.map((language) => [language,
        numeric(selected.element ? attribute(selected.element, language.toLowerCase()) : null,
          '%', '%', formatSource, selected.reasons, 1, unsigned ? 0 : INT_MIN, unsigned ? UINT_MAX : INT_MAX),
      ])) as Record<FontLanguage, FormatValue<number>>;
    };
    const fontRefs = group('fontRef');
    const languageFonts = Object.fromEntries(FONT_LANGUAGES.map((language) => {
      const rawId = fontRefs.element ? attribute(fontRefs.element, language.toLowerCase()) : null;
      const found = fontRefs.reasons.length ? { definition: null, reasons: fontRefs.reasons }
        : lookup(fonts.get(language)!, rawId);
      const fontSource = found.definition ? source(found.definition) : formatSource;
      return [language, value(found.definition ? attribute(found.definition.element, 'face') : null,
        rawId, 'FONT_ID', 'font-face', fontSource, found.reasons)];
    })) as Record<FontLanguage, FormatValue<string>>;
    const superscript = definition ? elementChildren(definition.element, NS.head, 'supscript').length > 0 : false;
    const subscript = definition ? elementChildren(definition.element, NS.head, 'subscript').length > 0 : false;
    const format: CharacterFormat = {
      reference: resolved.model,
      fontSize: numeric(definition ? attribute(definition.element, 'height') : null,
        'HWPUNIT', 'pt', formatSource, resolved.reasons, 100, 1),
      fonts: languageFonts, ratio: languageNumbers('ratio', true), spacing: languageNumbers('spacing'),
      relativeSize: languageNumbers('relSz', true), offset: languageNumbers('offset'),
      superscript, subscript, reasons: [],
    };
    format.reasons = uniqueReasons([
      ...resolved.reasons, ...(definition ? structureReasons(definition) : []), ...format.fontSize.reasons,
      ...[format.fonts, format.ratio, format.spacing, format.relativeSize, format.offset]
        .flatMap((values) => Object.values(values).flatMap((item) => item.reasons)),
      ...(superscript || subscript ? ['SUPERSCRIPT_OR_SUBSCRIPT' as const] : []),
    ]);
    characterValues.set(cacheKey, format);
    return format;
  }

  function resolveParagraph(paragraph: XmlIndexedElement, span: SourceSpan): ParagraphFormat {
    const resolved = reference(paragraph, 'paraPrIDRef', 'PARAGRAPH_SHAPE', paragraphShapes, span);
    const definition = resolved.definition;
    const cacheKey = definition ?? resolved.reasons.join('|');
    const cached = paragraphValues.get(cacheKey);
    if (cached) return { ...cached, reference: resolved.model };
    const formatSource = definition ? source(definition) : null;
    const group = (name: string): Selection => definition
      ? property(definition.element, NS.head, name)
      : { element: null, reasons: resolved.reasons };
    const align = group('align');
    const horizontal = align.element ? attribute(align.element, 'horizontal') : null;
    const alignment = value(align.reasons.length || horizontal === null || !ALIGNMENTS.has(horizontal) ? null : horizontal,
      horizontal, null, null, formatSource, align.reasons.length ? align.reasons
        : horizontal === null ? ['MISSING_FORMAT_VALUE'] : ALIGNMENTS.has(horizontal) ? [] : ['UNSUPPORTED_FORMAT']);
    const line = group('lineSpacing');
    const type = line.element ? attribute(line.element, 'type') : null;
    const rawUnit = line.element ? attribute(line.element, 'unit') : null;
    const typeReasons = line.reasons.length ? line.reasons : type === null ? ['MISSING_FORMAT_VALUE' as const]
      : LINE_TYPES.has(type) ? [] : ['UNSUPPORTED_FORMAT' as const];
    const lineSpacingType = value(typeReasons.length ? null : type, type, null, null, formatSource, typeReasons);
    const lineReasons = [...typeReasons];
    if (!lineReasons.length && rawUnit !== 'HWPUNIT') lineReasons.push(rawUnit === null ? 'MISSING_FORMAT_VALUE' : 'UNSUPPORTED_FORMAT');
    const lineSpacing = numeric(line.element ? attribute(line.element, 'value') : null,
      rawUnit, type === 'PERCENT' ? '%' : rawUnit === 'HWPUNIT' ? 'pt' : null,
      formatSource, lineReasons, type === 'PERCENT' ? 1 : 100, 0);
    const margin = group('margin');
    const marginValue = (names: string[]): FormatValue<number> => {
      const children = margin.element ? names.flatMap((name) => elementChildren(margin.element!, NS.core, name)) : [];
      const element = children[0];
      const reasons = children.length > 1 ? ['AMBIGUOUS_FORMAT_REFERENCE' as const] : margin.reasons;
      const unit = element ? attribute(element, 'unit') : null;
      const raw = element ? attribute(element, 'value') : null;
      const unsupported = reasons.length ? reasons : !element ? ['MISSING_FORMAT_VALUE' as const]
        : unit === null ? ['MISSING_FORMAT_VALUE' as const] : unit !== 'HWPUNIT' ? ['UNSUPPORTED_FORMAT' as const] : [];
      return numeric(raw, unit, unit === 'HWPUNIT' ? 'pt' : null, formatSource, unsupported, 100);
    };
    const format: ParagraphFormat = {
      reference: resolved.model, alignment, lineSpacingType, lineSpacing,
      leftMargin: marginValue(['left']), rightMargin: marginValue(['right']), indent: marginValue(['intent', 'indent']),
      beforeSpacing: marginValue(['prev']), afterSpacing: marginValue(['next']), reasons: [],
    };
    format.reasons = uniqueReasons([
      ...resolved.reasons, ...(definition ? structureReasons(definition) : []),
      ...[alignment, lineSpacingType, lineSpacing, format.leftMargin, format.rightMargin, format.indent,
        format.beforeSpacing, format.afterSpacing].flatMap((item) => item.reasons),
    ]);
    paragraphValues.set(cacheKey, format);
    return format;
  }

  return { catalog, resolveStyle, resolveParagraph, resolveCharacter };
}
