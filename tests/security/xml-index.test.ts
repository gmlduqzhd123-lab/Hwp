import { describe, expect, it } from 'vitest';
import { EngineError } from '../../src/domain/errors';
import { RESOURCE_LIMITS } from '../../src/domain/limits';
import { indexXml } from '../../src/engine/xml/index';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

describe('XML reading index uses the established security gate', () => {
  it.each([
    ['<!DOCTYPE r [<!ENTITY e SYSTEM "https://outside.invalid/PRIVATE_XML_MARKER">]><r>&e;</r>', 'XML_UNSUPPORTED', 'DTD'],
    ['<r onclick="PRIVATE_XML_MARKER"/>', 'XML_UNSUPPORTED', 'EVENT_ATTRIBUTE'],
    ['<r><script>PRIVATE_XML_MARKER</script></r>', 'XML_UNSUPPORTED', 'ACTIVE_CONTENT'],
    ['<r src="https://outside.invalid/PRIVATE_XML_MARKER"/>', 'XML_UNSUPPORTED', 'EXTERNAL_REFERENCE'],
    ['<r><a></r>', 'FILE_INVALID_PACKAGE', undefined],
  ])('rejects unsafe input before exposing an index (%#)', (source, code, reason) => {
    const bytes = encode(source!);
    const original = bytes.slice();
    try {
      indexXml(bytes);
      expect.fail('Unsafe XML unexpectedly produced a reading index.');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe(code);
      expect((error as EngineError).xmlReason).toBe(reason);
      expect((error as Error).message).not.toContain('PRIVATE_XML_MARKER');
    }
    expect(bytes).toEqual(original);
  });

  it('bounds retained text nodes as well as elements using the existing node resource limit', () => {
    const bytes = encode('<r>one<!-- split -->two<![CDATA[three]]></r>');
    const original = bytes.slice();
    expect(() => indexXml(bytes, { ...RESOURCE_LIMITS, maxXmlElements: 3 }))
      .toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    expect(indexXml(bytes, { ...RESOURCE_LIMITS, maxXmlElements: 4 }).root.children).toHaveLength(3);
    expect(bytes).toEqual(original);
  });

  it.each(['maxXmlDepth', 'maxXmlBytes', 'maxXmlTextLength', 'maxAttributes'] as const)(
    'preserves the existing %s bound',
    (key) => {
      const bytes = encode('<r a="1" b="2"><c>text</c></r>');
      expect(() => indexXml(bytes, { ...RESOURCE_LIMITS, [key]: 1 }))
        .toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    },
  );

  it('rejects invalid UTF-8 and invalid numeric resource limits before indexing', () => {
    expect(() => indexXml(new Uint8Array([0xc3, 0x28])))
      .toThrow(expect.objectContaining({ code: 'XML_UNSUPPORTED', xmlReason: 'ENCODING' }));
    expect(() => indexXml(encode('<r/>'), { ...RESOURCE_LIMITS, maxXmlBytes: Number.NaN }))
      .toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    expect(() => indexXml(encode('<r/>'), { ...RESOURCE_LIMITS, maxXmlElements: Number.NaN }))
      .toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });

  it('treats encoded markup as plain reading text and never active XML', () => {
    const { root } = indexXml(encode('<r>&lt;script&gt;PRIVATE_XML_MARKER&lt;/script&gt;<![CDATA[<script/>]]></r>'));
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ kind: 'text', text: '<script>PRIVATE_XML_MARKER</script>' });
    expect(root.children[1]).toMatchObject({ kind: 'cdata', text: '<script/>' });
  });
});
