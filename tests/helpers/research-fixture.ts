import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';

export interface ResearchFixtureOptions {
  /** Add a separate one-cell table so tests can exercise an object boundary. */
  includeTable?: boolean;
  /** Add a synthetic footnote; its nested paragraph is not a BODY paragraph. */
  includeNote?: boolean;
  /** Add a paragraph containing a paired field control. */
  includeField?: boolean;
}

const paragraphs = [
  '[합성 자료] 요약: 협력 활동을 적용한 수업 연구의 설계와 성찰을 정리한 가상 예시다.',
  '[합성 자료] 연구 필요성: 학습자 참여를 돕는 수업 환경을 살펴볼 필요가 있다는 가상 문제를 설정했다.',
  '[합성 자료] 연구 목적: 협력 과제와 참여 기회를 연결하는 수업 방향을 탐색하는 가상 연구다.',
  '[합성 자료] 수업 설계: 질문 만들기, 모둠 토의, 생각 나누기의 세 활동을 순서대로 배치했다.',
  '[합성 자료] 연구 방법: 학생 참여를 살피는 관찰 항목과 가상 활동 기록 양식을 설계했다.',
  '[합성 자료] 실행 과정: 가상 수업에서 모둠별 역할을 나누고 질문과 답변을 공유하도록 구성했다.',
  '[합성 자료] 연구 결과: 참여 표현이 다양해졌다는 가상 사례이며 실제 관찰값이나 학생 자료는 없다.',
  '[합성 자료] 성찰 및 논의: 발언 기회를 고르게 배분하는 후속 수업을 구상했다. 실제 효과 검증은 하지 않았다.',
  '[합성 자료] 인용 및 참고문헌: 가상 연구자(2026), 가상 협력 수업 자료. 실재하는 출판물이나 인용 근거가 아니다.',
  '[합성 자료] 부록: 빈 관찰 기록 양식과 가상 수업 질문 목록을 덧붙이는 예시다.',
] as const;

const escapeText = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function paragraph(id: number, text: string): string {
  return `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${escapeText(text)}</hp:t></hp:run></hp:p>`;
}

function objectParagraph(id: number, objectXml: string): string {
  return `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${objectXml}</hp:run></hp:p>`;
}

/**
 * Development-only trusted input for report/thesis draft tests. This helper uses
 * fflate only on the repository's tiny public synthetic package, never on user
 * input. The original package declarations and header bytes are reused; only
 * this separate test package's section is populated with explicitly fake text.
 * No Hancom opening, layout, reference credibility, or research result is claimed.
 */
export function makeResearchFixture(options: ResearchFixtureOptions = {}): Uint8Array {
  const original = readFileSync(new URL('../fixtures/01-plain-text.hwpx', import.meta.url));
  const entries = unzipSync(original);
  const body = paragraphs.map((text, index) => paragraph(index, text));

  if (options.includeTable) {
    const cell = `<hp:tc borderFillIDRef="0"><hp:subList id="1002" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP">${paragraph(1003, '[합성 자료] 표 안의 가상 활동 기록')}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="6000" height="3000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`;
    const table = `<hp:tbl id="1001" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="0"><hp:sz width="6000" height="3000" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:tr>${cell}</hp:tr></hp:tbl>`;
    body.push(objectParagraph(1000, table));
  }
  if (options.includeNote) {
    const note = `<hp:footNote id="2001"><hp:subList id="2002" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP">${paragraph(2003, '[합성 자료] 각주 안의 가상 설명이며 본문 근거가 아니다.')}</hp:subList></hp:footNote>`;
    body.push(objectParagraph(2000, note));
  }
  if (options.includeField) {
    body.push(`<hp:p id="3000" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:fieldBegin id="3001" type="BOOKMARK" name="synthetic-field"/><hp:t>[합성 자료] 필드 안의 가상 표시</hp:t><hp:fieldEnd beginIDRef="3001"/></hp:run></hp:p>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">\n${body.join('\n')}\n</hs:sec>\n`;
  entries['Contents/section0.xml'] = new TextEncoder().encode(xml);
  // unzipSync retains this trusted package's entry order, including mimetype
  // first. Store every entry and fix its wall-clock DOS timestamp for stable bytes.
  return zipSync(entries, { level: 0, mtime: new Date(2024, 0, 1, 0, 0, 0) });
}
