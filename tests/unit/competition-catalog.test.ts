import { describe, expect, it } from 'vitest';
import { COMPETITIONS, DRAFT_PROFILES, DRAFT_STAGE_LABELS, SCHOOL_LEVEL_LABELS, getCompetition, getDraftProfile, getEffectiveDraftProfile } from '../../src/domain/competitions';
import { EngineError, ERROR_MESSAGES, type ErrorCode } from '../../src/domain/errors';
import { DRAFT_ROLES, DRAFT_SCHOOL_LEVELS, DRAFT_STAGES, type CustomDraftSettings, type ResearchDraftOptions } from '../../src/domain/research';

function options(overrides: Partial<ResearchDraftOptions> = {}): ResearchDraftOptions {
  return { kind: 'competition', title: '', subject: '', grade: '', studentCount: '', assignments: [], ...overrides };
}
function custom(): CustomDraftSettings {
  return { name: '  교사 지정  ', fontFace: '  함초롬바탕  ', fontSizePt: 10.25, lineSpacingPercent: 175,
    marginMm: { top: 18.5, bottom: 21.25, left: 24, right: 19, header: 9, footer: 8, gutter: 2.5 },
    labels: { need: '  연구 배경  ', results: '  직접 확인한 결과  ' } };
}
function rejects(selection: unknown, code: ErrorCode = 'FILE_INVALID_PACKAGE'): void {
  let caught: unknown;
  try { getEffectiveDraftProfile(selection as ResearchDraftOptions); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(EngineError);
  expect(caught).toMatchObject({ code, message: ERROR_MESSAGES[code] });
}

const expectedProfiles = [
  'innovation-report', 'field-report', 'field-summary',
  'digital-teaching-report', 'digital-teaching-summary', 'digital-software-report', 'digital-software-summary', 'digital-management-report', 'digital-management-summary',
  'character-teacher-report', 'character-teacher-summary', 'character-institution-report', 'character-institution-summary',
  'data-description', 'data-summary', 'ebs-posting-description', 'ebs-review-description', 'career-plan', 'career-application',
  'unification-report', 'unification-summary', 'science-guidance-report', 'science-guidance-summary', 'invention-guidance-report', 'invention-guidance-summary',
  'teacher-invention-report', 'teacher-invention-summary', 'paper', 'custom',
];

describe('competition catalogue and official-source boundaries', () => {
  it('registers the requested document variants exactly once and resolves every family', () => {
    expect(DRAFT_PROFILES.map((profile) => profile.id).sort()).toEqual([...expectedProfiles].sort());
    expect(new Set(COMPETITIONS.map((competition) => competition.id)).size).toBe(13);
    for (const profile of DRAFT_PROFILES) {
      expect(getDraftProfile(profile.id)).toEqual(profile);
      expect(getCompetition(profile.competitionId)).toBeDefined();
      expect(profile.version).toContain('2026-10-02');
      expect(profile.roles.length).toBeGreaterThan(0);
      expect(profile.checks.join(' ')).toContain('NOT_RUN');
      expect(profile.interpretationNotes.join(' ')).toContain('공식 제출 서식의 완전 재현·인증이 아닙니다');
      for (const role of profile.roles) {
        expect(profile.labels[role]).toBeTruthy();
        expect(profile.prompts[role]).toBeTruthy();
      }
      expect(profile.coverFields).not.toContain('name');
      expect(profile.coverFields).not.toContain('school');
    }
    expect(getDraftProfile('not-registered')).toBeUndefined();
    expect(getCompetition('not-registered')).toBeUndefined();
  });

  it('uses old competition names as search aliases, never duplicate current families', () => {
    expect(getCompetition('innovation')?.aliases).toContain('교실수업개선실천사례연구발표대회');
    expect(getCompetition('digital')?.aliases).toContain('교육정보화연구대회');
    expect(COMPETITIONS.filter((family) => /교육정보화|교실수업개선/u.test(family.label))).toEqual([]);
    expect(DRAFT_PROFILES.some((profile) => profile.id.includes('textbook'))).toBe(false);
  });

  it('provides every school/stage label and official sources without claiming local numeric rules are national', () => {
    expect(Object.keys(SCHOOL_LEVEL_LABELS).sort()).toEqual([...DRAFT_SCHOOL_LEVELS].sort());
    expect(Object.keys(DRAFT_STAGE_LABELS).sort()).toEqual([...DRAFT_STAGES].sort());
    for (const profile of DRAFT_PROFILES) {
      if (profile.source) {
        expect(new URL(profile.source.url).protocol).toBe('https:');
        expect(profile.source.checkedOn).toBe('2026-10-02');
        expect(profile.source.location).not.toBe('');
      } else expect(['paper', 'custom']).toContain(profile.id);
    }
    for (const profile of DRAFT_PROFILES.filter((profile) => profile.competitionId === 'character')) {
      expect(profile.source?.scope).toBe('national-notice');
      expect(profile.policy).toBe('reference');
      expect(profile.page.fontFace).toBe('함초롬바탕');
      expect(profile.page.fontSizePt).toBe(12);
      expect(profile.page.lineSpacingPercent).toBe(160);
      expect(profile.formatSummary.join(' ')).toContain('전국 공통');
      expect(profile.formatSummary.join(' ')).not.toMatch(/(?:20|40)쪽/u);
      expect(profile.interpretationNotes.join(' ')).toContain('앱 기본값');
      expect(profile.interpretationNotes.join(' ')).toContain('전국 공통 규정으로 적용하지 않습니다');
    }
  });

  it('retains the legacy innovation scaffold and exact applied page values', () => {
    const profile = getEffectiveDraftProfile(options());
    expect(profile.id).toBe('innovation-report');
    expect(profile.roles).toEqual(DRAFT_ROLES);
    expect(profile.coverHeading).toBe('2026학년도 수업혁신사례연구대회 보고서');
    expect(profile.labels).toEqual({ summary: '요약서', need: '연구의 필요성과 목적', design: '수업 설계와 연구 방법', practice: '수업 실행', results: '실행 결과와 근거', reflection: '성찰·환류와 확산', references: '참고문헌', appendix: '부록' });
    expect(profile.page).toEqual({ fontFace: '휴먼명조', fontSizePt: 12, lineSpacingPercent: 160, width: 59528, height: 84188,
      margins: { top: 4252, bottom: 4252, left: 7087, right: 7087, header: 4252, footer: 4252, gutter: 2835 }, indent: 1000, beforeSpacing: 500, afterSpacing: 0 });
    expect(profile.includeToc).toBe(true);
    expect(profile.source?.scope).toBe('national');
    expect(profile.interpretationNotes.join(' ')).toContain('단위가 생략');
    expect(profile.interpretationNotes.join(' ')).toContain('A4 세로 용지');
    expect(profile.interpretationNotes.join(' ')).toContain('앱 기본값');
    expect(profile.checks.join(' ')).not.toMatch(/양면|흑백|좌철/u);
  });

  it('applies KFTA exact body values while marking unspecified units and defaults', () => {
    for (const id of ['field-report', 'field-summary', 'data-description', 'data-summary']) {
      const profile = getDraftProfile(id)!;
      expect(profile.page).toMatchObject({ fontFace: '휴먼명조', fontSizePt: 11, lineSpacingPercent: 140,
        margins: { top: 5669, bottom: 5669, left: 7087, right: 5669, header: 4252, footer: 4252, gutter: 0 }, indent: 1000, beforeSpacing: 0 });
      expect(profile.interpretationNotes.join(' ')).toContain('단위가 생략');
      expect(profile.interpretationNotes.join(' ')).toContain('앱 기본값');
    }
    expect(getDraftProfile('field-report')?.checks.join(' ')).toContain('50쪽');
    expect(getDraftProfile('field-summary')?.checks.join(' ')).toContain('도표 사용 금지');
    expect(getDraftProfile('data-description')?.checks.join(' ')).toContain('30쪽');
    expect(getDraftProfile('data-description')?.requirements.some((item) => item.label.includes('실제 출품자료'))).toBe(true);
  });

  it('separates digital division caps and the official headings from free body-size settings', () => {
    for (const id of expectedProfiles.filter((id) => id.startsWith('digital-'))) {
      const profile = getDraftProfile(id)!;
      expect(profile.page).toMatchObject({ fontFace: '바탕체', fontSizePt: 12, lineSpacingPercent: 160, indent: 0,
        margins: { top: 2835, bottom: 2835, left: 5669, right: 5669, header: 2835, footer: 2835, gutter: 0 },
        fontSizes: { title: 20, heading: 15, references: 14 } });
      expect(profile.interpretationNotes.join(' ')).toContain('본문 글씨 크기는 요강에서 자유');
      expect(profile.interpretationNotes.join(' ')).toContain('공식 고정값이 아닙니다');
      expect(profile.interpretationNotes.join(' ')).toContain('단위가 생략');
    }
    expect(getDraftProfile('digital-teaching-report')?.checks.join(' ')).toContain('본문20쪽·요약5쪽');
    expect(getDraftProfile('digital-software-report')?.checks.join(' ')).toContain('본문10쪽·요약2쪽');
    expect(getDraftProfile('digital-management-report')?.requirements.some((item) => item.label.includes('2026 학교교육계획서'))).toBe(true);
  });

  it('uses explicit national millimetres for both separate science guidance contests', () => {
    for (const family of ['science', 'invention']) {
      const profile = getDraftProfile(`${family}-guidance-report`)!;
      expect(profile.page).toMatchObject({ fontFace: '휴먼명조', fontSizePt: 11, lineSpacingPercent: 160,
        margins: { top: 4252, bottom: 4252, left: 5669, right: 5669, header: 2835, footer: 2835, gutter: 0 }, fontSizes: { heading: 15 } });
      expect(profile.interpretationNotes.join(' ')).toContain('전국 요강 명시값');
      expect(profile.checks.join(' ')).toContain('20쪽');
      expect(profile.checks.join(' ')).toContain('학생 작품 설명서를 복사하지');
    }
    expect(getDraftProfile('science-guidance-report')?.source?.url).toContain('/157/');
    expect(getDraftProfile('invention-guidance-report')?.source?.url).toContain('/154/');
  });

  it('keeps report and summary roles separate and exposes missing-content prompts', () => {
    for (const profile of DRAFT_PROFILES.filter((profile) => profile.documentType === 'summary')) {
      expect(profile.roles).toEqual(['summary']);
      expect(profile.includeToc).toBe(false);
      expect(profile.interpretationNotes.join(' ')).toContain('요약문을 자동으로 새로 쓰지 않습니다');
      expect(profile.prompts.summary).toContain('없는 연구 내용');
    }
    const plan = getDraftProfile('career-plan')!;
    expect(plan.roles).toEqual(['need', 'practice', 'design']);
    expect(plan.labels.need).toBe('총괄표');
    expect(plan.checks.join(' ')).toContain('공식 총괄표/프로그램 표 구조는 수동 작성');
    expect(getDraftProfile('career-application')?.roles).toEqual(['practice', 'design', 'results', 'reflection']);
  });

  it('makes EBS an order-preserving preparation profile with AI and final-file constraints', () => {
    for (const id of ['ebs-posting-description', 'ebs-review-description']) {
      const profile = getDraftProfile(id)!;
      expect(profile.policy).toBe('format-only');
      expect(profile.coverFields).toEqual([]);
      expect(profile.includeToc).toBe(false);
      expect(profile.roles).toEqual(DRAFT_ROLES);
      expect(profile.formatSummary.join(' ')).toContain('문장·문단 순서를 그대로 유지');
      expect(profile.formatSummary.join(' ')).toContain('고정 수치 미확인');
      expect(profile.interpretationNotes.join(' ')).toContain('앱 기본값');
      expect(profile.checks.join(' ')).toContain('구성안·스크립트 작성 시 심사 제외');
      expect(profile.checks.join(' ')).toContain('PDF');
      expect(profile.checks.join(' ')).toContain('MP4');
      expect(profile.formatSummary.join(' ')).not.toMatch(/[0-9]+쪽/u);
    }
  });
});

describe('profile resolution and safe selector validation', () => {
  it('previews selections without requiring title/assignment content and retains default paper format', () => {
    expect(getEffectiveDraftProfile(options()).id).toBe('innovation-report');
    const paper = getEffectiveDraftProfile(options({ kind: 'paper' }));
    expect(paper.id).toBe('paper');
    expect(paper.source).toBeNull();
    expect(paper.page).toMatchObject({ fontFace: '함초롬바탕', fontSizePt: 12, lineSpacingPercent: 160, beforeSpacing: 0, indent: 1000 });
  });

  it.each(['character-teacher-report', 'character-teacher-summary', 'character-institution-report', 'character-institution-summary', 'ebs-posting-description', 'ebs-review-description'])('blocks national rewriting for %s', (profileId) => {
    expect(getEffectiveDraftProfile(options({ profileId, stage: 'regional' })).id).toBe(profileId);
    rejects(options({ profileId, stage: 'national' }), 'FILE_UNSUPPORTED');
  });

  it('enforces school and division eligibility even through direct engine selectors', () => {
    rejects(options({ profileId: 'innovation-report', schoolLevel: 'kindergarten' }), 'FILE_UNSUPPORTED');
    rejects(options({ profileId: 'digital-management-report', schoolLevel: 'kindergarten' }), 'FILE_UNSUPPORTED');
    rejects(options({ profileId: 'digital-management-summary', stage: 'regional' }), 'FILE_UNSUPPORTED');
    expect(getEffectiveDraftProfile(options({ profileId: 'digital-teaching-report', schoolLevel: 'kindergarten' })).id).toBe('digital-teaching-report');
    expect(getEffectiveDraftProfile(options({ profileId: 'digital-management-report', stage: 'national' })).id).toBe('digital-management-report');
    for (const school of DRAFT_SCHOOL_LEVELS) expect(getEffectiveDraftProfile(options({ kind: 'paper', schoolLevel: school })).id).toBe('paper');
  });

  it('does not silently reinterpret previous-year teacher-invention references as 2026', () => {
    const profile = getEffectiveDraftProfile(options({ profileId: 'teacher-invention-report', year: 2025 }));
    expect(profile.year).toBe(2025);
    expect(profile.policy).toBe('reference');
    expect(profile.source?.scope).toBe('previous-year');
    expect(profile.source?.label).toContain('2026 운영요강 미확인');
    expect(profile.page.fontFace).toBe('바탕체');
    expect(profile.page.fontSizePt).toBe(11);
    expect(profile.checks.join(' ')).toContain('엄격한 상한이 아니며');
    rejects(options({ profileId: profile.id, year: 2026 }));
  });

  it.each([
    null, {}, { kind: 'wrong' }, options({ profileId: 'not-real' }), options({ profileId: '교육정보화연구대회' }),
    options({ profileId: 'innovation-report', kind: 'paper' }), options({ profileId: 'paper' }),
    options({ year: 2025 }), { ...options(), year: '2026' }, { ...options(), year: NaN },
    { ...options(), profileId: null }, { ...options(), stage: null }, { ...options(), schoolLevel: null },
    { ...options(), stage: 'final' }, { ...options(), schoolLevel: 'college' }, options({ custom: custom() }),
    options({ profileId: 'custom' }), options({ profileId: 'custom', custom: custom(), kind: 'paper' }),
  ])('rejects malformed or mismatched selectors without reflecting input into errors: %j', (selection) => rejects(selection));

  it('returns defensive copies while deeply freezing shared catalogue data', () => {
    const first = getDraftProfile('innovation-report')!;
    first.page.fontFace = 'caller mutation';
    first.page.margins.left = 0;
    (first.roles as DraftRoleMutable[]).pop();
    first.source!.label = 'caller source';
    expect(getDraftProfile('innovation-report')?.page.fontFace).toBe('휴먼명조');
    expect(getDraftProfile('innovation-report')?.page.margins.left).toBe(7087);
    expect(getDraftProfile('innovation-report')?.roles).toEqual(DRAFT_ROLES);
    expect(getDraftProfile('innovation-report')?.source?.label).not.toBe('caller source');
    const family = getCompetition('digital')!;
    (family.aliases as string[]).push('caller alias');
    expect(getCompetition('digital')?.aliases).toEqual(['교육정보화연구대회']);
    expect(Object.isFrozen(COMPETITIONS)).toBe(true);
    expect(Object.isFrozen(DRAFT_PROFILES)).toBe(true);
    expect(Object.isFrozen(DRAFT_PROFILES[0]?.page.margins)).toBe(true);
    expect(() => { DRAFT_PROFILES[0]!.page.margins.left = 0; }).toThrow(TypeError);
  });
});

type DraftRoleMutable = typeof DRAFT_ROLES[number];

describe('custom reference profiles', () => {
  it('canonicalizes only settings labels and converts every supplied mm value independently', () => {
    const settings = custom();
    const untouched = structuredClone(settings);
    const profile = getEffectiveDraftProfile(options({ profileId: 'custom', custom: settings }));
    expect(settings).toEqual(untouched);
    expect(profile.source).toBeNull();
    expect(profile.policy).toBe('reference');
    expect(profile.page.fontFace).toBe('함초롬바탕');
    expect(profile.page.fontSizePt).toBe(10.25);
    expect(profile.page.lineSpacingPercent).toBe(175);
    for (const [key, mm] of Object.entries(settings.marginMm)) expect(profile.page.margins[key as keyof typeof profile.page.margins]).toBe(Math.round(mm * 7200 / 25.4));
    expect(profile.labels.need).toBe('연구 배경');
    expect(profile.labels.results).toBe('직접 확인한 결과');
    expect(profile.labels.references).toBe('참고문헌');
    expect(profile.prompts.need).toContain('연구 배경');
    expect(profile.interpretationNotes.join(' ')).toContain('공식 규정 출처가 없는');
    profile.page.margins.left = 0;
    expect(getEffectiveDraftProfile(options({ profileId: 'custom', custom: settings })).page.margins.left).toBe(Math.round(24 * 7200 / 25.4));
  });

  it.each([
    { ...custom(), fontSizePt: 5.99 }, { ...custom(), fontSizePt: 72.01 }, { ...custom(), fontSizePt: 10.255 }, { ...custom(), fontSizePt: Infinity },
    { ...custom(), lineSpacingPercent: 79 }, { ...custom(), lineSpacingPercent: 301 }, { ...custom(), lineSpacingPercent: 160.5 },
    { ...custom(), name: ' ' }, { ...custom(), fontFace: '\u0000bad' }, { ...custom(), fontFace: ' ' },
    { ...custom(), labels: { unapproved: '제목' } }, { ...custom(), labels: { need: ' ' } },
    { ...custom(), marginMm: { ...custom().marginMm, left: -1 } }, { ...custom(), marginMm: { ...custom().marginMm, right: 81 } },
    { ...custom(), marginMm: { ...custom().marginMm, top: NaN } },
    { ...custom(), marginMm: { ...custom().marginMm, left: 80, right: 80, gutter: 50 } },
  ])('rejects custom bounds or unapproved role overrides: %j', (settings) => rejects(options({ profileId: 'custom', custom: settings as CustomDraftSettings })));

  it('accepts inclusive font/line/margin endpoints without changing the pinned base profile', () => {
    for (const [fontSizePt, lineSpacingPercent] of [[6, 80], [72, 300]]) {
      const settings = { ...custom(), fontSizePt: fontSizePt!, lineSpacingPercent: lineSpacingPercent!, marginMm: { top: 0, bottom: 80, left: 80, right: 0, header: 0, footer: 80, gutter: 0 } };
      expect(getEffectiveDraftProfile(options({ profileId: 'custom', custom: settings })).page.fontSizePt).toBe(fontSizePt);
    }
    expect(getDraftProfile('custom')?.page.fontSizePt).toBe(12);
    expect(getDraftProfile('custom')?.page.margins.left).toBe(5669);
  });
});
