import { describe, expect, it } from 'vitest';
import { EngineError, type ErrorCode } from '../../src/domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../src/domain/limits';
import { validateXml } from '../../src/engine/xml/validate';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

function expectCode(
  input: string | Uint8Array,
  code: ErrorCode,
  overrides: Partial<ResourceLimits> = {},
): EngineError {
  try {
    validateXml(typeof input === 'string' ? encode(input) : input, { ...RESOURCE_LIMITS, ...overrides });
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    const engineError = error as EngineError;
    expect(engineError.code).toBe(code);
    return engineError;
  }
  throw new Error('The unsafe XML unexpectedly passed validation.');
}

describe('XML grammar and encoding boundaries', () => {
  it.each([
    '', '<r>', '<r></other>', '<r/><other/>', '<r a="1" a="2"/>',
    '<unbound:r/>', '<r>&unknown;</r>', '<r>\u0000</r>', '<r>&#x110000;</r>',
    '<r><!-- unfinished', '<r><![CDATA[unfinished',
    '<r xmlns:a="urn:same" xmlns:b="urn:same" a:id="1" b:id="2"/>',
  ])('rejects malformed XML without exposing parser details (%#)', (source) => {
    expectCode(source, 'FILE_INVALID_PACKAGE');
  });

  it.each([
    new Uint8Array([0x3c, 0x72, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x72, 0x3e]),
    new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x72, 0x00, 0x2f, 0x00, 0x3e, 0x00]),
  ])('rejects malformed UTF-8 and UTF-16 bytes (%#)', (bytes) => {
    expectCode(bytes, 'XML_UNSUPPORTED');
  });

  it.each(['UTF-16', 'EUC-KR', 'ISO-8859-1'])('rejects unsupported declared encoding %s', (encoding) => {
    expectCode(`<?xml version="1.0" encoding="${encoding}"?><r/>`, 'XML_UNSUPPORTED');
  });

  it('keeps the inspected format at XML 1.0', () => {
    expectCode('<?xml version="1.1"?><r/>', 'XML_UNSUPPORTED');
  });
});

describe('XML active content and external reference rejection', () => {
  it.each([
    '<!DOCTYPE r><r/>',
    '<!DOCTYPE r SYSTEM "https://example.invalid/dtd"><r/>',
    '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
    '<!DOCTYPE r [<!ENTITY a "abc"><!ENTITY b "&a;&a;&a;">]><r>&b;</r>',
    '<!ENTITY x "unsafe"><r/>',
  ])('rejects DTD and entity declarations before expansion (%#)', (source) => {
    expectCode(source, 'XML_UNSUPPORTED');
  });

  it.each(['script', 'iframe', 'object', 'embed', 'applet'])('rejects active element %s', (local) => {
    expectCode(`<p:${local} xmlns:p="urn:custom"/>`, 'XML_UNSUPPORTED');
  });

  it('rejects the actual HWPX OLE element independently of its prefix', () => {
    expectCode('<hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">' +
      '<hp:ole binaryItemIDRef="object1" objectType="EMBEDDED"/></hp:sec>', 'XML_UNSUPPORTED');
  });

  it('rejects processing instructions that could load or execute stylesheets', () => {
    expectCode('<?xml-stylesheet href="https://example.invalid/a.xsl"?><r/>', 'XML_UNSUPPORTED');
  });

  it.each([
    'https://example.invalid/a', 'HTTP://example.invalid/a', 'ftp://example.invalid/a',
    'file:///tmp/a', 'javascript:alert(1)', 'data:text/html,test', '//example.invalid/a',
    'java&#x09;script:alert(1)', 'h&#x74;tps://example.invalid/a',
  ])('rejects external or active attribute references (%#)', (href) => {
    expectCode(`<r href="${href}"/>`, 'XML_UNSUPPORTED');
  });

  it('rejects event handler attributes even without a scheme', () => {
    expectCode('<r onclick="execute()"/>', 'XML_UNSUPPORTED');
  });

  it('returns constant messages without private document content or paths', () => {
    const marker = 'SYNTHETIC_PRIVATE_MARKER';
    const malformed = expectCode(`<r ${marker}="1"></broken>`, 'FILE_INVALID_PACKAGE');
    const unsupported = expectCode(`<r href="file:///${marker}.hwpx"/>`, 'XML_UNSUPPORTED');
    for (const error of [malformed, unsupported]) {
      expect(error.message).not.toContain(marker);
      expect(error.message).not.toContain('file:');
      expect(error.message).not.toContain('broken');
    }
  });
});

describe('XML inspection resource limits', () => {
  it('checks input bytes before allocating decoded XML', () => {
    const input = encode('<r>한글</r>');
    expectCode(input, 'RESOURCE_LIMIT', { maxXmlBytes: input.byteLength - 1 });
    expect(validateXml(input, { ...RESOURCE_LIMITS, maxXmlBytes: input.byteLength }).elements).toHaveLength(1);
  });

  it('bounds nesting and accepts the exact depth boundary', () => {
    expectCode('<r><a><b/></a></r>', 'RESOURCE_LIMIT', { maxXmlDepth: 2 });
    expect(validateXml(encode('<r><a/></r>'), { ...RESOURCE_LIMITS, maxXmlDepth: 2 }).elements).toHaveLength(2);
  });

  it('counts namespace declarations toward attribute limits', () => {
    expectCode('<r xmlns:x="urn:x" a="1"/>', 'RESOURCE_LIMIT', { maxAttributes: 1 });
    expect(validateXml(encode('<r a="1"/>'), { ...RESOURCE_LIMITS, maxAttributes: 1 }).elements).toHaveLength(1);
  });

  it('bounds inspection metadata by element count', () => {
    expectCode('<r><a/><b/></r>', 'RESOURCE_LIMIT', { maxXmlElements: 2 });
    expect(validateXml(encode('<r><a/></r>'), { ...RESOURCE_LIMITS, maxXmlElements: 2 }).elements).toHaveLength(2);
  });

  it.each([
    '<r>abcdefghi</r>', '<r a="abcdefghi"/>', '<abcdefghi/>',
    '<r><!--abcdefghi--></r>', '<r><![CDATA[abcdefghi]]></r>',
  ])('bounds individual raw text and markup tokens (%#)', (source) => {
    expectCode(source, 'RESOURCE_LIMIT', { maxXmlTextLength: 8 });
  });

  it('bounds total text even when split across elements and CDATA', () => {
    expectCode('<r>abcd<a/>efgh</r>', 'RESOURCE_LIMIT', { maxXmlTextLength: 7 });
    expectCode('<r>abcd<![CDATA[efgh]]></r>', 'RESOURCE_LIMIT', { maxXmlTextLength: 7 });
    expect(validateXml(encode('<r>abcd<a/>efgh</r>'), { ...RESOURCE_LIMITS, maxXmlTextLength: 8 }).elements)
      .toHaveLength(2);
  });
});
