import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FONT_LANGUAGES, type SourceSpan } from '../../src/domain/document';
import type { DraftPage } from '../../src/domain/research';
import { createDraftHeader, type DraftStyleName, type DraftStyleRole } from '../../src/engine/draft/styles';
import { getBlankTemplateBytes } from '../../src/engine/draft/template';
import { createFormatResolver } from '../../src/engine/inspection/formats';
import { INSPECTION_NAMESPACES as NS } from '../../src/engine/inspection/nodes';
import { attributeValue, elementChildren, indexXml, type XmlIndex, type XmlIndexedElement } from '../../src/engine/xml/index';

let header: Uint8Array;
const path = 'Contents/header.xml';
const referenceSpan: SourceSpan = { entryPath: 'Contents/section0.xml', startByte: 0, endByte: 10 };
// Fixed synthetic parameters keep this unit suite independent of catalog policy.
const SYNTHETIC_PAGE: DraftPage = {
  fontFace: '휴먼명조', fontSizePt: 12, lineSpacingPercent: 160, width: 59528, height: 84188,
  margins: { top: 4252, bottom: 4252, left: 7087, right: 7087, header: 4252, footer: 4252, gutter: 2835 },
  indent: 1000, beforeSpacing: 500, afterSpacing: 0,
};

beforeAll(() => {
  // The licensed public blank is a development template, never a user input.
  header = unzipSync(getBlankTemplateBytes())[path]!;
});

function find(index: XmlIndex, local: string, id: string): XmlIndexedElement {
  return index.elements.find((node) => node.uri === NS.head && node.local === local && attributeValue(node, '', 'id') === id)!;
}
function text(bytes: Uint8Array, node: XmlIndexedElement): string {
  return new TextDecoder().decode(bytes.subarray(node.sourceSpan.startByte, node.sourceSpan.endByte));
}
function ref(ids: { charPrId: string; paraPrId: string; styleId: string }): XmlIndexedElement {
  return indexXml(new TextEncoder().encode(`<hp:p xmlns:hp="${NS.paragraph}" charPrIDRef="${ids.charPrId}" paraPrIDRef="${ids.paraPrId}" styleIDRef="${ids.styleId}"/>`)).root;
}
function page(): DraftPage { return structuredClone(SYNTHETIC_PAGE); }

describe('public-blank research draft style generation', () => {
  it('creates five complete role definitions and consistent language font references', () => {
    const result = createDraftHeader(header, page());
    const index = indexXml(result.bytes);
    const resolver = createFormatResolver({ path, index });
    const roles = Object.keys(result.styles) as DraftStyleRole[];
    expect(roles).toEqual(['body', 'title', 'heading', 'cover', 'toc']);
    expect(new Set(roles.map((role) => result.styles[role].charPrId)).size).toBe(5);
    expect(new Set(roles.map((role) => result.styles[role].paraPrId)).size).toBe(5);
    expect(new Set(roles.map((role) => result.styles[role].styleId)).size).toBe(5);
    const expectedSize = { body: 12, title: 16, heading: 12, cover: 12, toc: 12 };
    for (const role of roles) {
      const ids = result.styles[role];
      const element = ref(ids);
      const character = resolver.resolveCharacter(element, referenceSpan);
      const paragraph = resolver.resolveParagraph(element, referenceSpan);
      expect(character.reference.resolved).toBe(true);
      expect(character.fontSize).toMatchObject({ value: expectedSize[role], rawValue: String(expectedSize[role] * 100), unit: 'pt' });
      expect(character.reasons).toEqual([]);
      for (const language of FONT_LANGUAGES) {
        expect(character.fonts[language]).toMatchObject({ value: '휴먼명조', rawValue: '2', reasons: [] });
        expect(character.ratio[language].value).toBe(100);
        expect(character.spacing[language].value).toBe(0);
      }
      expect(paragraph.reference.resolved).toBe(true);
      expect(paragraph.reasons).toEqual([]);
      expect(paragraph.alignment.value).toBe(role === 'body' ? 'JUSTIFY' : role === 'title' ? 'CENTER' : 'LEFT');
      expect(paragraph.indent.value).toBe(role === 'body' ? 10 : 0);
      expect(paragraph.beforeSpacing.value).toBe(5);
      expect(paragraph.afterSpacing.value).toBe(0);
      expect(paragraph.lineSpacing).toMatchObject({ value: 160, rawValue: '160', rawUnit: 'HWPUNIT', unit: '%' });
      const style = find(index, 'style', ids.styleId);
      expect(style.attributes).toMatchObject({ charPrIDRef: ids.charPrId, paraPrIDRef: ids.paraPrId, nextStyleIDRef: result.styles.body.styleId, type: 'PARA', langID: '1042', lockForm: '0' });
      const shape = find(index, 'charPr', ids.charPrId);
      expect(elementChildren(shape, NS.head, 'bold')).toHaveLength(role === 'title' || role === 'heading' ? 1 : 0);
      expect(elementChildren(find(index, 'paraPr', ids.paraPrId), NS.paragraph, 'switch')).toHaveLength(0);
    }
  });

  it('adds explicit non-embedded fonts without inventing typeInfo or substitution metrics', () => {
    const result = createDraftHeader(header, page());
    const index = indexXml(result.bytes);
    const faces = index.elements.filter((node) => node.uri === NS.head && node.local === 'fontface');
    expect(faces).toHaveLength(7);
    for (const face of faces) {
      const fonts = elementChildren(face, NS.head, 'font');
      expect(face.attributes.fontCnt).toBe('3');
      expect(fonts).toHaveLength(3);
      const font = fonts.find((node) => node.attributes.id === '2')!;
      expect(font.attributes).toMatchObject({ id: '2', face: '휴먼명조', type: 'TTF', isEmbedded: '0' });
      expect(elementChildren(font)).toEqual([]);
    }
    const counts = { charProperties: '12', paraProperties: '21', styles: '23' };
    for (const [local, count] of Object.entries(counts)) {
      const container = index.elements.find((node) => node.uri === NS.head && node.local === local)!;
      expect(container.attributes.itemCnt).toBe(count);
      expect(elementChildren(container).length).toBe(Number(count));
    }
  });

  it('preserves all existing definitions byte for byte and keeps original emphasis details in clones', () => {
    const snapshot = new Uint8Array(header);
    const before = indexXml(header);
    const result = createDraftHeader(header, page());
    const after = indexXml(result.bytes);
    for (const original of before.elements.filter((node) => node.uri === NS.head && ['font', 'charPr', 'paraPr', 'style'].includes(node.local))) {
      const candidates = after.elements.filter((node) => node.uri === original.uri && node.local === original.local && node.attributes.id === original.attributes.id
        && (original.local !== 'font' || node.parent?.attributes.lang === original.parent?.attributes.lang));
      expect(candidates).toHaveLength(1);
      expect(text(result.bytes, candidates[0]!)).toBe(text(header, original));
    }
    const base = find(before, 'charPr', '0');
    for (const ids of Object.values(result.styles)) {
      const clone = find(after, 'charPr', ids.charPrId);
      for (const name of ['textColor', 'shadeColor', 'useFontSpace', 'useKerning', 'symMark', 'borderFillIDRef']) {
        expect(clone.attributes[name]).toBe(base.attributes[name]);
      }
      for (const name of ['underline', 'strikeout', 'outline', 'shadow']) {
        const sourceChild = elementChildren(base, NS.head, name)[0]!;
        expect(text(result.bytes, elementChildren(clone, NS.head, name)[0]!)).toBe(text(header, sourceChild));
      }
    }
    expect(header).toEqual(snapshot);
  });

  it('applies the paper profile and representable fractional point sizes deterministically', () => {
    const profile = { ...page(), fontFace: '함초롬바탕', fontSizePt: 11.25, indent: -250, lineSpacingPercent: 175, beforeSpacing: 0 };
    const first = createDraftHeader(header, profile);
    const second = createDraftHeader(header, profile);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.styles).toEqual(second.styles);
    expect(first.bytes).not.toBe(second.bytes);
    const resolver = createFormatResolver({ path, index: indexXml(first.bytes) });
    const element = ref(first.styles.body);
    expect(resolver.resolveCharacter(element, referenceSpan).fontSize.value).toBe(11.25);
    expect(resolver.resolveCharacter(ref(first.styles.heading), referenceSpan).fontSize).toMatchObject({ value: 11.25, rawValue: '1125', unit: 'pt' });
    expect(resolver.resolveCharacter(element, referenceSpan).fonts.HANGUL.value).toBe('함초롬바탕');
    const paragraph = resolver.resolveParagraph(element, referenceSpan);
    expect(paragraph.indent.value).toBe(-2.5);
    expect(paragraph.lineSpacing.value).toBe(175);
    expect(paragraph.beforeSpacing.value).toBe(0);
  });

  it('handles alternate namespace prefixes and safely escapes profile font names', () => {
    const alternate = new TextDecoder().decode(header).replaceAll('hh:', 'h:').replaceAll('xmlns:hh=', 'xmlns:h=');
    const requestedFace = '합성 & "글꼴" <이름>';
    const result = createDraftHeader(new TextEncoder().encode(alternate), { ...page(), fontFace: requestedFace });
    const index = indexXml(result.bytes);
    const resolver = createFormatResolver({ path, index });
    expect(resolver.resolveCharacter(ref(result.styles.body), referenceSpan).fonts.HANGUL.value).toBe(requestedFace);
    expect(find(index, 'charPr', result.styles.body.charPrId).qname).toBe('h:charPr');
  });

  it('stores decimal hundredths as exact HWPUNIT integers despite binary rounding noise', () => {
    const result = createDraftHeader(header, { ...page(), fontSizePt: 11.23 });
    expect(find(indexXml(result.bytes), 'charPr', result.styles.body.charPrId).attributes.height).toBe('1123');
  });

  it('uses every explicit role size, including a separate references style', () => {
    const profile = { ...page(), fontSizes: { title: 18, heading: 13, cover: 10, toc: 11, references: 9.5 } };
    const result = createDraftHeader(header, profile);
    const index = indexXml(result.bytes);
    const resolver = createFormatResolver({ path, index });
    expect(Object.keys(result.styles)).toEqual(['body', 'title', 'heading', 'cover', 'toc', 'references']);
    const expected: Record<DraftStyleName, number> = { body: 12, ...profile.fontSizes };
    for (const role of Object.keys(expected) as DraftStyleName[]) {
      const ids = result.styles[role]!;
      const character = resolver.resolveCharacter(ref(ids), referenceSpan);
      const paragraph = resolver.resolveParagraph(ref(ids), referenceSpan);
      expect(character.fontSize).toMatchObject({ value: expected[role], rawValue: String(expected[role] * 100), unit: 'pt' });
      for (const language of FONT_LANGUAGES) expect(character.fonts[language].value).toBe(profile.fontFace);
      expect(character.reasons).toEqual([]);
      expect(paragraph.reasons).toEqual([]);
      expect(paragraph.alignment.value).toBe(role === 'body' || role === 'references' ? 'JUSTIFY' : role === 'title' ? 'CENTER' : 'LEFT');
      expect(paragraph.indent.value).toBe(role === 'body' || role === 'references' ? 10 : 0);
      expect(find(index, 'style', ids.styleId).attributes).toMatchObject({
        charPrIDRef: ids.charPrId, paraPrIDRef: ids.paraPrId, nextStyleIDRef: result.styles.body.styleId,
      });
    }
    for (const [local, count] of Object.entries({ charProperties: 13, paraProperties: 22, styles: 24 })) {
      const container = index.elements.find((node) => node.uri === NS.head && node.local === local)!;
      expect(container.attributes.itemCnt).toBe(String(count));
      expect(elementChildren(container)).toHaveLength(count);
    }
  });

  it('keeps the existing five styles and exact output when no role size is specified', () => {
    const legacy = createDraftHeader(header, page());
    const empty = createDraftHeader(header, { ...page(), fontSizes: {} });
    const absentValues = createDraftHeader(header, { ...page(), fontSizes: { title: undefined, references: undefined } });
    expect(empty.bytes).toEqual(legacy.bytes);
    expect(absentValues.bytes).toEqual(legacy.bytes);
    expect(empty.styles).toEqual(legacy.styles);
    expect(empty.styles.references).toBeUndefined();
  });

  it('changes a partial override while preserving the remaining legacy role sizes', () => {
    const result = createDraftHeader(header, { ...page(), fontSizePt: 11.23, fontSizes: { title: 20.25 } });
    const resolver = createFormatResolver({ path, index: indexXml(result.bytes) });
    expect(Object.keys(result.styles)).toHaveLength(5);
    const expected = { body: 11.23, title: 20.25, heading: 11.23, cover: 12, toc: 12 };
    for (const role of Object.keys(expected) as DraftStyleRole[]) {
      expect(resolver.resolveCharacter(ref(result.styles[role]), referenceSpan).fontSize.value).toBe(expected[role]);
    }
  });

  it.each([
    { title: Number.NaN }, { heading: -1 }, { cover: 5.99 }, { toc: 72.01 }, { references: 9.005 },
  ])('rejects invalid role sizes %j without changing the template', (fontSizes) => {
    const snapshot = new Uint8Array(header);
    expect(() => createDraftHeader(header, { ...page(), fontSizes }))
      .toThrowError(expect.objectContaining({ code: 'FILE_INVALID_PACKAGE' }));
    expect(header).toEqual(snapshot);
  });

  it('does not perform a network request', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try { createDraftHeader(header, page()); expect(fetch).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); }
  });

  it.each([
    { fontFace: '' }, { fontSizePt: Number.NaN }, { fontSizePt: 0 }, { fontSizePt: 73 }, { fontSizePt: 11.005 },
    { lineSpacingPercent: Number.POSITIVE_INFINITY }, { lineSpacingPercent: 160.5 }, { indent: Number.NaN },
    { beforeSpacing: -1 }, { afterSpacing: -1 },
  ])('rejects invalid profile values %j without mutating the template', (changes) => {
    const snapshot = new Uint8Array(header);
    expect(() => createDraftHeader(header, { ...page(), ...changes })).toThrowError(expect.objectContaining({ code: 'FILE_INVALID_PACKAGE' }));
    expect(header).toEqual(snapshot);
  });

  it('rejects inconsistent counts, missing default branches, ambiguous IDs and font ID collisions', () => {
    const original = new TextDecoder().decode(header);
    const mutations = [
      original.replace('<hh:charProperties itemCnt="7">', '<hh:charProperties itemCnt="8">'),
      original.replace('<hh:paraPr id="3"', '<hh:paraPr id="2"'),
      original.replace('<hh:charPr id="0"', '<hh:charPr id="1"'),
      original.replace('<hh:font id="0"', '<hh:font id="2"'),
      original.replaceAll('<hp:default>', '<hp:defaultMissing>').replaceAll('</hp:default>', '</hp:defaultMissing>'),
    ];
    for (const source of mutations) {
      expect(source).not.toBe(original);
      expect(() => createDraftHeader(new TextEncoder().encode(source), page())).toThrowError(expect.objectContaining({ code: 'FILE_INVALID_PACKAGE' }));
    }
  });
});
