import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { describe, expect, it } from 'vitest';
import { DRAFT_PROFILES, getDraftProfile } from '../../src/domain/competitions';
import type { DraftProfile } from '../../src/domain/competition-types';
import type { CustomDraftSettings, ResearchDraftOptions } from '../../src/domain/research';
import { createResearchDraft } from '../../src/engine/draft';
import { inspectHwpx } from '../../src/engine/preflight';
import { createInspectionSession } from '../../src/engine/session';
import { makeResearchFixture } from '../helpers/research-fixture';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HH = 'http://www.hancom.co.kr/hwpml/2011/head';
const input = makeResearchFixture();
const decoder = new TextDecoder('utf-8', { fatal: true });
const languages = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];

interface XmlNode {
  uri: string;
  local: string;
  attributes: Record<string, string>;
  content: Array<XmlNode | string>;
}

/** Read actual ZIP output independently of the engine's XML/model helpers. */
function parse(bytes: Uint8Array, path: string): XmlNode {
  const entry = unzipSync(bytes)[path];
  if (!entry) throw new Error(`Missing serialized component: ${path}`);
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  parser.on('opentag', (tag) => {
    const node: XmlNode = { uri: tag.uri, local: tag.local,
      attributes: Object.fromEntries(Object.values(tag.attributes).filter((attribute) => attribute.uri === '').map((attribute) => [attribute.local, attribute.value])), content: [] };
    stack.at(-1)?.content.push(node);
    root ??= node;
    stack.push(node);
  });
  const text = (value: string) => { stack.at(-1)?.content.push(value); };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(decoder.decode(entry)).close();
  if (!root) throw new Error('Missing serialized XML root.');
  return root;
}

function find(node: XmlNode, uri: string, local: string): XmlNode[] {
  return [...(node.uri === uri && node.local === local ? [node] : []),
    ...node.content.flatMap((child) => typeof child === 'string' ? [] : find(child, uri, local))];
}

function only(nodes: XmlNode[]): XmlNode { expect(nodes).toHaveLength(1); return nodes[0]!; }

function text(node: XmlNode, insideText = false): string {
  if (node.uri === HP && node.local === 'tab') return '\t';
  if (node.uri === HP && node.local === 'lineBreak') return '\n';
  const inside = insideText || node.uri === HP && node.local === 't';
  return node.content.map((child) => typeof child === 'string' ? (inside ? child : '') : text(child, inside)).join('');
}

function paragraphs(bytes: Uint8Array): XmlNode[] { return find(parse(bytes, 'Contents/section0.xml'), HP, 'p'); }
function originals(bytes: Uint8Array): XmlNode[] { return paragraphs(bytes).filter((node) => Number(node.attributes.id) >= 1000 && Number(node.attributes.id) < 10_000); }
const originalTexts = paragraphs(input).map((node) => text(node));

function profileFor(id: string): DraftProfile {
  const profile = getDraftProfile(id);
  if (!profile) throw new Error(`Expected registered profile: ${id}`);
  return profile;
}

async function optionsFor(id: string, changes: Partial<ResearchDraftOptions> = {}): Promise<ResearchDraftOptions> {
  const profile = profileFor(id);
  const { inspection } = await inspectHwpx(input, 'competition-synthetic.hwpx');
  return {
    kind: id === 'paper' ? 'paper' : 'competition', profileId: id, year: profile.year,
    stage: 'planning', schoolLevel: 'elementary', title: '합성 대회별 작성 원고',
    subject: '합성 교과', grade: '초등학교 5학년', studentCount: '24', researchType: 'individual',
    assignments: inspection.paragraphs.map((paragraph, index) => ({ paragraphId: paragraph.nodeId,
      sourceText: paragraph.text, role: profile.roles[index % profile.roles.length]! })),
    ...changes,
  };
}

function expectSource(bytes: Uint8Array, selected = Array.from({ length: 10 }, (_, index) => index)): void {
  const source = originals(bytes);
  expect(source).toHaveLength(selected.length);
  const sorted = [...source].sort((left, right) => Number(left.attributes.id) - Number(right.attributes.id));
  expect(sorted.map((node) => ({ id: node.attributes.id, text: text(node) })))
    .toEqual(selected.map((index) => ({ id: String(1000 + index), text: originalTexts[index] })));
}

function expectFormat(bytes: Uint8Array, nodes: XmlNode[], expected: { face: string; size: number; line?: number }): void {
  const header = parse(bytes, 'Contents/header.xml');
  for (const paragraph of nodes) {
    const para = only(find(header, HH, 'paraPr').filter((node) => node.attributes.id === paragraph.attributes.paraPrIDRef));
    if (expected.line !== undefined) expect(only(find(para, HH, 'lineSpacing')).attributes).toMatchObject({ type: 'PERCENT', value: String(expected.line) });
    for (const run of find(paragraph, HP, 'run')) {
      const character = only(find(header, HH, 'charPr').filter((node) => node.attributes.id === run.attributes.charPrIDRef));
      expect(character.attributes.height).toBe(String(Math.round(expected.size * 100)));
      const refs = only(find(character, HH, 'fontRef'));
      for (const language of languages) {
        const face = only(find(header, HH, 'fontface').filter((node) => node.attributes.lang === language));
        const font = only(find(face, HH, 'font').filter((node) => node.attributes.id === refs.attributes[language.toLowerCase()]));
        expect(font.attributes.face).toBe(expected.face);
      }
    }
  }
}

const custom: CustomDraftSettings = {
  name: '교사 개인 참고 기준', fontFace: '함초롬바탕', fontSizePt: 12.75, lineSpacingPercent: 175,
  marginMm: { top: 18, bottom: 19, left: 22, right: 23, header: 12, footer: 13, gutter: 3 },
  labels: { need: '교사가 정한 연구 배경' },
};

describe('registered competition profiles produce verified files without crossing source ownership', () => {
  it.each(DRAFT_PROFILES.filter((profile) => profile.id !== 'custom' && profile.policy !== 'guide-only').map((profile) => profile.id))(
    '%s preserves every original paragraph exactly once and independently reopens', async (id) => {
      const profile = profileFor(id);
      const options = await optionsFor(id);
      const before = input.slice();
      const optionsBefore = structuredClone(options);
      const session = await createInspectionSession(input, 'competition-synthetic.hwpx');
      const result = await createResearchDraft(input, options);
      expectSource(result.bytes);
      const expectedOrder = options.assignments.map((assignment, index) => ({ role: assignment.role, index }));
      if (profile.policy !== 'format-only') expectedOrder.sort((left, right) => profile.roles.indexOf(left.role) - profile.roles.indexOf(right.role) || left.index - right.index);
      expect(originals(result.bytes).map((node) => node.attributes.id)).toEqual(expectedOrder.map(({ index }) => String(1000 + index)));
      const reopened = await inspectHwpx(result.bytes, 'generated-competition.hwpx');
      expect(result).toMatchObject({ profileId: id, profileYear: profile.year, profileVersion: profile.version,
        sourceParagraphCount: 10, outputParagraphCount: reopened.inspection.paragraphs.length,
        packageVerified: true, originalTextVerified: true, manualValidation: 'NOT_RUN' });
      expect(options).toEqual(optionsBefore);
      expect(input).toEqual(before);
      expect(session.exportUnchanged()).toEqual(before);
      expect(session.originalSha256).toBe(createHash('sha256').update(before).digest('hex'));
    },
  );

  it('serializes distinct innovation and field formatting, including the real 11pt/140% body', async () => {
    const innovation = await createResearchDraft(input, await optionsFor('innovation-report'));
    const field = await createResearchDraft(input, await optionsFor('field-report'));
    expectFormat(innovation.bytes, originals(innovation.bytes), { face: '휴먼명조', size: 12, line: 160 });
    expectFormat(field.bytes, originals(field.bytes), { face: '휴먼명조', size: 11, line: 140 });
    const fieldText = paragraphs(field.bytes).map((node) => text(node));
    expect(fieldText).toContain(profileFor('field-report').coverHeading);
    expect(fieldText).not.toContain('2026학년도 수업혁신사례연구대회 보고서');
    expect(profileFor('field-report').labels).not.toEqual(profileFor('innovation-report').labels);
    expectSource(field.bytes);
  });

  it('serializes digital body, heading, title and reference sizes separately', async () => {
    const options = await optionsFor('digital-teaching-report');
    options.assignments = options.assignments.map((assignment, index) => ({ ...assignment, role: index === 9 ? 'references' : 'need' }));
    const result = await createResearchDraft(input, options);
    expectSource(result.bytes);
    expectFormat(result.bytes, originals(result.bytes).filter((node) => node.attributes.id !== '1009'), { face: '바탕체', size: 12, line: 160 });
    expectFormat(result.bytes, originals(result.bytes).filter((node) => node.attributes.id === '1009'), { face: '바탕체', size: 14, line: 160 });
    const output = paragraphs(result.bytes);
    expectFormat(result.bytes, [only(output.filter((node) => node.attributes.id === '2'))], { face: '바탕체', size: 20 });
    const headings = output.filter((node) => Number(node.attributes.id) < 1000 && text(node) === profileFor('digital-teaching-report').labels.need);
    expect(headings.length).toBeGreaterThan(0);
    expectFormat(result.bytes, [headings.at(-1)!], { face: '바탕체', size: 15 });
  });

  it('keeps teacher-authored supplements isolated from immutable original paragraphs', async () => {
    const added = '[교사 직접 작성] 실제 자료 확인 전 합성 입력\t탭\n줄바꿈 & <문자 그대로> 😀';
    const options = await optionsFor('field-report', { supplements: [{ role: 'need', text: added }] });
    const before = input.slice();
    const result = await createResearchDraft(input, options);
    expectSource(result.bytes);
    const additions = paragraphs(result.bytes).filter((node) => Number(node.attributes.id) >= 10_000);
    expect(additions.map((node) => ({ id: node.attributes.id, text: text(node) }))).toEqual([{ id: '10000', text: added }]);
    expect(result).toMatchObject({ sourceParagraphCount: 10, addedParagraphCount: 1 });
    expectFormat(result.bytes, additions, { face: '휴먼명조', size: 11, line: 140 });
    const withoutAddition = await createResearchDraft(input, await optionsFor('field-report'));
    expect(paragraphs(withoutAddition.bytes).some((node) => text(node).includes(added))).toBe(false);
    expect(input).toEqual(before);
  });

  it('requires explicit summary selection approval and preserves selected original IDs in canonical order', async () => {
    const options = await optionsFor('field-summary');
    const selected = [7, 0, 3];
    const result = await createResearchDraft(input, { ...options,
      assignments: [...options.assignments].reverse(),
      summaryParagraphIds: selected.map((index) => options.assignments[index]!.paragraphId), summarySelectionConfirmed: true });
    expectSource(result.bytes, [0, 3, 7]);
    expect(originals(result.bytes).map((node) => node.attributes.id)).toEqual(['1000', '1003', '1007']);
    expect(result).toMatchObject({ sourceParagraphCount: 10, includedParagraphCount: 3, excludedParagraphCount: 7, sourceSelection: 'summary-selection' });
    expectFormat(result.bytes, originals(result.bytes), { face: '휴먼명조', size: 11, line: 140 });
    expect(input).toEqual(makeResearchFixture());
  });

  it.each(['missing-approval', 'unknown-id', 'duplicate-id', 'empty-selection', 'report-subset'])(
    'refuses an invalid or inapplicable summary selection: %s', async (caseName) => {
      const options = await optionsFor(caseName === 'report-subset' ? 'field-report' : 'field-summary');
      let ids = [options.assignments[0]!.paragraphId];
      if (caseName === 'unknown-id') ids = ['Contents/section0.xml#not-present'];
      if (caseName === 'duplicate-id') ids.push(ids[0]!);
      if (caseName === 'empty-selection') ids = [];
      await expect(createResearchDraft(input, { ...options, summaryParagraphIds: ids,
        summarySelectionConfirmed: caseName !== 'missing-approval' })).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
    },
  );

  it.each([
    ['unknown-profile', { profileId: 'not-registered' }, 'FILE_INVALID_PACKAGE'],
    ['wrong-year', { year: 2027 }, 'FILE_INVALID_PACKAGE'],
    ['blocked-school', { schoolLevel: 'kindergarten' }, 'FILE_UNSUPPORTED'],
    ['blocked-character-national', { profileId: 'character-teacher-report', stage: 'national' }, 'FILE_UNSUPPORTED'],
    ['blocked-ebs-national', { profileId: 'ebs-review-description', stage: 'national' }, 'FILE_UNSUPPORTED'],
    ['blocked-digital-management-regional', { profileId: 'digital-management-report', stage: 'regional' }, 'FILE_UNSUPPORTED'],
    ['blocked-digital-management-kindergarten', { profileId: 'digital-management-report', schoolLevel: 'kindergarten' }, 'FILE_UNSUPPORTED'],
    ['unconfirmed-teacher-2026', { profileId: 'teacher-invention-report', year: 2026 }, 'FILE_INVALID_PACKAGE'],
  ] as const)('refuses %s without touching the original', async (_caseName, changes, code) => {
    const before = input.slice();
    const options = await optionsFor('innovation-report');
    await expect(createResearchDraft(input, { ...options, ...changes })).rejects.toMatchObject({ code });
    expect(input).toEqual(before);
  });

  it('serializes a bounded custom reference profile without borrowing official labels or formatting', async () => {
    const options = await optionsFor('custom', { custom });
    const result = await createResearchDraft(input, options);
    expectSource(result.bytes);
    expectFormat(result.bytes, originals(result.bytes), { face: '함초롬바탕', size: 12.75, line: 175 });
    const margin = only(find(parse(result.bytes, 'Contents/section0.xml'), HP, 'margin'));
    for (const [name, mm] of Object.entries(custom.marginMm)) expect(margin.attributes[name]).toBe(String(Math.round(mm * 7200 / 25.4)));
    const outputText = paragraphs(result.bytes).map((node) => text(node));
    expect(outputText).toContain('교사가 정한 연구 배경');
    expect(outputText).not.toContain('2026학년도 수업혁신사례연구대회 보고서');
    expect(result.profileId).toBe('custom');
  });

  it.each([
    { fontSizePt: 5.99 }, { fontSizePt: 12.001 }, { lineSpacingPercent: 301 },
    { marginMm: { ...custom.marginMm, left: 81 } }, { labels: { need: '' } },
  ])('rejects an unbounded or ambiguous custom setting (%#)', async (change) => {
    const options = await optionsFor('custom', { custom: { ...custom, ...change } });
    await expect(createResearchDraft(input, options)).rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });

  it('format-only profiles retain original order and reject newly composed supplements', async () => {
    const options = await optionsFor('ebs-posting-description');
    const result = await createResearchDraft(input, options);
    expect(originals(result.bytes).map((node) => node.attributes.id)).toEqual(Array.from({ length: 10 }, (_, index) => String(1000 + index)));
    expectSource(result.bytes);
    await expect(createResearchDraft(input, { ...options, supplements: [{ role: options.assignments[0]!.role, text: '교사 입력 합성 문장' }] }))
      .rejects.toMatchObject({ code: 'FILE_INVALID_PACKAGE' });
  });
});
