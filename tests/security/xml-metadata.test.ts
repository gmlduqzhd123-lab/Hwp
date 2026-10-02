import { describe, expect, it } from 'vitest';
import { EngineError, type XmlUnsupportedReason } from '../../src/domain/errors';
import { validateXml } from '../../src/engine/xml/validate';

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const OPF = 'http://www.idpf.org/2007/opf/';
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const URL = 'https://outside.invalid/PRIVATE_METADATA_MARKER';

function rejected(input: string | Uint8Array, reason: XmlUnsupportedReason): void {
  const bytes = typeof input === 'string' ? encode(input) : input;
  const original = bytes.slice();
  try {
    validateXml(bytes);
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    expect(error.code).toBe('XML_UNSUPPORTED');
    expect(error.xmlReason).toBe(reason);
    expect(error.message).not.toContain('PRIVATE_METADATA_MARKER');
    expect(error.message).not.toContain('outside.invalid');
    expect(bytes).toEqual(original);
    return;
  }
  throw new Error('The unsafe XML unexpectedly passed validation.');
}

describe('inert metadata cannot grant a general external resource exception', () => {
  it.each([
    `<r schemaLocation="${URL}"/>`,
    `<r xmlns:xsi="urn:spoof" xsi:schemaLocation="${URL}"/>`,
    `<r xmlns:xsi="${XSI}/" xsi:schemaLocation="${URL}"/>`,
    `<r xmlns:xsi="${XSI}" xsi:href="${URL}"/>`,
    `<r xmlns:xsi="${XSI}" xsi:schemaLocation="${URL}" src="${URL}"/>`,
  ])('requires the exact XSI namespace and hint attribute (%#)', (source) => {
    rejected(source, 'EXTERNAL_REFERENCE');
  });

  it.each([
    `<metadata><meta content="${URL}"/></metadata>`,
    `<o:metadata xmlns:o="${OPF}spoof"><o:meta content="${URL}"/></o:metadata>`,
    `<o:package xmlns:o="${OPF}"><o:meta content="${URL}"/></o:package>`,
    `<o:metadata xmlns:o="${OPF}"><o:meta xmlns:o="http://www.idpf.org/2007/opf" content="${URL}"/></o:metadata>`,
    `<o:metadata xmlns:o="${OPF}" xmlns:x="urn:spoof"><o:meta x:content="${URL}"/></o:metadata>`,
    `<o:metadata xmlns:o="${OPF}"><o:meta content="plain" href="${URL}"/></o:metadata>`,
  ])('limits the OPF exception to direct metadata content in the same exact namespace (%#)', (source) => {
    rejected(source, 'EXTERNAL_REFERENCE');
  });

  it.each([
    `<r xmlns:rdf="${RDF}"><rdf:Description rdf:about="${URL}"/></r>`,
    `<rdf:RDF xmlns:rdf="urn:spoof"><rdf:Description rdf:about="${URL}"/></rdf:RDF>`,
    `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description about="${URL}"/></rdf:RDF>`,
    `<rdf:RDF xmlns:rdf="${RDF}" xmlns:x="urn:spoof"><rdf:Description x:about="${URL}"/></rdf:RDF>`,
    `<rdf:RDF xmlns:rdf="${RDF}"><rdf:type rdf:resource="${URL}"/></rdf:RDF>`,
    `<rdf:RDF xmlns:rdf="${RDF}"><rdf:Description><rdf:type resource="${URL}"/></rdf:Description></rdf:RDF>`,
    `<rdf:RDF xmlns:rdf="${RDF}" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><rdf:Description><hp:img rdf:resource="${URL}"/></rdf:Description></rdf:RDF>`,
  ])('limits the RDF exception to exact subject/type identifier roles (%#)', (source) => {
    rejected(source, 'EXTERNAL_REFERENCE');
  });

  it.each([
    `<hp:switch xmlns:hp="urn:spoof"><hp:case hp:required-namespace="${URL}"/></hp:switch>`,
    `<hp:switch xmlns:hp="${HP}" xmlns:x="urn:spoof"><x:case hp:required-namespace="${URL}"/></hp:switch>`,
    `<x:switch xmlns:x="urn:spoof" xmlns:hp="${HP}"><hp:case hp:required-namespace="${URL}"/></x:switch>`,
    `<hp:p xmlns:hp="${HP}"><hp:case hp:required-namespace="${URL}"/></hp:p>`,
    `<hp:case xmlns:hp="${HP}" hp:required-namespace="${URL}"/>`,
    `<hp:switch xmlns:hp="${HP}"><hp:case required-namespace="${URL}"/></hp:switch>`,
    `<hp:switch xmlns:hp="${HP}" xmlns:x="urn:spoof"><hp:case x:required-namespace="${URL}"/></hp:switch>`,
    `<hp:switch xmlns:hp="${HP}"><hp:default hp:required-namespace="${URL}"/></hp:switch>`,
    `<hp:switch xmlns:hp="${HP}"><hp:p hp:required-namespace="${URL}"/></hp:switch>`,
    `<hp:switch xmlns:hp="${HP}"><hp:p><hp:case hp:required-namespace="${URL}"/></hp:p></hp:switch>`,
    `<hp:switch xmlns:hp="${HP}"><hp:case hp:required-namespace="${URL}" href="${URL}"/></hp:switch>`,
    `<hp:switch xmlns:hp="${HP}"><hp:case hp:required-namespace="${URL}" src="${URL}"/></hp:switch>`,
  ])('limits HWPX namespace selectors to the exact qualified case attribute and direct switch parent (%#)', (source) => {
    rejected(source, 'EXTERNAL_REFERENCE');
  });

  it('inspects active content and resource references inside every switch branch', () => {
    rejected(`<hp:switch xmlns:hp="${HP}"><hp:case hp:required-namespace="${URL}">` +
      '<hp:script/></hp:case></hp:switch>', 'ACTIVE_CONTENT');
    rejected(`<hp:switch xmlns:hp="${HP}"><hp:case hp:required-namespace="${URL}" onclick="execute()"/>` +
      '</hp:switch>', 'EVENT_ATTRIBUTE');
    rejected(`<hp:switch xmlns:hp="${HP}"><hp:case hp:required-namespace="${URL}"/>` +
      `<hp:default><hp:img src="${URL}"/></hp:default></hp:switch>`, 'EXTERNAL_REFERENCE');
  });

  it('keeps prefixed external resource attributes blocked even when their spelling resembles metadata', () => {
    rejected(`<r xmlns:link="http://www.w3.org/1999/xlink" link:href="${URL}"/>`, 'EXTERNAL_REFERENCE');
    rejected(`<r xmlns:link="urn:spoof" link:href="${URL}"/>`, 'EXTERNAL_REFERENCE');
    rejected(`<r src="\\\\outside.invalid\\PRIVATE_METADATA_MARKER"/>`, 'EXTERNAL_REFERENCE');
  });

  it('continues to reject active elements and event attributes in otherwise inert contexts', () => {
    rejected(`<o:metadata xmlns:o="${OPF}" xmlns:xsi="${XSI}">` +
      `<script xsi:schemaLocation="${URL}"/></o:metadata>`, 'ACTIVE_CONTENT');
    rejected(`<o:metadata xmlns:o="${OPF}"><o:meta content="${URL}" onclick="execute()"/></o:metadata>`,
      'EVENT_ATTRIBUTE');
  });
});

describe('XML rejection reasons are fixed metadata without document excerpts', () => {
  const cases: Array<[string | Uint8Array, XmlUnsupportedReason]> = [
    [new Uint8Array([0xc3, 0x28]), 'ENCODING'],
    ['<?xml version="1.0" encoding="UTF-16"?><r/>', 'ENCODING'],
    ['<?xml version="1.1"?><r/>', 'XML_VERSION'],
    [`<!DOCTYPE r SYSTEM "${URL}"><r/>`, 'DTD'],
    [`<?xml-stylesheet href="${URL}"?><r/>`, 'PROCESSING_INSTRUCTION'],
    ['<r xmlns=" urn:PRIVATE_METADATA_MARKER "/>', 'NAMESPACE'],
    ['<r><ole/></r>', 'ACTIVE_CONTENT'],
    ['<r onclick="PRIVATE_METADATA_MARKER"/>', 'EVENT_ATTRIBUTE'],
    [`<r href="${URL}"/>`, 'EXTERNAL_REFERENCE'],
  ];

  it.each(cases)('reports the registered reason for an unsupported XML case (%#)', (source, reason) => {
    rejected(source, reason);
  });
});
