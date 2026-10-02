import type { DocumentInspection, InspectionReason } from '../../domain/document';
import { DRAFT_LIMITS, DRAFT_ROLES, type DraftPage, type DraftRecommendation, type DraftRole, type ResearchDraftKind, type ResearchDraftOptions } from '../../domain/research';
import { EngineError } from '../../domain/errors';
import { isResearchDraftOptions } from '../../domain/research';

export const DRAFT_ROLE_LABELS: Record<ResearchDraftKind, Record<DraftRole, string>> = {
  competition: { summary: '요약서', need: '연구의 필요성과 목적', design: '수업 설계와 연구 방법', practice: '수업 실행', results: '실행 결과와 근거', reflection: '성찰·환류와 확산', references: '참고문헌', appendix: '부록' },
  paper: { summary: '초록', need: '서론', design: '연구 방법', practice: '연구 절차', results: '연구 결과', reflection: '논의와 결론', references: '참고문헌', appendix: '부록' },
};

export const OFFICIAL_PROFILE = Object.freeze({
  title: '수업혁신사례연구대회', year: 2026,
  sourceLabel: '2026 수업혁신사례연구대회 전국 운영계획 · 교육청 공식 게시본',
  sourceUrl: 'https://www.edus.or.kr/web/board/fileDownload/1748.do',
  sourcePage: '붙임2 작성요령 11쪽 · 붙임4 표지 서식6',
  scope: '2026 전국 운영계획 참고 · 최종 제출 공문·서식 확인 필요',
  formatSummary: ['본문 휴먼명조 12pt · 줄간격 160%', '여백: 위·아래·머리말·꼬리말 15 / 좌·우 25 / 제본 10', '문단: 들여쓰기 10 / 위 5 / 아래 0', '요약서 → 목차 → 본문 → 부록'],
  checks: [
    '표지·목차를 제외하고 총 25쪽 이내: 요약서 1쪽, 본문·부록 24쪽 이내',
    '표지·본문·부록에 학교·지역·연구자명 등 신원 표시 금지',
    '부록에 교수학습과정안 2회분과 수업일지 확인',
    '공동연구는 공동연구의 필요성 및 목적 포함',
    '공식 표지 서식6·제출 기관의 최신 안내 및 수업 동영상 별도 확인',
  ],
  page: {
    fontFace: '휴먼명조', fontSizePt: 12, lineSpacingPercent: 160,
    width: 59528, height: 84188,
    margins: { top: 4252, bottom: 4252, left: 7087, right: 7087, header: 4252, footer: 4252, gutter: 2835 },
    indent: 1000, beforeSpacing: 500, afterSpacing: 0,
  } satisfies DraftPage,
});

export const PAPER_PAGE: DraftPage = {
  ...OFFICIAL_PROFILE.page, fontFace: '함초롬바탕',
  margins: { top: 5669, bottom: 5669, left: 5669, right: 5669, header: 4252, footer: 4252, gutter: 0 },
  beforeSpacing: 0,
};

const BLOCKING_REASONS = new Set<InspectionReason>(['FIELD_CONTROL', 'HEADER_FOOTER', 'NOTE_CONTEXT', 'UNSUPPORTED_CONTROL', 'UNKNOWN_NAMESPACE', 'UNKNOWN_ELEMENT', 'UNSUPPORTED_CONTEXT', 'SUPERSCRIPT_OR_SUBSCRIPT', 'AMBIGUOUS_FORMAT_REFERENCE']);
const SIGNALS: Array<{ role: DraftRole; pattern: RegExp; label: string }> = [
  { role: 'summary', pattern: /(?:^|\n)[ \t\r]*(?:\[합성 자료\][ \t\r]*)?(?:요약(?:서)?|초록)[ \t\r]*[:：]?/u, label: '요약·초록 표시' },
  { role: 'appendix', pattern: /(?:부록|교수[·ㆍ]?학습\s*과정안|교수학습과정안|수업\s*일지)/u, label: '부록·과정안·수업일지 표현' },
  { role: 'references', pattern: /(?:참고\s*문헌|인용\s*자료|출처\s*[:：]|https?:\/\/|doi\s*[:：])/iu, label: '참고문헌·출처 표현' },
  { role: 'reflection', pattern: /(?:성찰|환류|한계|제언|확산|일반화|후속\s*연구|개선할|보완할|느낀\s*점)/u, label: '성찰·환류·제언 표현' },
  { role: 'results', pattern: /(?:연구\s*결과|실행\s*결과|분석\s*결과|사후\s*(?:검사|평가)|사전[·ㆍ]?사후|향상되|변화하였|효과|통계|검증)/u, label: '결과·효과·검증 표현' },
  { role: 'design', pattern: /(?:설계|연구\s*방법|연구\s*대상|성취\s*기준|평가\s*계획|수업\s*계획|연구\s*절차|연구\s*기간|교육\s*과정)/u, label: '설계·방법·성취기준 표현' },
  { role: 'practice', pattern: /(?:실행|실천|활동|토의|토론|프로젝트|모둠|참여|수업을\s*(?:진행|실시)|적용하였)/u, label: '수업 실행·학생 활동 표현' },
  { role: 'need', pattern: /(?:필요성|목적|문제|배경|연구\s*주제|동기)/u, label: '필요성·목적·배경 표현' },
];
const LEADING_SIGNALS: Array<{ role: DraftRole; pattern: RegExp; label: string }> = [
  { role: 'need', pattern: /(?:연구(?:의)?\s*(?:필요성|목적|배경|동기)|문제\s*상황)/u, label: '문단 앞부분의 연구 필요성·목적 표시' },
  { role: 'design', pattern: /(?:수업\s*설계|연구\s*(?:방법|대상|절차|기간)|성취\s*기준)/u, label: '문단 앞부분의 설계·방법 표시' },
  { role: 'practice', pattern: /(?:수업\s*(?:실행|실천)|실행\s*사례)/u, label: '문단 앞부분의 수업 실행 표시' },
  { role: 'results', pattern: /(?:(?:연구|실행|분석)\s*결과)/u, label: '문단 앞부분의 결과 표시' },
  { role: 'reflection', pattern: /(?:성찰|환류|결론|제언)/u, label: '문단 앞부분의 성찰·결론 표시' },
];

/** Local keyword recommendations are suggestions, never assertions about research. */
export function recommendDraft(inspection: DocumentInspection, kind: ResearchDraftKind): DraftRecommendation {
  const blockers: string[] = [];
  if (inspection.tables.length > 0) blockers.push('표가 있는 문서는 초안을 만들 수 없습니다. 표를 포함한 원본 사본은 계속 내려받을 수 있습니다.');
  if (inspection.paragraphs.some((paragraph) => paragraph.context !== 'BODY')) blockers.push('머리말·꼬리말·각주·보호 영역 등이 포함되어 텍스트 초안 생성을 중단했습니다.');
  if (inspection.sections.some((section) => section.reasons.some((reason) => BLOCKING_REASONS.has(reason)))) blockers.push('확인할 수 없는 구역 구조가 포함되어 있습니다.');
  const runs = new Map(inspection.runs.map((run) => [run.nodeId, run]));
  const body = inspection.paragraphs.filter((paragraph) => paragraph.context === 'BODY');
  let characters = 0;
  for (const paragraph of body) {
    characters += paragraph.text.length;
    const unknownControl = paragraph.runIds.some((id) => {
      const run = runs.get(id);
      return !run || !run.characterFormat.reference.resolved || run.segments.some((segment) => segment.kind === 'UNKNOWN_CONTROL' && !segment.layoutControl);
    });
    if (unknownControl || paragraph.reasons.some((reason) => BLOCKING_REASONS.has(reason))) {
      blockers.push('필드·그림·수식·첨자·알 수 없는 개체 또는 불명확한 글자모양 참조가 포함되어 있습니다. 원문 일부를 버리지 않도록 초안 생성을 중단했습니다.');
      break;
    }
  }
  if (body.length === 0 || !body.some((paragraph) => paragraph.text.trim())) blockers.push('재구성할 본문 텍스트가 없습니다.');
  if (body.length > DRAFT_LIMITS.maxParagraphs || characters > DRAFT_LIMITS.maxTextCharacters) blockers.push('초안 생성 한도(본문 2,000문단·200만 문자)를 넘었습니다.');
  const paragraphs = blockers.length === 0 ? body.map((paragraph) => {
    const outer = SIGNALS.slice(0, 3).find((signal) => signal.pattern.test(paragraph.text));
    const signal = outer ?? LEADING_SIGNALS.find((signal) => signal.pattern.test(paragraph.text.slice(0, 120)))
      ?? SIGNALS.slice(3).find((signal) => signal.pattern.test(paragraph.text));
    return { paragraphId: paragraph.nodeId, text: paragraph.text, role: signal?.role ?? 'need', evidence: signal?.label ?? '분류 단서 없음 · 직접 확인 필요' };
  }) : [];
  const assigned = new Set(paragraphs.filter((paragraph) => paragraph.text.trim()).map((paragraph) => paragraph.role));
  const missing = DRAFT_ROLES.filter((role) => !assigned.has(role));
  return {
    eligible: blockers.length === 0, blockers: [...new Set(blockers)], paragraphs,
    warnings: [
      '문단의 문장은 그대로 유지하며 역할별로 순서를 바꿉니다. 글꼴·기존 강조·쪽 배치는 새 초안 양식으로 바뀝니다.',
      ...(missing.length ? [`자동 분류에서 찾지 못한 구성: ${missing.map((role) => DRAFT_ROLE_LABELS[kind][role]).join(', ')}. 필요한 연구 내용은 직접 작성해 주세요.`] : []),
      '키워드에 따른 분류이므로 적용 전에 문단의 역할을 확인해 주세요. 수치·연구 결과·인용문을 새로 만들지 않습니다.',
    ],
  };
}

export function validateDraftAssignments(inspection: DocumentInspection, options: unknown): asserts options is ResearchDraftOptions {
  if (!isResearchDraftOptions(options)) throw new EngineError('FILE_INVALID_PACKAGE', 'Invalid draft request.');
  const recommendation = recommendDraft(inspection, options.kind);
  if (!recommendation.eligible) throw new EngineError('FILE_UNSUPPORTED', 'Unsupported draft source.');
  if (options.assignments.length !== recommendation.paragraphs.length) throw new EngineError('FILE_INVALID_PACKAGE', 'Incomplete draft assignments.');
  const source = new Map(recommendation.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.text]));
  for (const assignment of options.assignments) {
    if (!source.has(assignment.paragraphId) || source.get(assignment.paragraphId) !== assignment.sourceText) throw new EngineError('FILE_INVALID_PACKAGE', 'Stale draft assignments.');
  }
}
