import { describe, expect, it } from 'vitest';
import { attributeValue, directText, elementChildren, indexXml, type XmlIndexNode } from '../../src/engine/xml/index';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const raw = (bytes: Uint8Array, node: XmlIndexNode): string =>
  decode(bytes.subarray(node.sourceSpan.startByte, node.sourceSpan.endByte));

describe('original UTF-8 XML reading index', () => {
  it('retains QName, exact namespace, parents and mixed content order without serialization', () => {
    const source = '\ufeff<?xml version="1.0"?>\r\n<r xmlns="urn:outer" xmlns:x="urn:attribute" x:id="qualified">' +
      '한글&amp;🙂<child xmlns="" id="plain"/>tail<![CDATA[<p>그대로🙂</p>]]><!-- ignored -->end</r>\r\n';
    const bytes = encode(source);
    const original = bytes.slice();
    const index = indexXml(bytes);
    expect(index.root.qname).toBe('r');
    expect(index.root.uri).toBe('urn:outer');
    expect(index.root.parent).toBeNull();
    expect(index.root.attributes).toEqual({ 'x:id': 'qualified' });
    expect(index.root.attributeList).toEqual([{ qname: 'x:id', local: 'id', uri: 'urn:attribute', value: 'qualified' }]);
    expect(index.root.children.map(({ kind }) => kind)).toEqual(['text', 'element', 'text', 'cdata', 'text']);
    expect(elementChildren(index.root, '', 'child')[0]?.parent).toBe(index.root);
    expect(elementChildren(index.root, 'urn:outer', 'child')).toEqual([]);
    expect(directText(index.root)).toBe('한글&🙂tail<p>그대로🙂</p>end');
    expect(raw(bytes, index.root)).toBe(source.slice(source.indexOf('<r '), source.indexOf('</r>') + 4));
    expect(index.root.children.map((node) => raw(bytes, node))).toEqual([
      '한글&amp;🙂', '<child xmlns="" id="plain"/>', 'tail', '<![CDATA[<p>그대로🙂</p>]]>', 'end',
    ]);
    expect(bytes).toEqual(original);
    expect(Object.hasOwn(index, 'source')).toBe(false);
    expect(Object.hasOwn(index, 'bytes')).toBe(false);
  });

  it('normalizes literal CRLF and CR for reading while keeping numeric references and raw byte spans', () => {
    const source = '<r>첫줄\r\n둘째\r끝&#13;&#x1f642;<![CDATA[\r\n가\r나]]><c>nested</c>다음</r>';
    const bytes = encode(source);
    const index = indexXml(bytes);
    expect(directText(index.root)).toBe('첫줄\n둘째\n끝\r🙂\n가\n나다음');
    expect(raw(bytes, index.root)).toBe(source);
    expect(raw(bytes, index.root.children[0]!)).toBe('첫줄\r\n둘째\r끝&#13;&#x1f642;');
    expect(raw(bytes, index.root.children[1]!)).toBe('<![CDATA[\r\n가\r나]]>');
    expect(directText(elementChildren(index.root)[0]!)).toBe('nested');
  });

  it('keeps scoped QName rebindings separate and looks up attributes by expanded names', () => {
    const source = '<r xmlns="urn:default" xmlns:x="urn:outer" xmlns:y="urn:other" x:id="outer" y:id="other">' +
      '<x:child xmlns:x="urn:inner" id="plain" x:id="inner" xml:lang="ko"/><x:child/></r>';
    const { root, elements } = indexXml(encode(source));
    expect(attributeValue(root, 'urn:outer', 'id')).toBe('outer');
    expect(attributeValue(root, 'urn:other', 'id')).toBe('other');
    expect(attributeValue(root, '', 'id')).toBeUndefined();
    const child = elements[1]!;
    expect(child.qname).toBe('x:child');
    expect(child.uri).toBe('urn:inner');
    expect(attributeValue(child, '', 'id')).toBe('plain');
    expect(attributeValue(child, 'urn:inner', 'id')).toBe('inner');
    expect(attributeValue(child, 'urn:outer', 'id')).toBeUndefined();
    expect(attributeValue(child, 'http://www.w3.org/XML/1998/namespace', 'lang')).toBe('ko');
    expect(elements[2]?.uri).toBe('urn:outer');
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.children)).toBe(true);
    expect(Object.isFrozen(child.attributes)).toBe(true);
    expect(Object.isFrozen(child.sourceSpan)).toBe(true);
  });

  it('counts every UTF-8 width and embedded BOM as original bytes', () => {
    const source = '\ufeff<r>Aé한🙂\ufeff<c>é</c>Z</r>';
    const bytes = encode(source);
    const index = indexXml(bytes);
    const child = index.elements[1]!;
    expect(child.sourceSpan.startByte).toBe(encode(source.slice(0, source.indexOf('<c>'))).byteLength);
    expect(child.sourceSpan.endByte).toBe(encode(source.slice(0, source.indexOf('</c>') + 4)).byteLength);
    expect(raw(bytes, index.root.children[0]!)).toBe('Aé한🙂\ufeff');
    expect(raw(bytes, child)).toBe('<c>é</c>');
    expect(index.root.sourceSpan.endByte).toBe(bytes.byteLength);
  });

  it('preserves empty/self-closing elements, empty CDATA and markup-like attribute text', () => {
    const source = '<!--before--><r a="a > &lt;x> / &quot;" b=\'a > "\'><a/><b></b><![CDATA[]]></r><!--after-->';
    const bytes = encode(source);
    const index = indexXml(bytes);
    expect(index.elements.map((element) => raw(bytes, element))).toEqual([
      '<r a="a > &lt;x> / &quot;" b=\'a > "\'><a/><b></b><![CDATA[]]></r>', '<a/>', '<b></b>',
    ]);
    expect(index.root.children[2]).toMatchObject({ kind: 'cdata', text: '' });
    expect(raw(bytes, index.root.children[2]!)).toBe('<![CDATA[]]>');
  });

  it.each([4088, 4089, 4090, 4091, 4092, 4093, 4094, 4095, 4096])(
    'preserves multibyte characters, entities and CDATA across parser chunk boundaries (%s)',
    (padding) => {
      const source = '\ufeff<r>' + ' '.repeat(padding) + '🙂한&amp;&#x1f642;\r\n' +
        '<![CDATA[한🙂\r\n]]><c v="🙂&gt;한">끝</c></r>';
      const bytes = encode(source);
      const index = indexXml(bytes);
      expect(index.root.sourceSpan).toEqual({ startByte: 3, endByte: bytes.byteLength });
      expect(raw(bytes, index.root.children[0]!)).toBe(' '.repeat(padding) + '🙂한&amp;&#x1f642;\r\n');
      expect(raw(bytes, index.root.children[1]!)).toBe('<![CDATA[한🙂\r\n]]>');
      expect(raw(bytes, index.elements[1]!)).toBe('<c v="🙂&gt;한">끝</c>');
      expect(directText(index.root)).toBe(' '.repeat(padding) + '🙂한&🙂\n한🙂\n');
    },
  );

  it.each([4074, 4075, 4076, 4077, 4078, 4079, 4080, 4081, 4082, 4083, 4084])(
    'preserves CDATA content, CRLF, astral characters and closing delimiter across chunks (%s)',
    (padding) => {
      const cdata = '<![CDATA[' + ' '.repeat(padding) + '🙂한\r\n]]>';
      const bytes = encode('\ufeff<r>' + cdata + '</r>');
      const index = indexXml(bytes);
      expect(raw(bytes, index.root.children[0]!)).toBe(cdata);
      expect(directText(index.root)).toBe(' '.repeat(padding) + '🙂한\n');
    },
  );

  it.each([4081, 4082, 4083, 4084, 4085, 4086, 4087, 4088, 4089, 4090, 4091, 4092])(
    'preserves an opening CDATA delimiter across chunks (%s)',
    (padding) => {
      const source = '<r>' + ' '.repeat(padding) + '<![CDATA[끝🙂]]></r>';
      const bytes = encode(source);
      const index = indexXml(bytes);
      expect(raw(bytes, index.root.children[1]!)).toBe('<![CDATA[끝🙂]]>');
      expect(directText(index.root)).toBe(' '.repeat(padding) + '끝🙂');
    },
  );
});
