import { createHash } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { describe, expect, it } from 'vitest';
import type { DraftRole, ResearchDraftKind, ResearchDraftOptions } from '../../src/domain/research';
import { createResearchDraft } from '../../src/engine/draft';
import { recommendDraft } from '../../src/engine/draft/plan';
import { inspectHwpx } from '../../src/engine/preflight';
import { createInspectionSession } from '../../src/engine/session';
import { makeResearchFixture } from '../helpers/research-fixture';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HH = 'http://www.hancom.co.kr/hwpml/2011/head';
const HC = 'http://www.hancom.co.kr/hwpml/2011/core';
const CORRECTED_ROLES: DraftRole[] = ['summary', 'reflection', 'need', 'results', 'design', 'practice', 'results', 'reflection', 'references', 'appendix'];
const FONT_LANGUAGES = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const decoder = new TextDecoder('utf-8', { fatal: true });

interface XmlNode {
  uri: string;
  local: string;
  attributes: Record<string, string>;
  content: Array<XmlNode | string>;
}

/** Independent library reader for the serialized ZIP, without the engine XML index. */
function xml(bytes: Uint8Array): XmlNode {
  let root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    const node: XmlNode = {
      uri: tag.uri, local: tag.local,
      attributes: Object.fromEntries(Object.values(tag.attributes).filter((attribute) => attribute.uri === '').map((attribute) => [attribute.local, attribute.value])),
      content: [],
    };
    stack.at(-1)?.content.push(node);
    root ??= node;
    stack.push(node);
  });
  const text = (value: string) => { stack.at(-1)?.content.push(value); };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(decoder.decode(bytes)).close();
  if (!root) throw new Error('Expected a serialized XML root.');
  return root;
}

function descendants(node: XmlNode, uri: string, local: string): XmlNode[] {
  return [node, ...node.content.flatMap((child) => typeof child === 'string' ? [] : descendants(child, uri, local))]
    .filter((child) => child.uri === uri && child.local === local);
}

function only(nodes: XmlNode[]): XmlNode {
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function paragraphText(node: XmlNode, inText = false): string {
  if (node.uri === HP && node.local === 'tab') return '\t';
  if (node.uri === HP && node.local === 'lineBreak') return '\n';
  const text = inText || (node.uri === HP && node.local === 't');
  return node.content.map((child) => typeof child === 'string' ? (text ? child : '') : paragraphText(child, text)).join('');
}

function component(entries: Record<string, Uint8Array>, path: string): XmlNode {
  const bytes = entries[path];
  if (!bytes) throw new Error(`Missing generated component: ${path}`);
  return xml(bytes);
}

function outputSource(bytes: Uint8Array): XmlNode[] {
  return descendants(component(unzipSync(bytes), 'Contents/section0.xml'), HP, 'p')
    .filter((paragraph) => Number(paragraph.attributes.id) >= 1000);
}

async function optionsFor(input: Uint8Array, kind: ResearchDraftKind): Promise<ResearchDraftOptions> {
  const { inspection } = await inspectHwpx(input, 'synthetic-research.hwpx');
  const recommendation = recommendDraft(inspection, kind);
  expect(recommendation.eligible).toBe(true);
  expect(recommendation.paragraphs).toHaveLength(10);
  expect(recommendation.paragraphs[0]?.role).toBe('summary');
  expect(recommendation.paragraphs[8]?.role).toBe('references');
  expect(recommendation.paragraphs[9]?.role).toBe('appendix');
  return {
    kind, title: '합성 협력 수업 연구', subject: '합성 국어', grade: '초등학교 5학년', studentCount: '24', researchType: 'joint',
    assignments: recommendation.paragraphs.map((paragraph, index) => ({
      paragraphId: paragraph.paragraphId, sourceText: paragraph.text, role: CORRECTED_ROLES[index]!,
    })),
  };
}

function verifySerializedFormatting(bytes: Uint8Array, kind: ResearchDraftKind): void {
  const entries = unzipSync(bytes);
  expect(decoder.decode(entries.mimetype)).toBe('application/hwp+zip');
  const section = component(entries, 'Contents/section0.xml');
  const header = component(entries, 'Contents/header.xml');
  const settings = only(descendants(section, HP, 'pagePr'));
  expect(settings.attributes).toMatchObject({ width: '59528', height: '84188' });
  const margins = only(descendants(settings, HP, 'margin'));
  expect(margins.attributes).toMatchObject(kind === 'competition'
    ? { top: '4252', bottom: '4252', left: '7087', right: '7087', header: '4252', footer: '4252', gutter: '2835' }
    : { top: '5669', bottom: '5669', left: '5669', right: '5669', header: '4252', footer: '4252', gutter: '0' });
  expect(descendants(section, HP, 'linesegarray')).toHaveLength(0);
  expect(descendants(section, HP, 'lineSegArray')).toHaveLength(0);
  for (const paragraph of outputSource(bytes)) {
    const paraPr = only(descendants(header, HH, 'paraPr').filter((node) => node.attributes.id === paragraph.attributes.paraPrIDRef));
    expect(only(descendants(paraPr, HH, 'lineSpacing')).attributes).toMatchObject({ type: 'PERCENT', value: '160' });
    expect(only(descendants(paraPr, HC, 'intent')).attributes.value).toBe('1000');
    expect(only(descendants(paraPr, HC, 'prev')).attributes.value).toBe(kind === 'competition' ? '500' : '0');
    expect(only(descendants(paraPr, HC, 'next')).attributes.value).toBe('0');
    const style = only(descendants(header, HH, 'style').filter((node) => node.attributes.id === paragraph.attributes.styleIDRef));
    expect(style.attributes.paraPrIDRef).toBe(paragraph.attributes.paraPrIDRef);
    const runs = descendants(paragraph, HP, 'run');
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const charPr = only(descendants(header, HH, 'charPr').filter((node) => node.attributes.id === run.attributes.charPrIDRef));
      expect(charPr.attributes.height).toBe('1200');
      expect(style.attributes.charPrIDRef).toBe(run.attributes.charPrIDRef);
      const refs = only(descendants(charPr, HH, 'fontRef'));
      for (const language of FONT_LANGUAGES) {
        const face = only(descendants(header, HH, 'fontface').filter((node) => node.attributes.lang === language));
        const font = only(descendants(face, HH, 'font').filter((node) => node.attributes.id === refs.attributes[language.toLowerCase()]));
        expect(font.attributes.face).toBe(kind === 'competition' ? '휴먼명조' : '함초롬바탕');
      }
    }
  }
}

describe('source inspection to independently reopened research draft', () => {
  it.each(['competition', 'paper'] as const)('creates a %s draft with every exact source paragraph once in corrected role order', async (kind) => {
    const input = makeResearchFixture();
    const before = input.slice();
    const source = descendants(component(unzipSync(input), 'Contents/section0.xml'), HP, 'p').map((paragraph) => paragraphText(paragraph));
    const session = await createInspectionSession(input, 'synthetic-research.hwpx');
    const options = await optionsFor(input, kind);
    const optionsBefore = structuredClone(options);
    const result = await createResearchDraft(input, options);
    const expectedOrder = [0, 2, 4, 5, 3, 6, 1, 7, 8, 9];
    const serialized = outputSource(result.bytes);
    expect(serialized.map((paragraph) => paragraph.attributes.id)).toEqual(expectedOrder.map((index) => String(1000 + index)));
    expect(serialized.map((paragraph) => paragraphText(paragraph))).toEqual(expectedOrder.map((index) => source[index]));
    expect(new Set(serialized.map((paragraph) => paragraph.attributes.id)).size).toBe(source.length);
    const reopened = await inspectHwpx(result.bytes, 'generated.hwpx');
    expect(reopened.inspection.paragraphs.filter((paragraph) => Number(paragraph.sourceId) >= 1000).map((paragraph) => paragraph.text))
      .toEqual(expectedOrder.map((index) => source[index]));
    expect(reopened.inspection.tables).toEqual([]);
    expect(result).toMatchObject({ kind, sourceParagraphCount: 10, outputParagraphCount: reopened.inspection.paragraphs.length,
      packageVerified: true, originalTextVerified: true, manualValidation: 'NOT_RUN' });
    expect(result.outputParagraphCount).toBeGreaterThan(result.sourceParagraphCount);
    const outputText = descendants(component(unzipSync(result.bytes), 'Contents/section0.xml'), HP, 'p')
      .map((paragraph) => paragraphText(paragraph));
    if (kind === 'competition') {
      expect(outputText).toContain('연구형태: 공동연구');
      expect(outputText).toContain('관리번호: ');
    } else {
      expect(outputText).not.toContain('연구형태: 공동연구');
      expect(outputText).not.toContain('관리번호: ');
    }
    verifySerializedFormatting(result.bytes, kind);
    const preview = decoder.decode(unzipSync(result.bytes)['Preview/PrvText.txt']);
    for (const paragraph of source) expect(preview).toContain(paragraph);
    expect(input).toEqual(before);
    expect(options).toEqual(optionsBefore);
    expect(session.exportUnchanged()).toEqual(before);
    expect(session.originalSha256).toBe(createHash('sha256').update(before).digest('hex'));
  });

  it('normalizes reversed assignment input and regenerates from the preserved original without duplicating prior output', async () => {
    const input = makeResearchFixture();
    const before = input.slice();
    const options = await optionsFor(input, 'competition');
    const first = await createResearchDraft(input, options);
    const reversed = await createResearchDraft(input, { ...options, assignments: [...options.assignments].reverse() });
    expect(outputSource(reversed.bytes).map((paragraph) => ({ id: paragraph.attributes.id, text: paragraphText(paragraph) })))
      .toEqual(outputSource(first.bytes).map((paragraph) => ({ id: paragraph.attributes.id, text: paragraphText(paragraph) })));
    const nextOptions = { ...options, title: '두 번째 합성 초안', assignments: options.assignments.map((assignment) => ({ ...assignment, role: 'need' as const })) };
    const next = await createResearchDraft(input, nextOptions);
    expect(outputSource(next.bytes).map((paragraph) => paragraph.attributes.id)).toEqual(Array.from({ length: 10 }, (_, index) => String(1000 + index)));
    expect(outputSource(next.bytes).map((paragraph) => paragraphText(paragraph))).toEqual(options.assignments.map((assignment) => assignment.sourceText));
    expect(input).toEqual(before);
    expect(next.sourceParagraphCount).toBe(10);
  });

  it('preserves literal XML-looking text, spaces, tabs, line breaks, carriage returns and emoji through serialization', async () => {
    const input = makeResearchFixture();
    const entries = unzipSync(input);
    const text = '[합성 자료] 요약:  두 칸\t탭\n줄바꿈\r캐리지 & <literal> "인용" 😀';
    const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');
    entries['Contents/section0.xml'] = new TextEncoder().encode(decoder.decode(entries['Contents/section0.xml']).replace(/<hp:t>[^]*?<\/hp:t>/u, `<hp:t>${escaped}</hp:t>`));
    const changed = zipSync(entries, { level: 0 });
    const before = changed.slice();
    const options = await optionsFor(changed, 'competition');
    expect(options.assignments[0]?.sourceText).toBe(text);
    const result = await createResearchDraft(changed, options);
    expect(paragraphText(only(outputSource(result.bytes).filter((paragraph) => paragraph.attributes.id === '1000')))).toBe(text);
    expect((await inspectHwpx(result.bytes, 'generated.hwpx')).inspection.paragraphs.find((paragraph) => paragraph.sourceId === '1000')?.text).toBe(text);
    expect(changed).toEqual(before);
  });
});
