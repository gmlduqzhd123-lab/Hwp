import { describe, expect, it } from 'vitest';
import { validateXml } from '../../src/engine/xml/validate';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

describe('namespace and XML source-span regressions', () => {
  it('keeps rebound namespace attributes separate without altering their original QName', () => {
    const source = '<r xmlns:x="urn:outer" xmlns:y="urn:other" x:id="1" y:id="2">' +
      '<x:child xmlns:x="urn:inner" id="plain" x:id="qualified"/>' +
      '<x:child id="sibling"/></r>';
    const { elements } = validateXml(encode(source));
    expect(elements[0]?.attributes).toEqual({ 'x:id': '1', 'y:id': '2' });
    expect(elements[1]?.uri).toBe('urn:inner');
    expect(elements[1]?.attributes).toEqual({ id: 'plain', 'x:id': 'qualified' });
    expect(elements[2]?.uri).toBe('urn:outer');
    expect(elements[2]?.attributes.id).toBe('sibling');
  });

  it('allows a default namespace to be cleared for an unqualified child', () => {
    const { elements } = validateXml(encode('<r xmlns="urn:root"><child xmlns="" id="1"/></r>'));
    expect(elements[0]?.uri).toBe('urn:root');
    expect(elements[1]?.uri).toBe('');
    expect(elements[1]?.attributes.id).toBe('1');
  });

  it.each([4089, 4090, 4091, 4092, 4093, 4094, 4095, 4096])(
    'uses original character offsets across CRLF and chunk boundaries (%s padding)',
    (padding) => {
      const source = '\ufeff<r>' + ' '.repeat(padding) + '\r\n<a value="한글&gt;🙂"/>\r\n</r>';
      const input = encode(source);
      const original = input.slice();
      const { elements } = validateXml(input);
      const child = elements[1];
      expect(child?.start).toBe(source.indexOf('<a'));
      expect(source.slice(child?.start, child?.end)).toBe('<a value="한글&gt;🙂"/>');
      expect(elements[0]?.start).toBe(1);
      expect(elements[0]?.end).toBe(source.length);
      expect(input).toEqual(original);
    },
  );

  it('does not mistake declarations inside inert token segments for active markup', () => {
    const source = '<r a="&lt;!DOCTYPE inert&gt;">' +
      '<!-- <?xml-stylesheet href="https://outside.invalid"?> -->' +
      '<![CDATA[<!ENTITY inert "ignored">]]>' +
      '&lt;script&gt;</r>';
    const { elements } = validateXml(encode(source));
    expect(elements).toHaveLength(1);
    expect(elements[0]?.attributes.a).toBe('<!DOCTYPE inert>');
    expect(source.slice(elements[0]?.start, elements[0]?.end)).toBe(source);
  });
});
