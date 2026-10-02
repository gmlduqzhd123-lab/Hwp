import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { EngineError, ERROR_MESSAGES, safeError, type ErrorCode } from '../../src/domain/errors';
import { isPlainTextInput } from '../../src/domain/plain-text';
import { DRAFT_LIMITS, DRAFT_SOURCE_ID_BASE } from '../../src/domain/research';
import { createPlainTextSource } from '../../src/engine/plain-text';
import { inspectHwpx } from '../../src/engine/preflight';
import { createInspectionSession } from '../../src/engine/session';
import { indexXml } from '../../src/engine/xml/index';
import { isPlainTextReadyResponse, PROTOCOL_VERSION, type PlainTextResponse } from '../../src/workers/protocol';

const PRIVATE_MARKER = 'SYNTHETIC_PRIVATE_TYPED_SOURCE';
const decoder = new TextDecoder('utf-8', { fatal: true });
const responseText = '합성 입력 원고\n둘째 문단\t  ';
let validResponse: PlainTextResponse;

beforeAll(async () => {
  const bytes = await createPlainTextSource(responseText);
  const { report, inspection } = await inspectHwpx(bytes, 'synthetic-response.hwpx');
  validResponse = { type: 'TEXT_READY', protocolVersion: PROTOCOL_VERSION, jobId: 'text_1',
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), report, inspection };
});

async function rejected(input: unknown, code: ErrorCode): Promise<void> {
  let returnedBytes: Uint8Array | undefined;
  const failure = await createPlainTextSource(input).then(
    (bytes) => { returnedBytes = bytes; return undefined; },
    (error: unknown) => error,
  );
  expect(returnedBytes).toBeUndefined();
  expect(failure).toBeInstanceOf(EngineError);
  expect(safeError(failure)).toEqual({ code, message: ERROR_MESSAGES[code] });
  expect(JSON.stringify(safeError(failure))).not.toContain(PRIVATE_MARKER);
}

describe('directly entered text is bounded data', () => {
  it.each([undefined, null, false, 1, {}, ['합성 원고'], new Uint8Array([1])])(
    'rejects non-string inputs at both the guard and actual engine boundary (%#)',
    async (input) => {
      expect(isPlainTextInput(input)).toBe(false);
      await rejected(input, 'FILE_INVALID_PACKAGE');
    },
  );

  it('does not invoke object coercion while rejecting a forged text value', async () => {
    const toString = vi.fn(() => PRIVATE_MARKER);
    const value = { toString };
    expect(isPlainTextInput(value)).toBe(false);
    await rejected(value, 'FILE_INVALID_PACKAGE');
    expect(toString).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '\t\n\r'])('never returns a successful blank source (%#)', async (input) => {
    expect(isPlainTextInput(input)).toBe(false);
    await rejected(input, 'FILE_INVALID_PACKAGE');
  });

  it('rejects character overflow before creating a package or reflecting source text', async () => {
    const input = PRIVATE_MARKER + '한'.repeat(DRAFT_LIMITS.maxTextCharacters);
    expect(isPlainTextInput(input)).toBe(false);
    await rejected(input, 'RESOURCE_LIMIT');
  });

  it('counts blank and trailing lines when reserving the generated carrier paragraph', async () => {
    const input = PRIVATE_MARKER + '\n'.repeat(DRAFT_LIMITS.maxParagraphs - 1);
    expect(isPlainTextInput(input)).toBe(false);
    await rejected(input, 'RESOURCE_LIMIT');
  });

  it('accepts the exact character boundary through real output and independent inspection', async () => {
    const text = '한'.repeat(DRAFT_LIMITS.maxTextCharacters);
    expect(isPlainTextInput(text)).toBe(true);
    const bytes = await createPlainTextSource(text);
    const { inspection } = await inspectHwpx(bytes, 'synthetic-text-boundary.hwpx');
    expect(inspection.paragraphs.map((paragraph) => paragraph.text)).toEqual(['', text]);
  });

  it('accepts all 1,999 typed lines without dropping duplicate or empty paragraphs', async () => {
    const lines = Array.from({ length: DRAFT_LIMITS.maxParagraphs - 1 }, (_, ordinal) => ordinal % 3 === 0 ? '' : '동일한 합성 문단');
    const text = lines.join('\n');
    expect(isPlainTextInput(text)).toBe(true);
    const bytes = await createPlainTextSource(text);
    const { inspection } = await inspectHwpx(bytes, 'synthetic-lines-boundary.hwpx');
    expect(inspection.paragraphs).toHaveLength(DRAFT_LIMITS.maxParagraphs);
    expect(inspection.paragraphs.slice(1).map((paragraph) => paragraph.text)).toEqual(lines);
    expect(inspection.paragraphs.slice(1).map((paragraph) => paragraph.sourceId))
      .toEqual(lines.map((_, ordinal) => String(DRAFT_SOURCE_ID_BASE + ordinal)));
  });

  it.each(['\u0000', '\u0001', '\u000b', '\u001f', '\ud800', '\udfff', '\ufffe', '\uffff'])
    ('rejects non-XML Unicode rather than silently replacing characters (%#)', async (character) => {
      await rejected(`${PRIVATE_MARKER}${character}`, 'FILE_INVALID_PACKAGE');
    });

  it('also enforces generated XML limits for token-expanding but character-bounded text', async () => {
    const text = PRIVATE_MARKER + '\t'.repeat(100_001);
    expect(isPlainTextInput(text)).toBe(true);
    await rejected(text, 'RESOURCE_LIMIT');
  });
});

describe('literal text creates a private inspected HWPX source', () => {
  it('preserves whitespace, CR/LF, tabs, literal entities, astral Unicode and blank lines', async () => {
    const text = '\n  합성 한글🙂\t내용 &amp; &#x1f642;\r\n같은 문장\n같은 문장\n\n끝 공백  \n';
    const bytes = await createPlainTextSource(text);
    const { report, inspection } = await inspectHwpx(bytes, 'synthetic-literal-text.hwpx');
    expect(report.supportLevel).toBe('INSPECT_ONLY');
    expect(inspection.paragraphs.map((paragraph) => paragraph.text)).toEqual(['', ...text.split('\n')]);
    expect(inspection.paragraphs.slice(1).map((paragraph) => paragraph.text).join('\n')).toBe(text);
    const entries = unzipSync(bytes);
    const raw = decoder.decode(entries['Contents/section0.xml']!);
    expect(raw).toContain('&amp;amp;');
    expect(raw).toContain('&amp;#x1f642;');
    expect(raw).toContain('<hp:tab/>');
    expect(raw).toContain('&#13;');
    expect(indexXml(entries['Contents/section0.xml']!).elements.some((element) => element.local === 'linesegarray')).toBe(false);
  });

  it('treats XXE, script, object, event and path-shaped input as inert text while offline', async () => {
    const text = [
      PRIVATE_MARKER,
      '<!DOCTYPE hp:sec [<!ENTITY secret SYSTEM "https://outside.invalid/synthetic">]>&secret;',
      '<?xml-stylesheet href="https://outside.invalid/synthetic.css"?>',
      '<script onclick="document.cookie">https://outside.invalid/synthetic.js</script>',
      '</hp:t></hp:run><hp:pic href="https://outside.invalid/synthetic.png"/><hp:run><hp:t>',
      '<hp:fieldBegin name="PRIVATE"/> <hp:ole/><hp:video/><hp:tbl/><hp:footNote/>',
      '../../Scripts/synthetic.js ]]> & "큰따옴표" \'작은따옴표\'',
    ].join('\n');
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected source network request.'));
    try {
      const bytes = await createPlainTextSource(text);
      const { inspection } = await inspectHwpx(bytes, 'synthetic-inert-source.hwpx');
      expect(inspection.paragraphs.slice(1).map((paragraph) => paragraph.text).join('\n')).toBe(text);
      expect(inspection.tables).toHaveLength(0);
      const entries = unzipSync(bytes);
      expect(Object.keys(entries).some((path) => /^(?:BinData|Scripts)\//iu.test(path) || path.includes('..'))).toBe(false);
      expect(entries['Preview/PrvImage.png']).toBeUndefined();
      const section = indexXml(entries['Contents/section0.xml']!);
      expect(section.elements.some((element) => ['script', 'pic', 'ole', 'video', 'tbl', 'footNote', 'fieldBegin'].includes(element.local))).toBe(false);
      expect(section.elements.some((element) => element.attributeList.some((attribute) => ['href', 'onclick'].includes(attribute.local)))).toBe(false);
      expect(decoder.decode(entries['Contents/content.hpf']!)).not.toContain(PRIVATE_MARKER);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('keeps private session bytes unchanged across output transfer and a failed replacement', async () => {
    const text = `${PRIVATE_MARKER}\n  두 번째 합성 문단\t  `;
    const bytes = await createPlainTextSource(text);
    const before = bytes.slice();
    const digest = createHash('sha256').update(before).digest('hex');
    const session = await createInspectionSession(bytes, 'synthetic-private-source.hwpx');
    const transfer = session.getWorkerBytes();
    structuredClone(transfer, { transfer: [transfer.buffer] });
    expect(transfer.byteLength).toBe(0);
    const exposedInspection = session.inspection;
    exposedInspection.paragraphs[1]!.text = '별도 합성 문장';
    bytes.fill(0);
    await rejected(`${PRIVATE_MARKER}\u0000`, 'FILE_INVALID_PACKAGE');
    expect(session.exportUnchanged()).toEqual(before);
    expect(session.originalSha256).toBe(digest);
    expect(createHash('sha256').update(session.getOriginalBytes()).digest('hex')).toBe(digest);
    expect(session.inspection.paragraphs.slice(1).map((paragraph) => paragraph.text).join('\n')).toBe(text);
  });
});

describe('text-source response acceptance stays bound to the exact entered text', () => {
  it('accepts actual independently inspected output for the exact request source', () => {
    expect(isPlainTextReadyResponse(validResponse, responseText)).toBe(true);
    expect(isPlainTextReadyResponse(validResponse, responseText + ' 추가')).toBe(false);
    expect(isPlainTextReadyResponse(validResponse, responseText.replace('  ', ' '))).toBe(false);
    expect(isPlainTextReadyResponse(validResponse, '')).toBe(false);
  });

  it.each([null, undefined, false, 1, 'TEXT_READY', []])('rejects non-response envelopes (%#)', (value) => {
    expect(isPlainTextReadyResponse(value, responseText)).toBe(false);
  });

  it.each([
    { type: 'REPORT' }, { protocolVersion: PROTOCOL_VERSION + 1 }, { jobId: '../private' },
    { jobId: '<script>' }, { jobId: 'a'.repeat(129) }, { bytes: new ArrayBuffer(0) },
    { bytes: new Uint8Array([1]) }, { bytes: new SharedArrayBuffer(4) },
    { bytes: { byteLength: 4 } }, { report: null }, { inspection: null },
  ])('rejects incomplete or invalid text-source envelopes (%#)', (change) => {
    expect(isPlainTextReadyResponse({ ...validResponse, ...change }, responseText)).toBe(false);
  });

  it.each(['altered-text', 'source-id', 'order', 'carrier', 'paragraph-context', 'paragraph-null', 'paragraph-hole'])
    ('rejects stale or falsely identified paragraphs (%#)', (change) => {
      const response = structuredClone(validResponse);
      const paragraphs = response.inspection.paragraphs;
      if (change === 'altered-text') paragraphs[1]!.text += '추가';
      if (change === 'source-id') paragraphs[1]!.sourceId = '9999';
      if (change === 'order') [paragraphs[1], paragraphs[2]] = [paragraphs[2]!, paragraphs[1]!];
      if (change === 'carrier') paragraphs[0]!.text = PRIVATE_MARKER;
      if (change === 'paragraph-context') paragraphs[1]!.context = 'TABLE_CELL';
      if (change === 'paragraph-null') (paragraphs as unknown[])[1] = null;
      if (change === 'paragraph-hole') delete (paragraphs as unknown[])[1];
      expect(isPlainTextReadyResponse(response, responseText)).toBe(false);
    });

  it.each(['table', 'row', 'cell', 'run-null', 'run-missing', 'run-reference', 'section-path', 'paragraph-format-reference', 'character-format-reference'])
    ('rejects falsely claimed object-free source structure (%#)', (change) => {
      const response = structuredClone(validResponse);
      if (change === 'table') (response.inspection.tables as unknown[]).push({});
      if (change === 'row') (response.inspection.rows as unknown[]).push({});
      if (change === 'cell') (response.inspection.cells as unknown[]).push({});
      if (change === 'run-null') (response.inspection.runs as unknown[])[1] = null;
      if (change === 'run-missing') response.inspection.runs.splice(1, 1);
      if (change === 'run-reference') response.inspection.paragraphs[1]!.runIds = ['unknown-run'];
      if (change === 'section-path') response.report.sectionPaths = ['Contents/unrelated.xml'];
      if (change === 'paragraph-format-reference') delete (response.inspection.paragraphs[1]!.paragraphFormat as unknown as Record<string, unknown>).reference;
      if (change === 'character-format-reference') delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).reference;
      expect(isPlainTextReadyResponse(response, responseText)).toBe(false);
    });

  it.each([
    ['missing-report-counts', (response: PlainTextResponse) => { response.report = { sectionPaths: [...response.report.sectionPaths] } as PlainTextResponse['report']; }],
    ['missing-entry-count', (response: PlainTextResponse) => { delete (response.report as unknown as Record<string, unknown>).entryCount; }],
    ['missing-xml-count', (response: PlainTextResponse) => { delete (response.report as unknown as Record<string, unknown>).xmlCount; }],
    ['missing-uncompressed-bytes', (response: PlainTextResponse) => { delete (response.report as unknown as Record<string, unknown>).uncompressedBytes; }],
    ['entry-count-string', (response: PlainTextResponse) => { (response.report as unknown as Record<string, unknown>).entryCount = '8'; }],
    ['entry-count-overflow', (response: PlainTextResponse) => { response.report.entryCount = 2001; }],
    ['xml-count-nan', (response: PlainTextResponse) => { response.report.xmlCount = Number.NaN; }],
    ['xml-count-negative', (response: PlainTextResponse) => { response.report.xmlCount = -1; }],
    ['xml-count-greater-than-entries', (response: PlainTextResponse) => { response.report.xmlCount = response.report.entryCount + 1; }],
    ['uncompressed-size-infinity', (response: PlainTextResponse) => { response.report.uncompressedBytes = Number.POSITIVE_INFINITY; }],
    ['uncompressed-size-fractional', (response: PlainTextResponse) => { response.report.uncompressedBytes = 1.5; }],
    ['uncompressed-size-zero', (response: PlainTextResponse) => { response.report.uncompressedBytes = 0; }],
    ['missing-format-version', (response: PlainTextResponse) => { delete (response.report as unknown as Record<string, unknown>).formatVersion; }],
    ['missing-summary', (response: PlainTextResponse) => { delete (response.inspection as unknown as Record<string, unknown>).summary; }],
    ['null-summary', (response: PlainTextResponse) => { (response.inspection as unknown as Record<string, unknown>).summary = null; }],
    ['summary-incorrect-paragraph-count', (response: PlainTextResponse) => { response.inspection.summary.paragraphCount = response.inspection.paragraphs.length + 1; }],
    ['summary-incorrect-section-count', (response: PlainTextResponse) => { response.inspection.summary.sectionCount = 0; }],
    ['summary-incorrect-run-count', (response: PlainTextResponse) => { response.inspection.summary.runCount = 0; }],
    ['summary-incorrect-table-count', (response: PlainTextResponse) => { response.inspection.summary.tableCount = 1; }],
    ['summary-incorrect-cell-count', (response: PlainTextResponse) => { response.inspection.summary.cellCount = 1; }],
    ['summary-candidate-count-string', (response: PlainTextResponse) => { (response.inspection.summary as unknown as Record<string, unknown>).correctionCandidateParagraphCount = '1'; }],
    ['paragraph-format-skeleton', (response: PlainTextResponse) => { response.inspection.paragraphs[1]!.paragraphFormat = { reference: { resolved: true } } as PlainTextResponse['inspection']['paragraphs'][number]['paragraphFormat']; }],
    ['character-format-skeleton', (response: PlainTextResponse) => { response.inspection.runs[1]!.characterFormat = { reference: { resolved: true } } as PlainTextResponse['inspection']['runs'][number]['characterFormat']; }],
    ['missing-alignment', (response: PlainTextResponse) => { delete (response.inspection.paragraphs[1]!.paragraphFormat as unknown as Record<string, unknown>).alignment; }],
    ['null-line-spacing', (response: PlainTextResponse) => { (response.inspection.paragraphs[1]!.paragraphFormat as unknown as Record<string, unknown>).lineSpacing = null; }],
    ['missing-font-map', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).fonts; }],
    ['missing-font-language', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat.fonts as unknown as Record<string, unknown>).HANGUL; }],
    ['null-font-language', (response: PlainTextResponse) => { (response.inspection.runs[1]!.characterFormat.fonts as unknown as Record<string, unknown>).LATIN = null; }],
    ['missing-ratio-map', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).ratio; }],
    ['missing-spacing-map', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).spacing; }],
    ['missing-relative-size-map', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).relativeSize; }],
    ['missing-offset-map', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).offset; }],
    ['missing-font-size', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).fontSize; }],
    ['missing-paragraph-reasons', (response: PlainTextResponse) => { delete (response.inspection.paragraphs[1]! as unknown as Record<string, unknown>).reasons; }],
    ['null-run-reasons', (response: PlainTextResponse) => { (response.inspection.runs[1]! as unknown as Record<string, unknown>).reasons = null; }],
    ['missing-paragraph-format-reasons', (response: PlainTextResponse) => { delete (response.inspection.paragraphs[1]!.paragraphFormat as unknown as Record<string, unknown>).reasons; }],
    ['missing-character-format-reasons', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat as unknown as Record<string, unknown>).reasons; }],
    ['missing-style-reference-reasons', (response: PlainTextResponse) => { delete (response.inspection.paragraphs[1]!.styleReference as unknown as Record<string, unknown>).reasons; }],
    ['missing-paragraph-reference-reasons', (response: PlainTextResponse) => { delete (response.inspection.paragraphs[1]!.paragraphFormat.reference as unknown as Record<string, unknown>).reasons; }],
    ['missing-character-reference-reasons', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.characterFormat.reference as unknown as Record<string, unknown>).reasons; }],
    ['sparse-segments', (response: PlainTextResponse) => { delete (response.inspection.runs[1]!.segments as unknown[])[0]; }],
    ['unknown-segment-kind', (response: PlainTextResponse) => { (response.inspection.runs[1]!.segments[0]! as unknown as Record<string, unknown>).kind = 'SCRIPT'; }],
    ['segment-text-mismatch', (response: PlainTextResponse) => { response.inspection.runs[1]!.segments[0]!.text += PRIVATE_MARKER; }],
  ] as const)('rejects incomplete inspection data before replacing the active source: %s', (_, mutate) => {
    const response = structuredClone(validResponse);
    mutate(response);
    expect(isPlainTextReadyResponse(response, responseText)).toBe(false);
  });
});
