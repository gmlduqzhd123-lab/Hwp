import { describe, expect, it } from 'vitest';
import { FONT_LANGUAGES, type SourceSpan } from '../../src/domain/document';
import { createFormatResolver } from '../../src/engine/inspection/formats';
import { INSPECTION_NAMESPACES as NS } from '../../src/engine/inspection/nodes';
import { indexXml, type XmlIndexedElement } from '../../src/engine/xml/index';

const headerPath = 'Contents/header.xml';
const callerSpan: SourceSpan = { entryPath: 'Contents/section0.xml', startByte: 0, endByte: 50 };
const languages = (number: string) => FONT_LANGUAGES.map((language) => `${language.toLowerCase()}="${number}"`).join(' ');
const fonts = FONT_LANGUAGES.map((language) => `<hh:fontface lang="${language}"><hh:font id="0" face="Synthetic ${language}"/></hh:fontface>`).join('');
const shape = (id = '0', height = '1100', children = '') => `<hh:charPr id="${id}" height="${height}"><hh:fontRef ${languages('0')}/><hh:ratio ${languages('100')}/><hh:spacing ${languages('0')}/><hh:relSz ${languages('100')}/><hh:offset ${languages('0')}/>${children}</hh:charPr>`;
const margins = (unit = 'HWPUNIT') => `<hh:margin><hc:intent value="-100" unit="${unit}"/><hc:left value="200" unit="${unit}"/><hc:right value="300" unit="${unit}"/><hc:prev value="400" unit="${unit}"/><hc:next value="500" unit="${unit}"/></hh:margin>`;
const paragraphShape = (children = `<hh:align horizontal="JUSTIFY"/>${margins()}<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>`) => `<hh:paraPr id="0">${children}</hh:paraPr>`;
const defaultStyles = '<hh:style id="0" type="PARA" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/>';

function setup(options: { characters?: string; paragraphs?: string; fontFaces?: string; styles?: string } = {}) {
  const xml = `<hh:head xmlns:hh="${NS.head}" xmlns:hc="${NS.core}" xmlns:hp="${NS.paragraph}"><hh:refList><hh:fontfaces>${options.fontFaces ?? fonts}</hh:fontfaces><hh:charProperties>${options.characters ?? shape()}</hh:charProperties><hh:paraProperties>${options.paragraphs ?? paragraphShape()}</hh:paraProperties><hh:styles>${options.styles ?? defaultStyles}</hh:styles></hh:refList></hh:head>`;
  const bytes = new TextEncoder().encode(xml);
  const index = indexXml(bytes);
  return { resolver: createFormatResolver({ path: headerPath, index }), bytes, index };
}

function reference(attributes: string): XmlIndexedElement {
  return indexXml(new TextEncoder().encode(`<hp:p xmlns:hp="${NS.paragraph}" ${attributes}/>`)).root;
}

describe('T-03 namespace-aware format references and exact units', () => {
  it('reads language-specific font IDs, character and paragraph values with provenance', () => {
    const { resolver, bytes } = setup();
    const character = resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan);
    const paragraph = resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan);
    expect(character.fontSize).toMatchObject({ value: 11, rawValue: '1100', rawUnit: 'HWPUNIT', unit: 'pt', reasons: [] });
    expect(character.fonts.HANGUL).toMatchObject({ value: 'Synthetic HANGUL', rawValue: '0', rawUnit: 'FONT_ID' });
    expect(character.fonts.LATIN.value).toBe('Synthetic LATIN');
    expect(character.fonts.HANGUL.source?.kind).toBe('FONT');
    expect(character.fontSize.source?.kind).toBe('CHARACTER_SHAPE');
    expect(character.ratio.HANGUL.value).toBe(100);
    expect(character.spacing.LATIN.value).toBe(0);
    expect(character.relativeSize.HANGUL.value).toBe(100);
    expect(character.offset.HANGUL.value).toBe(0);
    expect(character.reasons).toEqual([]);
    expect(paragraph.alignment.value).toBe('JUSTIFY');
    expect(paragraph.lineSpacing).toMatchObject({ value: 160, rawValue: '160', rawUnit: 'HWPUNIT', unit: '%' });
    expect(paragraph.indent.value).toBe(-1);
    expect(paragraph.leftMargin.value).toBe(2);
    expect(paragraph.rightMargin.value).toBe(3);
    expect(paragraph.beforeSpacing.value).toBe(4);
    expect(paragraph.afterSpacing.value).toBe(5);
    const span = character.fontSize.source!.sourceSpan;
    expect(new TextDecoder().decode(bytes.subarray(span.startByte, span.endByte))).toContain('<hh:charPr id="0"');
    expect(character.reference.sourceSpan).toEqual(callerSpan);
    expect(character.reference.sourceSpan).not.toBe(callerSpan);
  });

  it('uses expanded XML names with alternate prefixes and ignores qualified value decoys', () => {
    const { bytes } = setup();
    const alternate = new TextDecoder().decode(bytes).replaceAll('hh:', 'h:').replace('xmlns:hh=', 'xmlns:h=');
    const resolver = createFormatResolver({ path: headerPath, index: indexXml(new TextEncoder().encode(alternate)) });
    expect(resolver.resolveCharacter(reference('charPrIDRef="00"'), callerSpan).fontSize.value).toBe(11);
    const decoy = setup({ characters: '<hh:charPr id="0" hc:height="1200"/>' }).resolver;
    expect(decoy.resolveCharacter(reference('charPrIDRef="0"'), callerSpan).fontSize).toMatchObject({ value: null, rawValue: null, reasons: ['MISSING_FORMAT_VALUE'] });
  });

  it('keeps missing numeric fields unknown and recognizes an explicitly stored zero', () => {
    const { resolver } = setup({ characters: '<hh:charPr id="0"><hh:spacing hangul="0"/></hh:charPr>', paragraphs: '<hh:paraPr id="0"/>' });
    const character = resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan);
    expect(character.fontSize.value).toBeNull();
    expect(character.ratio.HANGUL.value).toBeNull();
    expect(character.spacing.HANGUL.value).toBe(0);
    expect(character.spacing.LATIN).toMatchObject({ value: null, rawValue: null, reasons: ['MISSING_FORMAT_VALUE'] });
    expect(resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan).leftMargin.value).toBeNull();
  });

  it.each(['', '11.5', 'NaN', 'Infinity', '-1', '0', '2147483648', '9007199254740992'])('retains invalid character height %s without manufacturing a value', (height) => {
    const { resolver } = setup({ characters: shape('0', height) });
    expect(resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan).fontSize)
      .toMatchObject({ value: null, rawValue: height, reasons: ['INVALID_FORMAT_VALUE'] });
  });

  it('reads existing out-of-UI-range values without treating the product range as the file format', () => {
    const { resolver } = setup({ characters: shape('0', '10000') });
    expect(resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan).fontSize.value).toBe(100);
  });

  it('does not use a style, ID 0, or nextStyle as a fallback for a missing direct reference', () => {
    const { resolver } = setup({ styles: `${defaultStyles}<hh:style id="1" type="PARA" charPrIDRef="1" paraPrIDRef="0" nextStyleIDRef="0"/>`, characters: shape() + shape('1', '2400') });
    const missing = reference('styleIDRef="1"');
    expect(resolver.resolveStyle(missing, callerSpan)).toMatchObject({ requestedId: '1', resolved: true, viaStyleId: null });
    expect(resolver.resolveParagraph(missing, callerSpan).reference).toMatchObject({ resolved: false, requestedId: null, reasons: ['MISSING_FORMAT_REFERENCE'] });
    expect(resolver.resolveCharacter(missing, callerSpan).fontSize.value).toBeNull();
    const direct = resolver.resolveCharacter(reference('styleIDRef="1" charPrIDRef="0"'), callerSpan);
    expect(direct.fontSize.value).toBe(11);
    expect(direct.fontSize.source?.viaStyleId).toBeNull();
    const broken = resolver.resolveCharacter(reference('styleIDRef="0" charPrIDRef="99"'), callerSpan);
    expect(broken.reference).toMatchObject({ requestedId: '99', resolved: false, reasons: ['MISSING_FORMAT_REFERENCE'] });
    expect(broken.fontSize.value).toBeNull();
  });

  it.each(['', '__proto__', '-1', '1.5', '4294967296'])('rejects an invalid format reference ID %s', (id) => {
    const { resolver } = setup();
    expect(resolver.resolveCharacter(reference(`charPrIDRef="${id}"`), callerSpan).reference)
      .toMatchObject({ requestedId: id, resolved: false, reasons: ['INVALID_FORMAT_VALUE'] });
  });

  it('marks duplicate canonical shape and style IDs ambiguous', () => {
    const { resolver } = setup({ characters: shape() + shape('00', '1200'), styles: defaultStyles + defaultStyles.replace('id="0"', 'id="00"') });
    expect(resolver.catalog.characterShapes.map((item) => item.id)).toEqual(['0', '00']);
    expect(resolver.catalog.characterShapes.every((item) => item.reasons.includes('AMBIGUOUS_FORMAT_REFERENCE'))).toBe(true);
    expect(resolver.resolveCharacter(reference('charPrIDRef="00"'), callerSpan).reference).toMatchObject({ resolved: false, reasons: ['AMBIGUOUS_FORMAT_REFERENCE'] });
    expect(resolver.resolveStyle(reference('styleIDRef="0"'), callerSpan).reasons).toEqual(['AMBIGUOUS_FORMAT_REFERENCE']);
  });

  it('does not mistake equal IDs in separate language font tables for duplicate IDs', () => {
    const { resolver } = setup();
    expect(resolver.catalog.fonts).toHaveLength(7);
    expect(resolver.catalog.fonts.every((font) => font.reasons.length === 0)).toBe(true);
    const character = resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan);
    expect(new Set(FONT_LANGUAGES.map((language) => character.fonts[language].value)).size).toBe(7);
  });

  it('reports duplicate font IDs in one language and missing font faces', () => {
    const fontFaces = '<hh:fontface lang="HANGUL"><hh:font id="0" face="Synthetic A"/><hh:font id="00" face="Synthetic B"/></hh:fontface><hh:fontface lang="LATIN"><hh:font id="0"/></hh:fontface>';
    const { resolver } = setup({ fontFaces });
    const character = resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan);
    expect(character.fonts.HANGUL).toMatchObject({ value: null, rawValue: '0', reasons: ['AMBIGUOUS_FORMAT_REFERENCE'] });
    expect(character.fonts.LATIN.reasons).toContain('MISSING_FORMAT_VALUE');
    expect(character.fonts.HANJA.reasons).toEqual(['MISSING_FORMAT_REFERENCE']);
  });

  it.each(['FIXED', 'BETWEEN_LINES', 'AT_LEAST'])('converts HWPUNIT line spacing for %s independently from PERCENT', (type) => {
    const { resolver } = setup({ paragraphs: paragraphShape(`<hh:lineSpacing type="${type}" value="1200" unit="HWPUNIT"/>`) });
    const format = resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan);
    expect(format.lineSpacingType.value).toBe(type);
    expect(format.lineSpacing).toMatchObject({ value: 12, rawValue: '1200', rawUnit: 'HWPUNIT', unit: 'pt', reasons: [] });
  });

  it('preserves CHAR values and does not invent a pt conversion', () => {
    const { resolver } = setup({ paragraphs: paragraphShape(`${margins('CHAR')}<hh:lineSpacing type="FIXED" value="200" unit="CHAR"/>`) });
    const format = resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan);
    expect(format.leftMargin).toMatchObject({ value: null, rawValue: '200', rawUnit: 'CHAR', unit: null, reasons: ['UNSUPPORTED_FORMAT'] });
    expect(format.lineSpacing).toMatchObject({ value: null, rawValue: '200', rawUnit: 'CHAR', unit: null, reasons: ['UNSUPPORTED_FORMAT'] });
    expect(format.lineSpacingType.value).toBe('FIXED');
  });

  it('reports unresolved compatibility branches without combining case and default values', () => {
    const branch = `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margins('CHAR')}<hh:lineSpacing type="PERCENT" value="175" unit="HWPUNIT"/></hp:case><hp:default>${margins()}<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/></hp:default></hp:switch>`;
    const { resolver } = setup({ paragraphs: paragraphShape(`<hh:align horizontal="LEFT"/>${branch}`) });
    const format = resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan);
    expect(format.alignment.value).toBe('LEFT');
    expect(format.lineSpacing).toMatchObject({ value: null, reasons: ['COMPATIBILITY_BRANCH'] });
    expect(format.leftMargin).toMatchObject({ value: null, reasons: ['COMPATIBILITY_BRANCH'] });
    expect(format.indent.value).toBeNull();
  });

  it('retains direct raw values as unknown when a compatibility branch also defines them', () => {
    const { resolver } = setup({ paragraphs: paragraphShape('<hh:align horizontal="LEFT"/><hp:switch><hp:default><hh:align horizontal="RIGHT"/></hp:default></hp:switch>') });
    expect(resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan).alignment)
      .toMatchObject({ value: null, rawValue: 'LEFT', reasons: ['COMPATIBILITY_BRANCH'] });
  });

  it('recognizes supported indent spelling and refuses two definitions of one property', () => {
    const { resolver } = setup({ paragraphs: paragraphShape('<hh:margin><hc:indent value="250" unit="HWPUNIT"/></hh:margin>') });
    expect(resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan).indent.value).toBe(2.5);
    const ambiguous = setup({ paragraphs: paragraphShape('<hh:margin><hc:indent value="250" unit="HWPUNIT"/><hc:intent value="100" unit="HWPUNIT"/></hh:margin>') }).resolver;
    expect(ambiguous.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan).indent.reasons).toEqual(['AMBIGUOUS_FORMAT_REFERENCE']);
  });

  it('keeps unknown modes readable as raw strings', () => {
    const { resolver } = setup({ paragraphs: paragraphShape('<hh:align horizontal="DIAGONAL"/><hh:lineSpacing type="OTHER" value="200" unit="HWPUNIT"/>') });
    const format = resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan);
    expect(format.alignment).toMatchObject({ value: null, rawValue: 'DIAGONAL', reasons: ['UNSUPPORTED_FORMAT'] });
    expect(format.lineSpacingType).toMatchObject({ value: null, rawValue: 'OTHER', reasons: ['UNSUPPORTED_FORMAT'] });
    expect(format.lineSpacing.rawValue).toBe('200');
  });

  it.each(['supscript', 'subscript'])('flags the actual hh:%s property', (name) => {
    const { resolver } = setup({ characters: shape('0', '1100', `<hh:${name}/>`) });
    const character = resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan);
    expect(character[name === 'supscript' ? 'superscript' : 'subscript']).toBe(true);
    expect(character.reasons).toContain('SUPERSCRIPT_OR_SUBSCRIPT');
  });

  it('restricts unsupported shape children and compatibility-only script flags', () => {
    const branch = '<hp:switch><hp:default><hh:supscript/></hp:default></hp:switch>';
    const { resolver } = setup({ characters: shape('0', '1100', `${branch}<hc:foreign/><hh:unrecognized/>`) });
    const character = resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan);
    expect(character.fontSize.value).toBe(11);
    expect(character.superscript).toBe(false);
    expect(character.reasons).toEqual(expect.arrayContaining(['COMPATIBILITY_BRANCH', 'UNKNOWN_NAMESPACE', 'UNKNOWN_ELEMENT']));
    expect(resolver.catalog.characterShapes[0]?.reasons).toEqual(expect.arrayContaining(['COMPATIBILITY_BRANCH', 'UNKNOWN_NAMESPACE', 'UNKNOWN_ELEMENT']));
  });

  it('bounds repeated lookups into a large duplicate-ID bucket', () => {
    const { resolver } = setup({ characters: '<hh:charPr id="0"/>'.repeat(4000) });
    const run = reference('charPrIDRef="0"');
    const first = resolver.resolveCharacter(run, callerSpan);
    let last = first;
    // A malformed package can repeat both definitions and their references.
    // The duplicate bucket must be aggregated once, not traversed per run.
    for (let count = 0; count < 50000; count += 1) last = resolver.resolveCharacter(run, callerSpan);
    expect(last.reference.reasons).toEqual(['AMBIGUOUS_FORMAT_REFERENCE']);
    expect(last.fonts).toBe(first.fonts);
    expect(resolver.catalog.characterShapes).toHaveLength(4000);
  }, 5000);

  it('shares definition values and unknown templates while retaining per-node references', () => {
    const { resolver } = setup();
    const first = resolver.resolveCharacter(reference('charPrIDRef="0"'), callerSpan);
    const second = resolver.resolveCharacter(reference('charPrIDRef="0"'), { ...callerSpan, startByte: 60, endByte: 100 });
    expect(first.fonts).toBe(second.fonts);
    expect(first.fontSize).toBe(second.fontSize);
    expect(first.reference).not.toBe(second.reference);
    expect(second.reference.sourceSpan.startByte).toBe(60);
    const missingA = resolver.resolveCharacter(reference('charPrIDRef="100"'), callerSpan);
    const missingB = resolver.resolveCharacter(reference('charPrIDRef="101"'), callerSpan);
    expect(missingA.fonts).toBe(missingB.fonts);
    expect(missingA.reference.requestedId).toBe('100');
    expect(missingB.reference.requestedId).toBe('101');
    const paragraphA = resolver.resolveParagraph(reference('paraPrIDRef="0"'), callerSpan);
    const paragraphB = resolver.resolveParagraph(reference('paraPrIDRef="00"'), callerSpan);
    expect(paragraphA.lineSpacing).toBe(paragraphB.lineSpacing);
    const clone = structuredClone([first, second]);
    expect(clone[0]?.fontSize).toBe(clone[1]?.fontSize);
  });
});
