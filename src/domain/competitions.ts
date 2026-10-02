import type { CompetitionDefinition, CompetitionSource, DraftProfile } from './competition-types';
import { EngineError, ERROR_MESSAGES } from './errors';
import { DRAFT_ROLES, DRAFT_SCHOOL_LEVELS, DRAFT_STAGES, isCustomDraftSettings,
  type DraftPage, type DraftRole, type DraftSchoolLevel, type DraftStage, type ResearchDraftOptions } from './research';

const CHECKED_ON = '2026-10-02';
const VERSION = '2026-10-02-v1';
const ALL_SCHOOLS = [...DRAFT_SCHOOL_LEVELS];
const SCHOOL_SCHOOLS: DraftSchoolLevel[] = ['elementary', 'middle', 'high', 'special'];
const ALL_STAGES = [...DRAFT_STAGES];
const BEFORE_NATIONAL: DraftStage[] = ['planning', 'regional'];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const SCHOOL_LEVEL_LABELS: Readonly<Record<DraftSchoolLevel, string>> = deepFreeze({
  elementary: '초등학교', middle: '중학교', high: '고등학교', kindergarten: '유치원', special: '특수학교',
});
export const DRAFT_STAGE_LABELS: Readonly<Record<DraftStage, string>> = deepFreeze({
  planning: '계획·작성 중', regional: '시도 제출 전', national: '전국 제출 준비',
});

const labels: Record<DraftRole, string> = {
  summary: '요약서', need: '연구의 필요성과 목적', design: '연구 방법', practice: '연구 실행',
  results: '연구 결과와 근거', reflection: '결론과 제언', references: '참고문헌', appendix: '부록',
};
const innovationLabels: Record<DraftRole, string> = {
  ...labels, design: '수업 설계와 연구 방법', practice: '수업 실행', results: '실행 결과와 근거', reflection: '성찰·환류와 확산',
};
const paperLabels: Record<DraftRole, string> = {
  summary: '초록', need: '서론', design: '연구 방법', practice: '연구 절차', results: '연구 결과',
  reflection: '논의와 결론', references: '참고문헌', appendix: '부록',
};
const manualCheck = '한글 실제 열기·쪽수·조판·PDF·인쇄·공식 서식 대조는 미실행(NOT_RUN)이며 직접 확인해야 합니다.';
const textDraftNote = '원문 문장을 재작성하거나 성과·수치·인용을 만들어 내지 않는 텍스트 초안입니다. 공식 제출 서식의 완전 재현·인증이 아닙니다.';
const defaultPageNote = '글꼴 함초롬바탕 12pt·줄간격 160%·A4 세로·본문 여백 20mm·머리말/꼬리말 15mm·제본 0mm는 앱 기본값이며 이 대회의 공식 수치가 아닙니다.';
const defaultParagraphNote = '제목 16pt·표지/목차 12pt, 본문 들여쓰기 10pt·문단 위/아래 0pt는 앱 기본값입니다.';
const summaryNote = '요약문을 자동으로 새로 쓰지 않습니다. 교사가 확인한 원문 문단만 선택하며 빠진 내용과 분량은 직접 보완합니다.';
const unitNote = '원문에 단위가 생략된 여백 숫자는 mm, 들여쓰기·문단 간격 숫자는 pt로 보수 해석했습니다. 공식 단위 확정이나 한글 조판 검증을 뜻하지 않습니다.';

const appPage: DraftPage = {
  fontFace: '함초롬바탕', fontSizePt: 12, lineSpacingPercent: 160, width: 59528, height: 84188,
  margins: { top: 5669, bottom: 5669, left: 5669, right: 5669, header: 4252, footer: 4252, gutter: 0 },
  indent: 1000, beforeSpacing: 0, afterSpacing: 0,
};
const innovationPage: DraftPage = {
  fontFace: '휴먼명조', fontSizePt: 12, lineSpacingPercent: 160, width: 59528, height: 84188,
  margins: { top: 4252, bottom: 4252, left: 7087, right: 7087, header: 4252, footer: 4252, gutter: 2835 },
  indent: 1000, beforeSpacing: 500, afterSpacing: 0,
};
const kftaPage: DraftPage = {
  ...appPage, fontFace: '휴먼명조', fontSizePt: 11, lineSpacingPercent: 140,
  margins: { top: 5669, bottom: 5669, left: 7087, right: 5669, header: 4252, footer: 4252, gutter: 0 },
};
const digitalPage: DraftPage = {
  ...appPage, fontFace: '바탕체', indent: 0,
  margins: { top: 2835, bottom: 2835, left: 5669, right: 5669, header: 2835, footer: 2835, gutter: 0 },
  fontSizes: { title: 20, heading: 15, references: 14 },
};
const sciencePage: DraftPage = {
  ...appPage, fontFace: '휴먼명조', fontSizePt: 11, indent: 0,
  margins: { top: 4252, bottom: 4252, left: 5669, right: 5669, header: 2835, footer: 2835, gutter: 0 },
  fontSizes: { heading: 15 },
};

function source(label: string, url: string, location: string, scope: CompetitionSource['scope'] = 'national'): CompetitionSource {
  return { label, url, location, scope, checkedOn: CHECKED_ON };
}
const sources = {
  innovation: source('2026 수업혁신사례연구대회 전국 운영계획 · 교육청 공식 게시본', 'https://www.edus.or.kr/web/board/fileDownload/1748.do', '붙임2 작성요령 11쪽 · 붙임4 표지 서식6'),
  field: source('2026 제70회 전국현장교육연구대회 추진요강', 'https://www.kfta.or.kr/usr/wap/downloadFile.do?app=18000&seq=270003394896&atchFileSeq=270003394895&fileSn=0', '5~6쪽 작성요령 · 양식3 요약서 · 양식4~5 표지'),
  digital: source('2026 제20회 디지털교육연구대회 전국 요강 · 대전교육정보원 공식 게시본', 'https://www.edurang.net/daa/include/down.jsp?dirPath=study&img_file=%EC%A0%9C20%ED%9A%8C+%EB%94%94%EC%A7%80%ED%84%B8%EA%B5%90%EC%9C%A1%EC%97%B0%EA%B5%AC%EB%8C%80%ED%9A%8C+%EC%9A%94%EA%B0%95%28%EC%A0%84%EA%B5%AD%EB%8C%80%ED%9A%8C%29_1774340492466.hwp', 'Ⅱ-4-라 보고서 서식 · 분과 안내 · 서식3-1/3-2'),
  character: source('2026 경기도교육청 운영계획에 실린 전국대회 안내', 'https://www.goe.go.kr/goe/na/ntt/comm/nttFileDownload.do?fileKey=0e86605f11eb0277c4ec94184654dc26', '참고6 전국대회 안내 · 지역 본문의 서식 수치는 전국 기준으로 적용하지 않음', 'national-notice'),
  data: source('2026 제57회 전국교육자료전 추진요강', 'https://www.kfta.or.kr/usr/wap/downloadFile.do?app=18000&seq=270003395147&atchFileSeq=270003395146&fileSn=0', '교육자료설명서 작성요령 · 요약서 서식'),
  ebs: source('2026 제34회 교육방송연구대회 전국 운영계획 · 교육청 공식 게시본', 'https://www.edus.or.kr/web/board/fileDownload/1727.do', '제출 규격 · 생성형 AI 제한 · 양식4-1/4-2 설명서'),
  career: source('2026 진로연계교육 발표대회 세부계획 재수정안', 'https://cdn.kosac.re.kr/files/cms/attach/202604/b9be24a6d91c4fce87d263936c6677ce_1776990963311.hwpx', '붙임1 출품계획서 · 붙임2 출품지원서'),
  unification: source('2026 제14회 학교통일교육 연구대회 요강', 'https://www.uniedu.go.kr/uniedu/atchfile/down/F000184478.hwpx', '연구보고서 작성 방법 · 연구보고서 요약서 서식'),
  science: source('2026 제72회 전국과학전람회 개최요강', 'https://www.science.go.kr/mps/bbs/157/downBbsNttFile.do?atchmnflSn=75921', 'Ⅱ 학생작품지도논문연구대회 · 설명서 작성요령 27쪽'),
  invention: source('2026 제47회 전국학생과학발명품경진대회 개최요강', 'https://www.science.go.kr/mps/bbs/154/downBbsNttFile.do?atchmnflSn=75865', 'Ⅱ 학생작품지도연구논문대회 · 서식8/9 · 설명서 작성요령 30쪽'),
  teacherInvention: source('2025 전국교원 발명연구대회 공고 · 2026 운영요강 미확인', 'https://www.kipa.org/_custom/kipa/_common/board/download.jsp?attach_no=42976', '연구보고서 작성요령 · 서식2/3/4', 'previous-year'),
};

export const COMPETITIONS: readonly CompetitionDefinition[] = deepFreeze([
  { id: 'innovation', label: '수업혁신사례연구대회', aliases: ['교실수업개선실천사례연구발표대회', '열린교육실천사례연구발표대회'], organizer: '교육부 · 한국교육과정평가원', schoolLevels: SCHOOL_SCHOOLS, eligibility: ['초·중등 교원 대상 · 시도대회 추천 및 최신 제출 공문 확인'] },
  { id: 'field', label: '전국현장교육연구대회', aliases: [], organizer: '한국교원단체총연합회', schoolLevels: ALL_SCHOOLS, eligibility: ['유·초·중등 교원 및 교육전문직원 등 요강상 자격 확인', '시도대회 1·2등급 및 시도교총 회장 추천 필요'] },
  { id: 'digital', label: '디지털교육연구대회', aliases: ['교육정보화연구대회'], organizer: '한국교육학술정보원(KERIS) · 교육부 후원', schoolLevels: ALL_SCHOOLS, eligibility: ['실제 수업 담당 재직 정규 교원 · 휴직자/휴직예정자 제외', '교수·학습/SW·AI: 개인 또는 동일 학교급·직종 공동2인', '학교경영: 초·중등(특수 포함) 공동4~10인 · 전국대회만 운영'] },
  { id: 'character', label: '인성교육실천사례연구발표대회', aliases: [], organizer: '교육부 · 한국청소년정책연구원', schoolLevels: ALL_SCHOOLS, eligibility: ['교원 개인과 기관 부문을 구분', '전국 단계는 시도 제출 보고서 수정 없이 제출 · 이 앱에서 전국 단계 생성 차단'] },
  { id: 'data', label: '전국교육자료전', aliases: [], organizer: '한국교원단체총연합회', schoolLevels: ALL_SCHOOLS, eligibility: ['시도교육자료전 1등급 자료와 추천 등 전국 출품 자격 확인', '실제 교육자료와 활용 실적이 필요한 대회 · 설명서만으로 출품 완료 불가'] },
  { id: 'ebs', label: '교육방송연구대회', aliases: ['EBS 교육방송연구대회'], organizer: '한국교육방송공사(EBS) · 교육부 후원', schoolLevels: ALL_SCHOOLS, eligibility: ['영상학습자료 부문 설명서 서식만 지원 · 개인 또는 공동2인 자격 확인', '전국 단계는 시도 제출 작품 수정 제한 · 이 앱에서 전국 단계 생성 차단'] },
  { id: 'career', label: '진로연계교육 발표대회', aliases: [], organizer: '한국과학창의재단', schoolLevels: SCHOOL_SCHOOLS, eligibility: ['초·중등 교원·교육전문직원(특수 포함)', '개인 또는 동일 시도 공동2~4인 · 출품계획서 선제출 필요'] },
  { id: 'unification', label: '학교통일교육 연구대회', aliases: [], organizer: '국립평화통일민주교육원', schoolLevels: SCHOOL_SCHOOLS, eligibility: ['초·중등 교원(특수 포함) 개인 연구 · 기관장 추천 등 확인', '실제 학교통일교육 실천 및 연구 근거 필요'] },
  { id: 'science-guidance', label: '전국과학전람회 학생작품지도논문연구대회', aliases: [], organizer: '국립중앙과학관', schoolLevels: SCHOOL_SCHOOLS, eligibility: ['전국과학전람회에 출품한 학생작품 지도교원에 한함', '학생 작품 설명서와 교원의 지도논문을 구분'] },
  { id: 'invention-guidance', label: '전국학생과학발명품경진대회 학생작품지도연구논문대회', aliases: [], organizer: '국립중앙과학관', schoolLevels: SCHOOL_SCHOOLS, eligibility: ['전국학생과학발명품경진대회에 출품한 학생작품 지도교원에 한함', '일반 교원 발명대회·과학전람회 지도논문과 별도'] },
  { id: 'teacher-invention', label: '전국교원 발명연구대회', aliases: [], organizer: '한국발명진흥회', schoolLevels: ALL_SCHOOLS, eligibility: ['2025 공식 공고 참고만 제공 · 2026 운영요강 미확인', '교원·교육전문직원 개인 참가 등 해당 연도 자격 확인'] },
  { id: 'paper', label: '일반 논문 구성 초안', aliases: [], organizer: '앱 참고 서식 · 공식 대회 아님', schoolLevels: ALL_SCHOOLS, eligibility: ['학회·대학·기관별 투고 규정은 별도로 확인'] },
  { id: 'custom', label: '사용자 지정 서식', aliases: [], organizer: '교사가 직접 지정 · 공식 대회 아님', schoolLevels: ALL_SCHOOLS, eligibility: ['사용자가 제공한 서식 수치를 적용 · 공식 규정 검증 아님'] },
]);

type ProfileInput = Pick<DraftProfile, 'id' | 'competitionId' | 'label' | 'source'> & Partial<Omit<DraftProfile, 'id' | 'competitionId' | 'label' | 'source'>>;
function profile(input: ProfileInput): DraftProfile {
  const activeLabels = input.labels ?? labels;
  const activeRoles = input.roles ?? [...DRAFT_ROLES];
  const prompts = Object.fromEntries(activeRoles.map((role) => [role, `${activeLabels[role]}에 필요한 실제 계획·실천·근거를 직접 확인하고 보충하세요. 확인하지 않은 결과·수치·인용은 만들지 마세요.`]));
  return {
    id: input.id, competitionId: input.competitionId, year: input.year ?? 2026, version: input.version ?? VERSION,
    label: input.label, documentType: input.documentType ?? 'report', policy: input.policy ?? 'draft', source: input.source,
    page: input.page ?? appPage, roles: activeRoles, labels: activeLabels,
    coverHeading: input.coverHeading ?? `${input.year ?? 2026} ${input.label} 초안`,
    coverFields: input.coverFields ?? ['schoolLevel', 'subject', 'researchType', 'grade', 'studentCount'],
    includeToc: input.includeToc ?? true, allowedStages: input.allowedStages ?? ALL_STAGES,
    formatSummary: input.formatSummary ?? ['공식 글꼴·본문 크기·줄간격·여백 수치를 확인하지 못했습니다. 앱 참고 서식을 적용합니다.'],
    interpretationNotes: [textDraftNote, ...(input.interpretationNotes ?? [defaultPageNote, defaultParagraphNote])],
    checks: [...(input.checks ?? []), manualCheck], requirements: input.requirements ?? [], prompts: { ...prompts, ...input.prompts },
  };
}
function pair(input: ProfileInput, summaryId: string, summaryChecks: readonly string[]): DraftProfile[] {
  const main = profile(input);
  return [main, profile({ ...input, id: summaryId, label: `${input.label} 요약서`, documentType: 'summary', roles: ['summary'],
    includeToc: false, coverHeading: `${input.year ?? 2026} ${input.label} 요약서 초안`,
    interpretationNotes: [...(input.interpretationNotes ?? [defaultPageNote, defaultParagraphNote]), summaryNote,
      '요약서 초안은 본 보고서에 적용한 본문 서식을 재사용합니다. 요약서 자체의 별도 글꼴·표지·사진·표 항목은 공식 요약서 서식과 직접 대조해야 합니다.'],
    checks: summaryChecks, prompts: { summary: '선택한 원문에 필요성·대상·실행·검증·결론이 포함됐는지 확인하세요. 없는 연구 내용을 자동으로 작성하지 않습니다.' } })];
}

const kftaNotes = [unitNote, 'A4는 전국 요강 명시값입니다. 머리말/꼬리말 15mm·제본 0mm·문단 위/아래 0pt·제목16pt·표지/목차12pt는 앱 기본값입니다.'];
const digitalNotes = [unitNote, '본문 글씨 크기는 요강에서 자유로 지정합니다. 본문12pt·줄간격160%·들여쓰기/문단 간격/제본0·표지/목차12pt는 앱 기본값이며 공식 고정값이 아닙니다.', 'A4·바탕체·대제목15pt·제목20pt·참고문헌14pt는 요강/서식 명시값입니다. 중·소제목 12~14pt와 공식 서식의 표 구조는 수동 대조해야 합니다.'];
const digitalLabels = { ...labels, need: '연구 배경 및 목적', practice: '연구 내용', reflection: '결론 및 일반화' };
const digitalChecks = ['HWP·PDF 각각 기명본/블라인드본 4종과 인쇄본 6부(기명1·블라인드5) 등 최종 제출물 확인', '본문·요약·참고자료의 분과별 분량과 이름·학교 등 익명 처리를 각각 확인'];
const scienceNotes = ['A4·휴먼명조11pt·줄간격160%·좌우20mm·위아래15mm·머리말/꼬리말10mm·대제목15pt는 전국 요강 명시값입니다.', '제본0mm·본문 들여쓰기/문단 간격0pt·표지/목차12pt·초안 제목16pt는 앱 기본값입니다. 2~6단계 제목·목차 쪽번호·하단중앙 쪽번호·장평100/자간0·좌철은 한글에서 확인하세요.'];
const scienceChecks = ['지도논문 설명서 A4 20쪽 이내 · 요약서 A4 1매 · 원본과 개인정보 삭제본 각각 제출', '학생 작품 설명서를 복사하지 말고 교원이 실제 지도한 과정과 교육적 효과의 근거를 확인', '전국 출품 학생작품 지도교원 자격·추천서·공식 표지·목차 및 쪽번호 확인'];
const scienceRequirements = [{ id: 'national-student-work', label: '해당 전국대회 출품 학생작품과 지도교원 자격' }, { id: 'guidance-evidence', label: '실제 지도 기록·설명서·요약서·추천서 및 개인정보 삭제본' }];

export const DRAFT_PROFILES: readonly DraftProfile[] = deepFreeze([
  profile({ id: 'innovation-report', competitionId: 'innovation', label: '수업혁신사례연구대회 보고서', source: sources.innovation,
    page: innovationPage, labels: innovationLabels, coverHeading: '2026학년도 수업혁신사례연구대회 보고서',
    formatSummary: ['본문 휴먼명조 12pt · 줄간격 160%', '여백: 위·아래·머리말·꼬리말 15 / 좌·우 25 / 제본 10', '문단: 들여쓰기 10 / 위 5 / 아래 0', '요약서 → 목차 → 본문 → 부록'],
    interpretationNotes: [unitNote, 'A4 세로 용지와 초안 제목16pt·표지/목차12pt는 앱 기본값입니다. 전국 원문에 A4가 명시됐다고 주장하지 않습니다. 본문 구성 제목은 본문과 같은12pt입니다.'],
    checks: ['표지·목차 제외 총25쪽 이내: 요약서1쪽·본문/부록24쪽 이내', '표지·본문·부록에 학교·지역·연구자명 등 신원 표시 금지', '부록에 교수학습과정안2회분과 수업일지 확인', '공동연구의 필요성 및 목적 포함', '공식 표지 서식6·최신 제출 공문·수업 동영상은 별도 확인'],
    requirements: [{ id: 'lesson-plans', label: '교수학습과정안2회분과 수업일지' }, { id: 'lesson-video', label: '요강에 맞는 수업 동영상·기관 제출 공문' }] }),
  ...pair({ id: 'field-report', competitionId: 'field', label: '현장교육 연구보고서', source: sources.field, page: kftaPage,
    formatSummary: ['본문 휴먼명조11pt·줄간격140%·들여쓰기10', '여백: 상·하·우20 / 좌25 · A4'], interpretationNotes: kftaNotes,
    checks: ['연구보고서50쪽 이내: 겉·속표지/요약서/목차 제외, 참고문헌·부록 포함', '겉표지 기명 · 속표지/본문 익명 및 학생·동료 개인정보 확인', '양면 컬러 인쇄·좌철 제본 · 스프링철/겉표지 코팅 금지'],
    requirements: [{ id: 'regional-recommendation', label: '시도대회1·2등급과 시도교총 추천' }, { id: 'field-submissions', label: '보고서·요약서·요구된 HWP 또는 PDF·인쇄본·발표 자료' }] }, 'field-summary', ['요약서 A4 한 면 · 도표 사용 금지', '필요성/목적·대상/기간·실행·검증/결과·결론/제언을 실제 보고서 근거로 확인']),
  ...pair({ id: 'digital-teaching-report', competitionId: 'digital', label: '디지털 교수·학습 연구보고서', source: sources.digital, page: digitalPage, labels: digitalLabels,
    formatSummary: ['바탕체 · 본문 크기 자유 · 대제목15pt·제목20pt·참고문헌14pt', '여백: 위·아래·머리말·꼬리말10 / 좌·우20'], interpretationNotes: digitalNotes,
    checks: ['본문20쪽·요약5쪽·참고자료10쪽 이내(요강 총35쪽)', ...digitalChecks],
    requirements: [{ id: 'teaching-evidence', label: '실제 디지털 수업 자료·활용/변화 근거·저작권 증빙' }, { id: 'digital-submissions', label: '기명/블라인드 HWP·PDF 및 인쇄본' }] }, 'digital-teaching-summary', ['요약5쪽 이내 · 원문에 있는 연구 배경·방법·내용·결과·일반화만 포함', ...digitalChecks]),
  ...pair({ id: 'digital-software-report', competitionId: 'digital', label: '교육용SW·AI 연구보고서', source: sources.digital, page: digitalPage,
    labels: { ...digitalLabels, design: '소프트웨어 개요', practice: '소프트웨어 활용 교육 방법과 과정', results: '연구·소프트웨어 활용 결과' },
    formatSummary: ['바탕체 · 본문 크기 자유 · 대제목15pt·제목20pt·참고문헌14pt', '여백: 위·아래·머리말·꼬리말10 / 좌·우20'], interpretationNotes: digitalNotes,
    checks: ['본문10쪽·요약2쪽·참고자료10쪽 이내(요강 총22쪽)', ...digitalChecks, '보고서 외 실제 실행SW·전체 소스·배포파일·멀티미디어·기술지침 확인'],
    requirements: [{ id: 'software-deliverables', label: '실행SW·전체 소스·배포/멀티미디어 파일·기술지침' }, { id: 'software-evidence', label: '교육과정 연계·실제 활용 근거·업무분장·저작권 증빙' }] }, 'digital-software-summary', ['요약2쪽 이내 · 실제 개발물과 활용 결과에 근거', ...digitalChecks]),
  ...pair({ id: 'digital-management-report', competitionId: 'digital', label: '디지털 학교경영 연구보고서', source: sources.digital, page: digitalPage, labels: digitalLabels,
    allowedStages: ['planning', 'national'],
    formatSummary: ['바탕체 · 본문 크기 자유 · 대제목15pt·제목20pt·참고문헌14pt', '여백: 위·아래·머리말·꼬리말10 / 좌·우20'], interpretationNotes: digitalNotes,
    checks: ['본문20쪽·요약5쪽·참고자료10쪽 이내', '초·중등(특수 포함) 공동4~10인 · 시도대회 없이 전국대회 출품', ...digitalChecks],
    requirements: [{ id: 'school-plan', label: '2026 학교교육계획서·학교경영 전략 및 변화 증빙' }, { id: 'management-team', label: '공동4~10인 팀·업무분장·기명/블라인드 제출물' }] }, 'digital-management-summary', ['요약5쪽 이내 · 실제 학교경영 전략과 학교 구성원 변화 근거', ...digitalChecks]),
  ...pair({ id: 'character-teacher-report', competitionId: 'character', label: '인성교육 교원 개인 보고서 참고', source: sources.character, policy: 'reference', allowedStages: BEFORE_NATIONAL,
    formatSummary: ['전국 안내의 참가/제출 제한 참고 · 전국 공통 글꼴·분량·여백 수치 미확인'],
    interpretationNotes: [defaultPageNote, defaultParagraphNote, '경기도 지역 본문의 교원20쪽 등 수치를 전국 공통 규정으로 적용하지 않습니다.'],
    checks: ['교원 개인 부문 · 전국 추천 자격과 시도별 최신 서식 확인', '전국에는 시도 제출 보고서를 수정 없이 제출하므로 전국 단계 초안 생성 차단'],
    requirements: [{ id: 'character-regional', label: '시도별 요강·추천 자격·원본 제출 보고서' }, { id: 'character-practice', label: '실제 인성교육 실천 과정·근거·동의 자료' }] }, 'character-teacher-summary', ['전국 요약서 분량 수치 미확인 · 시도별 공식 서식과 원문 근거 확인', '전국 단계는 보고서 수정 제한으로 생성 차단']),
  ...pair({ id: 'character-institution-report', competitionId: 'character', label: '인성교육 기관 보고서 참고', source: sources.character, policy: 'reference', allowedStages: BEFORE_NATIONAL,
    formatSummary: ['기관 부문 전국 안내 참고 · 전국 공통 글꼴·분량·여백 수치 미확인'],
    interpretationNotes: [defaultPageNote, defaultParagraphNote, '경기도 지역 본문의 기관40쪽 등 수치를 전국 공통 규정으로 적용하지 않습니다.'],
    checks: ['교원 개인 연구와 기관 전체 실천을 구분 · 시도 기관 추천 기준 확인', '전국에는 시도 제출 보고서를 수정 없이 제출하므로 전국 단계 초안 생성 차단'],
    requirements: [{ id: 'institution-evidence', label: '기관의 실제 인성교육 운영·구성원 참여·변화 근거' }, { id: 'institution-recommendation', label: '시도 기관 추천 및 제출 원본' }] }, 'character-institution-summary', ['전국 요약서 분량 수치 미확인 · 기관 실천 근거와 시도 공식 서식 확인', '전국 단계는 보고서 수정 제한으로 생성 차단']),
  ...pair({ id: 'data-description', competitionId: 'data', label: '교육자료설명서', source: sources.data, documentType: 'description', page: kftaPage,
    labels: { ...labels, need: '자료 개발의 필요성과 목적', design: '자료 구성과 제작 방법', practice: '자료 활용 방법', results: '적용 결과와 근거', reflection: '개선과 일반화' },
    formatSummary: ['본문 휴먼명조11pt·줄간격140%·들여쓰기10', '여백: 상·하·우20 / 좌25 · A4'], interpretationNotes: kftaNotes,
    checks: ['설명서30쪽 이내: 겉·속표지/요약서/목차 제외, 참고문헌·부록 포함', '겉표지 기명 · 속표지/본문 익명', '양면 컬러 인쇄·좌철 제본 · 스프링철/겉표지 코팅 금지', '실제 출품 교육자료·게시 자료·활용 근거와 설명서 내용 일치 확인'],
    requirements: [{ id: 'actual-materials', label: '실제 출품자료·활용 근거·요약서·게시자료' }, { id: 'data-submissions', label: '시도1등급 추천·설명서 인쇄본8부 등 요강 제출물' }] }, 'data-summary', ['공식 교육자료 요약서 항목·분량을 직접 확인 · 실제 자료와 개발/활용 근거만 포함', '양식8 전면 사진·자료 구성표·사용 방법/교육적 효과 표는 별도 작성 · 텍스트 초안에 자동 생성하지 않음']),
  ...['posting', 'review'].map((purpose) => profile({ id: `ebs-${purpose}-description`, competitionId: 'ebs', label: `교육방송 영상학습자료 ${purpose === 'posting' ? '게시용' : '심사용'} 설명서`, source: sources.ebs,
    policy: 'format-only', documentType: 'description', allowedStages: BEFORE_NATIONAL, coverFields: [], includeToc: false,
    formatSummary: ['교사가 작성한 설명서의 문장·문단 순서를 그대로 유지하고 서식만 적용', '설명서 공식 글꼴·줄간격·여백·쪽수 고정 수치 미확인'],
    interpretationNotes: [defaultPageNote, defaultParagraphNote, '새 구성 제목·목차·보충 문단을 추가하지 않습니다. 영상 내용이나 스크립트를 작성하는 기능이 아닙니다.'],
    checks: ['생성형 AI로 영상 주제·소재 선정, 구성안·스크립트 작성 시 심사 제외 · 이 제한을 모든 서식 편집 금지로 확대하지 않음', '설명서 최종PDF·본영상MP4(5~8분)·제작과정영상MP4(2분30초~4분) 등 요구 형식 확인', `${purpose === 'posting' ? '게시용 기명' : '심사용 익명'} 공식 설명서 양식4-${purpose === 'posting' ? '1' : '2'}와 대조`, '전국 단계 작품 수정 제한으로 전국 단계 초안 생성 차단'],
    requirements: [{ id: 'ebs-videos', label: '교사가 제작한 본영상·제작과정영상MP4' }, { id: 'ebs-final-pdf', label: '공식 설명서PDF·저작권/초상권 증빙·게시용/심사용 구분' }] })),
  profile({ id: 'career-plan', competitionId: 'career', label: '진로연계교육 출품계획서', source: sources.career, documentType: 'plan', includeToc: false,
    roles: ['need', 'practice', 'design'], labels: { ...labels, need: '총괄표', practice: '프로그램별 운영 계획', design: '프로그램별 평가 계획' },
    coverFields: ['schoolLevel', 'subject', 'grade'], formatSummary: ['출품계획서2쪽 이하 · 붙임1 항목 참고 · 글꼴·여백 수치 미확인'],
    checks: ['학교생활적응·상급학급(년)준비·교과학습연계·진로탐색 중3개 이상 영역 포함', '계획서 선제출 없이는 최종 출품 불가 · 기관장 직인/참가신청은 별도', '학교명·성명·지역명 익명 처리 · 공식 총괄표/프로그램 표 구조는 수동 작성'],
    requirements: [{ id: 'career-programs', label: '3개 이상 진로연계 영역의 실제 운영·평가 계획' }, { id: 'career-plan-submission', label: '출품계획서·참가신청·기관장 확인' }] }),
  profile({ id: 'career-application', competitionId: 'career', label: '진로연계교육 출품지원서', source: sources.career, documentType: 'application', includeToc: false,
    roles: ['practice', 'design', 'results', 'reflection'], labels: { ...labels, practice: '프로그램 운영 사례', design: '프로그램별 지도 사례', results: '프로그램별 평가 결과', reflection: '기타 사항' },
    coverFields: ['schoolLevel', 'subject', 'grade'], formatSummary: ['한글 출품지원서5쪽 이하·PPT15쪽 이하 · 붙임2 항목 참고 · 글꼴·여백 수치 미확인'],
    checks: ['계획서 제목과 연계·학교명/성명/지역명 익명 처리·3개 이상 영역 포함', '실제2026 운영·지도·평가 근거만 사용 · 없는 성과를 작성하지 않음', 'HWP 지원서와 PPT를 모두 제출 · 출품서약/기관장 확인·해당시 AI활용/초상권 동의 별도', '공식 프로그램 표 구조와 최종 제출 후 수정 제한 확인'],
    requirements: [{ id: 'career-evidence', label: '실제 운영·지도·평가 자료와 계획서 연계' }, { id: 'career-ppt', label: 'PPT15쪽 이하·출품서약·기관장 확인 및 해당 동의서' }] }),
  ...pair({ id: 'unification-report', competitionId: 'unification', label: '학교통일교육 연구보고서', source: sources.unification,
    page: { ...kftaPage, beforeSpacing: 500 },
    formatSummary: ['본문 휴먼명조11pt·줄간격140%·들여쓰기10·문단 위5', '여백: 상·하·우20 / 좌25 · A4'],
    interpretationNotes: [unitNote, '머리말/꼬리말15mm·제본0mm·문단 아래0pt·제목16pt·표지/목차12pt는 앱 기본값입니다.'],
    checks: ['표지·요약서·목차 제외 본문부터30쪽 이내 · 최종PDF100MB 이하', '표지 포함 연구자 성명·학교 등 인적사항 금지 · 파일명 규정 별도', '개인 연구·기관장 추천·실제 학교통일교육 실천 근거 확인'],
    requirements: [{ id: 'unification-practice', label: '학교통일교육 실제 실천·검증 자료' }, { id: 'unification-submissions', label: '연구보고서PDF·요약서·기관장 추천 및 발표 자료' }] }, 'unification-summary', ['요약서 A4 한 면 · 도표 사용 금지', '필요성/목적·대상/기간·실행·검증/결과·결론/제언을 실제 보고서 근거로 확인']),
  ...pair({ id: 'science-guidance-report', competitionId: 'science-guidance', label: '과학전람회 학생작품 지도논문 설명서', source: sources.science, page: sciencePage,
    formatSummary: ['휴먼명조11pt·줄간격160%·대제목15pt·A4', '좌우20mm·위아래15mm·머리말/꼬리말10mm'], interpretationNotes: scienceNotes, checks: scienceChecks, requirements: scienceRequirements,
    labels: { ...labels, need: '지도 동기와 목적', design: '지도 계획과 방법', practice: '실제 지도 과정', results: '지도 결과와 교육적 효과', reflection: '결론과 활용' } }, 'science-guidance-summary', ['지도논문 요약서 A4 1매 · 실제 지도 과정과 교육적 효과만 포함', '원본과 개인정보 삭제본 및 전국과학전람회 지도교원 자격 확인']),
  ...pair({ id: 'invention-guidance-report', competitionId: 'invention-guidance', label: '과학발명품 학생작품 지도논문 설명서', source: sources.invention, page: sciencePage,
    formatSummary: ['휴먼명조11pt·줄간격160%·대제목15pt·A4', '좌우20mm·위아래15mm·머리말/꼬리말10mm'], interpretationNotes: scienceNotes, checks: scienceChecks, requirements: scienceRequirements,
    labels: { ...labels, need: '지도 동기와 목적', design: '지도 계획과 방법', practice: '실제 지도 과정', results: '지도 결과와 교육적 효과', reflection: '결론과 활용' } }, 'invention-guidance-summary', ['지도논문 요약서 A4 1매 · 실제 지도 과정과 교육적 효과만 포함', '원본과 개인정보 삭제본 및 전국학생과학발명품경진대회 지도교원 자격 확인']),
  ...pair({ id: 'teacher-invention-report', competitionId: 'teacher-invention', label: '교원 발명연구 보고서 · 2025 참고/최신 미확인', source: sources.teacherInvention,
    year: 2025, version: '2025-checked-2026-10-02-v1', policy: 'reference', page: { ...sciencePage, fontFace: '바탕체', fontSizes: undefined },
    formatSummary: ['2025 공고: 바탕체11pt·줄간격160%', '여백: 위/아래15·좌/우20·머리말/꼬리말10 · 2026 요강 미확인'],
    interpretationNotes: [unitNote, 'A4 세로·제본0mm·들여쓰기/문단간격0pt·제목16pt·표지/목차12pt는 앱 기본값입니다. 2025 참고 초안을 최신 공식 서식으로 취급하지 않습니다.'],
    checks: ['2025 보고서20page 내외는 엄격한 상한이 아니며 분량은 심사에 영향 없음', '2025 요약서3page 이내·부록10page 이내(보고서 분량 제외)', '기명HWP·익명PDF 및 참가신청서PDF·참고문헌·공식 표지 확인', '2026 개최 여부·운영요강 미확인 · 해당 연도 공식 공고부터 확인'],
    requirements: [{ id: 'teacher-invention-current', label: '최신 공식 운영요강·참가 자격·실제 발명교육 연구 근거' }, { id: 'teacher-invention-files', label: '해당 연도 공식 기명/익명 보고서·신청서·발표 자료' }] }, 'teacher-invention-summary', ['2025 참고 요약서3page 이내 · 2026 기준으로 적용하지 않음', '실제 발명교육 연구의 목적·과정·결과만 포함']),
  profile({ id: 'paper', competitionId: 'paper', label: '일반 논문 구성 초안', source: null, documentType: 'paper', policy: 'reference', labels: paperLabels,
    coverHeading: '논문 구성 초안', coverFields: [], includeToc: false,
    formatSummary: ['공식 대회·학회 규정이 없는 앱 참고 서식 · 함초롬바탕12pt·160%'], checks: ['학회·대학·기관의 별도 투고 형식·인용 기준·분량을 직접 확인'] }),
  profile({ id: 'custom', competitionId: 'custom', label: '사용자 지정 서식', source: null, documentType: 'custom', policy: 'reference',
    coverHeading: '사용자 지정 구성 초안', formatSummary: ['교사가 지정한 글꼴·크기·줄간격·여백 적용 · 공식 규정 출처 없음'],
    checks: ['사용자가 지정한 수치의 실제 한글 조판과 제출기관 규정을 직접 확인'] }),
]);

/** Returned values are independent copies; callers cannot alter the catalogue. */
export function getCompetition(id: string): CompetitionDefinition | undefined {
  const found = COMPETITIONS.find((competition) => competition.id === id);
  return found ? structuredClone(found) : undefined;
}
export function getDraftProfile(id: string): DraftProfile | undefined {
  const found = DRAFT_PROFILES.find((candidate) => candidate.id === id);
  return found ? structuredClone(found) : undefined;
}
function invalidSelection(): never {
  throw new EngineError('FILE_INVALID_PACKAGE', ERROR_MESSAGES.FILE_INVALID_PACKAGE);
}
function unsupportedSelection(): never {
  throw new EngineError('FILE_UNSUPPORTED', ERROR_MESSAGES.FILE_UNSUPPORTED);
}

/** Resolve selectors independently of title/paragraph validation for UI previews. */
export function getEffectiveDraftProfile(options: ResearchDraftOptions): DraftProfile {
  if (typeof options !== 'object' || options === null || options.kind !== 'competition' && options.kind !== 'paper') invalidSelection();
  if (options.profileId !== undefined && typeof options.profileId !== 'string'
    || options.stage !== undefined && !(DRAFT_STAGES as readonly unknown[]).includes(options.stage)
    || options.schoolLevel !== undefined && !(DRAFT_SCHOOL_LEVELS as readonly unknown[]).includes(options.schoolLevel)) invalidSelection();
  const id = options.profileId ?? (options.kind === 'paper' ? 'paper' : 'innovation-report');
  if (typeof id !== 'string') invalidSelection();
  const selected = getDraftProfile(id);
  if (!selected || (options.kind === 'paper') !== (selected.documentType === 'paper')) invalidSelection();
  if (options.year !== undefined && options.year !== selected.year) invalidSelection();
  const stage = options.stage ?? 'planning';
  const school = options.schoolLevel ?? 'elementary';
  if (!(DRAFT_STAGES as readonly unknown[]).includes(stage) || !(DRAFT_SCHOOL_LEVELS as readonly unknown[]).includes(school)) invalidSelection();
  const competition = getCompetition(selected.competitionId);
  if (!competition) invalidSelection();
  if (selected.policy === 'guide-only' || !selected.allowedStages.includes(stage) || !competition.schoolLevels.includes(school)
    || selected.id.startsWith('digital-management-') && school === 'kindergarten') unsupportedSelection();
  if (id !== 'custom') {
    if (options.custom !== undefined) invalidSelection();
    return selected;
  }
  if (!isCustomDraftSettings(options.custom)) invalidSelection();
  const custom = options.custom;
  const marginKeys = ['top', 'bottom', 'left', 'right', 'header', 'footer', 'gutter'] as const;
  const margins = Object.fromEntries(marginKeys.map((key) => [key, Math.round(custom.marginMm[key] * 7200 / 25.4)])) as DraftPage['margins'];
  selected.label = `${custom.name.trim()} · 사용자 지정 참고 서식`;
  selected.coverHeading = `${custom.name.trim()} 구성 초안`;
  selected.page = { ...selected.page, fontFace: custom.fontFace.trim(), fontSizePt: custom.fontSizePt, lineSpacingPercent: custom.lineSpacingPercent, margins };
  selected.labels = { ...selected.labels, ...Object.fromEntries(Object.entries(custom.labels ?? {}).map(([role, label]) => [role, label.trim()])) };
  selected.formatSummary = [`사용자 지정: ${selected.page.fontFace} ${custom.fontSizePt}pt · 줄간격${custom.lineSpacingPercent}%`, '여백은 사용자가 입력한 mm 수치를 HWPUNIT로 반올림하여 적용'];
  selected.interpretationNotes = [textDraftNote, '공식 규정 출처가 없는 사용자 지정 참고 서식입니다. 용지는 앱 기본 A4 세로이며 제목16pt·표지/목차12pt·들여쓰기10pt·문단 위/아래0pt입니다.'];
  selected.prompts = Object.fromEntries(selected.roles.map((role) => [role, `${selected.labels[role]}에 필요한 실제 내용을 직접 확인하고 보충하세요. 없는 성과·수치·인용은 만들지 마세요.`]));
  return selected;
}
