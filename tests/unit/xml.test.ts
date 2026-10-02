import { describe, expect, it } from 'vitest';
import { validateXml } from '../../src/engine/xml/validate';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

describe('namespace-aware XML inspection', () => {
  it('reads the root and package attributes independently of prefix spelling', () => {
    const { elements } = validateXml(encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<other:container xmlns:other="urn:container">' +
      '<other:rootfile full-path="Contents/content.hpf"/>' +
      '</other:container>',
    ));
    expect(elements.map(({ local, uri }) => ({ local, uri }))).toEqual([
      { local: 'container', uri: 'urn:container' },
      { local: 'rootfile', uri: 'urn:container' },
    ]);
    expect(elements[1]?.attributes['full-path']).toBe('Contents/content.hpf');
    expect(elements[0]?.attributes).toEqual({});
  });

  it('decodes predefined entities and preserves unqualified manifest attributes', () => {
    const { elements } = validateXml(encode(
      '<package xmlns="urn:opf"><item id="sec0" href="section0.xml" ' +
      'media-type="application/xml" label="한글 &amp; &quot;🙂&quot;"/>' +
      '<itemref idref="sec0"/></package>',
    ));
    expect(elements[1]?.attributes).toEqual({
      id: 'sec0', href: 'section0.xml', 'media-type': 'application/xml', label: '한글 & "🙂"',
    });
    expect(elements[2]?.attributes.idref).toBe('sec0');
  });

  it('keeps qualified attributes separate from package identity attributes', () => {
    const root = validateXml(encode('<r xmlns:x="urn:extra" id="trusted" x:id="other"/>')).elements[0];
    expect(root?.attributes.id).toBe('trusted');
    expect(root?.attributes['x:id']).toBe('other');
  });

  it('retains original character spans without modifying source bytes', () => {
    const source = '\ufeff<r>한글🙂<a id="1"/></r>';
    const bytes = encode(source);
    const before = bytes.slice();
    const { elements } = validateXml(bytes);
    expect(elements[0]?.start).toBe(1);
    expect(elements[0]?.end).toBe(source.length);
    const child = elements[1];
    expect(child?.start).toBe(source.indexOf('<a'));
    expect(source.slice(child?.start, child?.end)).toBe('<a id="1"/>');
    expect(child?.start).not.toBe(encode(source.slice(0, child?.start)).byteLength);
    expect(bytes).toEqual(before);
  });

  it('handles supplementary characters split across parser chunks', () => {
    const source = `<r>${'가'.repeat(4092)}🙂<a/></r>`;
    const { elements } = validateXml(encode(source));
    expect(elements[1]?.start).toBe(source.indexOf('<a'));
    expect(elements[0]?.end).toBe(source.length);
  });

  it('treats markup examples inside comments, CDATA and escaped text as inert data', () => {
    const document = validateXml(encode(
      '<r><!-- <!DOCTYPE r SYSTEM "https://example.invalid/"> -->' +
      '<![CDATA[<!ENTITY a "b"> <script>]]>&lt;script&gt;</r>',
    ));
    expect(document.elements.map((element) => element.local)).toEqual(['r']);
  });

  it('does not resolve namespace declaration URIs', () => {
    expect(validateXml(encode('<r xmlns="https://example.invalid/ns"/>')).elements[0]?.uri)
      .toBe('https://example.invalid/ns');
  });

  it('retains prototype-like names as plain own attribute values', () => {
    const attributes = validateXml(encode('<r __proto__="safe" constructor="also-safe"/>'))
      .elements[0]?.attributes;
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(attributes?.__proto__).toBe('safe');
    expect(attributes?.constructor).toBe('also-safe');
  });
});
