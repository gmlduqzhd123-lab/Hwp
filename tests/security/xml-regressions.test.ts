import { describe, expect, it } from 'vitest';
import { EngineError, type ErrorCode } from '../../src/domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../../src/domain/limits';
import { validateXml } from '../../src/engine/xml/validate';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

function rejected(
  source: string,
  code: ErrorCode,
  overrides: Partial<ResourceLimits> = {},
): void {
  const input = encode(source);
  const original = input.slice();
  try {
    validateXml(input, { ...RESOURCE_LIMITS, ...overrides });
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('PRIVATE_REGRESSION_MARKER');
    expect(input).toEqual(original);
    return;
  }
  throw new Error('The unsafe XML unexpectedly passed validation.');
}

describe('XML namespace identity regressions', () => {
  it.each([
    ' xmlns=" urn:PRIVATE_REGRESSION_MARKER "',
    ' xmlns="&#x09;urn:PRIVATE_REGRESSION_MARKER"',
    ' xmlns="urn:PRIVATE_REGRESSION_MARKER&#x0a;"',
    ' xmlns="&#xFEFF;urn:PRIVATE_REGRESSION_MARKER"',
    ' xmlns:x=" urn:PRIVATE_REGRESSION_MARKER"',
  ])('rejects namespace bindings whose identity the parser would trim (%#)', (declaration) => {
    const name = declaration.includes('xmlns:x') ? 'x:r' : 'r';
    rejected(`<${name}${declaration}/>`, 'XML_UNSUPPORTED');
  });

  it('rejects a whitespace-disguised trusted HWPX namespace', () => {
    rejected('<container xmlns=" urn:oasis:names:tc:opendocument:xmlns:container "/>', 'XML_UNSUPPORTED');
  });

  it.each([
    '<r xmlns:xml="urn:PRIVATE_REGRESSION_MARKER"/>',
    '<r xmlns:x="http://www.w3.org/2000/xmlns/"/>',
    '<r xmlns:x="urn:same" xmlns:y="urn:same" x:id="1" y:id="2"/>',
    '<r xmlns:x="urn:bound"><x:c xmlns:x=""/></r>',
  ])('keeps reserved bindings and expanded attribute duplicates invalid (%#)', (source) => {
    rejected(source, 'FILE_INVALID_PACKAGE');
  });
});

describe('external XML network-path regressions', () => {
  it.each([
    '\\\\outside.invalid\\PRIVATE_REGRESSION_MARKER',
    '/\\outside.invalid/PRIVATE_REGRESSION_MARKER',
    '\\/outside.invalid/PRIVATE_REGRESSION_MARKER',
    '&#x5c;&#x5c;outside.invalid/PRIVATE_REGRESSION_MARKER',
    '&#x2f;&#x5c;outside.invalid/PRIVATE_REGRESSION_MARKER',
    '&#x09;\\\\outside.invalid/PRIVATE_REGRESSION_MARKER',
  ])('rejects UNC and mixed-slash external attribute references (%#)', (value) => {
    rejected(`<r href="${value}"/>`, 'XML_UNSUPPORTED');
  });

  it('recognizes the same network-path interpretation as the browser URL parser', () => {
    for (const value of ['\\\\outside.invalid/r', '/\\outside.invalid/r', '\\/outside.invalid/r']) {
      expect(new URL(value, 'https://local.invalid/').origin).toBe('https://outside.invalid');
      rejected(`<r href="${value}"/>`, 'XML_UNSUPPORTED');
    }
  });
});

describe('direct XML resource configuration regressions', () => {
  const fields = ['maxXmlBytes', 'maxXmlDepth', 'maxAttributes', 'maxXmlTextLength', 'maxXmlElements'] as const;

  it.each(fields)('does not let NaN silently disable %s', (field) => {
    rejected('<r/>', 'RESOURCE_LIMIT', { [field]: Number.NaN });
  });

  it.each([0, -1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'requires finite, positive, safe integer XML bounds (%#)',
    (maxXmlDepth) => rejected('<r/>', 'RESOURCE_LIMIT', { maxXmlDepth }),
  );

  it('does not let an unstable configuration getter disable depth midway through inspection', () => {
    let reads = 0;
    const limits = {
      ...RESOURCE_LIMITS,
      get maxXmlDepth() {
        reads += 1;
        return reads === 1 ? 1 : Number.NaN;
      },
    };
    let failure: unknown;
    try {
      validateXml(encode('<r><child/></r>'), limits);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EngineError);
    expect((failure as EngineError).code).toBe('RESOURCE_LIMIT');
  });
});

describe('XML token segmentation security regressions', () => {
  it('counts text separated by comments and CDATA toward the same total', () => {
    rejected('<r>abcd<!--x-->efgh<![CDATA[ijkl]]></r>', 'RESOURCE_LIMIT', { maxXmlTextLength: 11 });
  });

  it('rejects a DTD after a long inert comment without confusing their scopes', () => {
    rejected(`<!--${'x'.repeat(4094)}--><!DOCTYPE r SYSTEM "https://outside.invalid/PRIVATE_REGRESSION_MARKER"><r/>`,
      'XML_UNSUPPORTED');
  });

  it('rejects a real processing instruction surrounded by inert examples', () => {
    rejected('<r><![CDATA[<?xml-stylesheet harmless?>]]><!-- <?x harmless?> -->' +
      '<?xml-stylesheet href="PRIVATE_REGRESSION_MARKER"?></r>', 'XML_UNSUPPORTED');
  });
});
