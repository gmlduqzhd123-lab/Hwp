import { describe, expect, it } from 'vitest';
import { validateXml } from '../../src/engine/xml/validate';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

describe('inert XML schema and HWPX metadata', () => {
  it.each(['schemaLocation', 'noNamespaceSchemaLocation'])(
    'reads exact XSI %s as a hint without loading the schema',
    (local) => {
      const source = `<hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hint="${XSI}" ` +
        `hint:${local}="https://schema.invalid/section.xsd"/>`;
      const input = encode(source);
      const original = input.slice();
      const root = validateXml(input).elements[0];
      expect(root?.attributes[`hint:${local}`]).toBe('https://schema.invalid/section.xsd');
      expect(input).toEqual(original);
      expect(source.slice(root?.start, root?.end)).toBe(source);
    },
  );

  it.each(['http://www.idpf.org/2007/opf', 'http://www.idpf.org/2007/opf/'])(
    'retains OPF metadata content strings in the documented namespace %s',
    (uri) => {
      const source = `<o:package xmlns:o="${uri}"><o:metadata>` +
        '<o:meta name="description" content="참고 https://example.invalid/reference &amp; 한글"/>' +
        '</o:metadata></o:package>';
      const input = encode(source);
      const original = input.slice();
      const { elements } = validateXml(input);
      expect(elements[2]?.attributes.content).toBe('참고 https://example.invalid/reference & 한글');
      expect(elements[2]?.uri).toBe(uri);
      expect(input).toEqual(original);
    },
  );

  it('keeps RDF subject and type identifiers as inert strings regardless of prefix spelling', () => {
    const source = `<graph:RDF xmlns:graph="${RDF}">` +
      '<graph:Description graph:about="https://example.invalid/document">' +
      '<graph:type graph:resource="http://www.hancom.co.kr/hwpml/2011/Document"/>' +
      '</graph:Description></graph:RDF>';
    const input = encode(source);
    const original = input.slice();
    const { elements } = validateXml(input);
    expect(elements[1]?.attributes['graph:about']).toBe('https://example.invalid/document');
    expect(elements[2]?.attributes['graph:resource']).toBe('http://www.hancom.co.kr/hwpml/2011/Document');
    expect(input).toEqual(original);
  });
});
