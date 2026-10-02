import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DocumentInspection } from '../domain/document';
import type { DraftProfile } from '../domain/competition-types';
import { COMPETITIONS, DRAFT_PROFILES, DRAFT_STAGE_LABELS, SCHOOL_LEVEL_LABELS, getCompetition, getDraftProfile, getEffectiveDraftProfile } from '../domain/competitions';
import { DRAFT_LIMITS, DRAFT_ROLES, DRAFT_SCHOOL_LEVELS, DRAFT_STAGES, isCustomDraftSettings, isDraftRole } from '../domain/research';
import type { CustomDraftSettings, DraftParagraph, DraftRole, DraftSchoolLevel, DraftStage, ResearchDraftKind, ResearchDraftOptions, ResearchDraftResult } from '../domain/research';
import { recommendDraft } from '../engine/draft/plan';
import { PROFILE_POLICY_LABELS, sourceStatus } from './CompetitionCatalogOverview';
import CustomDraftSettingsEditor from './CustomDraftSettingsEditor';
import './ResearchDraftPanel.css';

const PARAGRAPH_PAGE_SIZE = 40;
const PREVIEW_LENGTH = 500;
const TEXT_WINDOW_SIZE = 3000;
const DEFAULT_CUSTOM: CustomDraftSettings = {
  name: '나의 참고 기준', fontFace: '함초롬바탕', fontSizePt: 12, lineSpacingPercent: 160,
  marginMm: { top: 20, bottom: 20, left: 20, right: 20, header: 15, footer: 15, gutter: 0 },
};

export interface ResearchDraftPanelProps {
  inspection: DocumentInspection;
  disabled: boolean;
  onGenerate: (options: ResearchDraftOptions) => void;
  onCancel: () => void;
  generating: boolean;
  result: ResearchDraftResult | null;
  error: string | null;
  onDownload: () => void;
  onInvalidate: () => void;
}

function recommendedAssignments(paragraphs: DraftParagraph[]): Record<string, DraftRole> {
  return Object.fromEntries(paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.role]));
}

function suggestedSummaryIds(paragraphs: DraftParagraph[]): string[] {
  return paragraphs.filter((paragraph) => /(?:^|\n)[ \t]*(?:\[합성 자료\][ \t]*)?(?:요약(?:서)?|초록)[ \t]*[:：]?/u.test(paragraph.text.slice(0, 500)))
    .map((paragraph) => paragraph.paragraphId);
}

function textWindow(text: string, part: number, size: number): string {
  let start = part * size;
  let end = Math.min(start + size, text.length);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? '') && /[\uD800-\uDBFF]/u.test(text[start - 1] ?? '')) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? '') && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end -= 1;
  return text.slice(start, end);
}

function profileSelection(profile: DraftProfile, stage: DraftStage, schoolLevel: DraftSchoolLevel, custom: CustomDraftSettings): Partial<ResearchDraftOptions> {
  return { profileId: profile.id, year: profile.year, stage, schoolLevel, ...(profile.id === 'custom' ? { custom } : {}) };
}

export default function ResearchDraftPanel({ inspection, disabled, onGenerate, onCancel, generating, result, error, onDownload, onInvalidate }: ResearchDraftPanelProps) {
  const id = useId();
  const [kind, setKind] = useState<ResearchDraftKind>('competition');
  const [profileId, setProfileId] = useState('innovation-report');
  const [stage, setStage] = useState<DraftStage>('planning');
  const [schoolLevel, setSchoolLevel] = useState<DraftSchoolLevel>('elementary');
  const [competitionSearch, setCompetitionSearch] = useState('');
  const [custom, setCustom] = useState<CustomDraftSettings>(() => structuredClone(DEFAULT_CUSTOM));
  const baseProfile = useMemo(() => getDraftProfile(profileId) ?? getDraftProfile('innovation-report')!, [profileId]);
  const selection = useMemo(() => profileSelection(baseProfile, stage, schoolLevel, custom), [baseProfile, stage, schoolLevel, custom]);
  const effective = useMemo(() => {
    try { return { profile: getEffectiveDraftProfile({ kind, title: '', subject: '', grade: '', studentCount: '', assignments: [], ...selection }), valid: true }; }
    catch { return { profile: baseProfile, valid: false }; }
  }, [kind, selection, baseProfile]);
  const profile = effective.profile;
  const competition = useMemo(() => getCompetition(baseProfile.competitionId), [baseProfile.competitionId]);
  const recommendation = useMemo(() => recommendDraft(inspection, kind, selection), [inspection, kind, selection]);
  const [assignments, setAssignments] = useState<Record<string, DraftRole>>(() => recommendedAssignments(recommendDraft(inspection, 'competition', { profileId: 'innovation-report', year: 2026, stage: 'planning', schoolLevel: 'elementary' }).paragraphs));
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [grade, setGrade] = useState('');
  const [studentCount, setStudentCount] = useState('');
  const [researchType, setResearchType] = useState<'individual' | 'joint' | ''>('');
  const [supplementTexts, setSupplementTexts] = useState<Partial<Record<DraftRole, string>>>({});
  const [includedSupplements, setIncludedSupplements] = useState<Partial<Record<DraftRole, boolean>>>({});
  const [summaryIds, setSummaryIds] = useState<string[]>([]);
  const [summaryConfirmed, setSummaryConfirmed] = useState(false);
  const [preparationChecks, setPreparationChecks] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<DraftRole | 'all'>('all');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [textPart, setTextPart] = useState(0);
  const [roleChangeNotice, setRoleChangeNotice] = useState('');
  const roleFilterRef = useRef<HTMLSelectElement>(null);
  const locked = disabled || generating;
  const isSummary = profile.documentType === 'summary';
  const formatOnly = profile.policy === 'format-only';
  const labels = profile.labels;
  const roles = profile.roles;
  const customValid = profileId !== 'custom' || isCustomDraftSettings(custom);
  const stageAllowed = profile.allowedStages.includes(stage);
  const schoolAllowed = !competition || competition.schoolLevels.includes(schoolLevel);
  const canAuthor = recommendation.eligible && effective.valid && customValid && stageAllowed && schoolAllowed && profile.policy !== 'guide-only';
  const activeSupplements = roles.flatMap((role) => !formatOnly && includedSupplements[role] && supplementTexts[role]?.trim() ? [{ role, text: supplementTexts[role]! }] : []);
  const sourceCharacterCount = recommendation.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  const combinedTextWithinLimit = sourceCharacterCount + activeSupplements.reduce((sum, supplement) => sum + supplement.text.length, 0) <= DRAFT_LIMITS.maxTextCharacters;
  const validSummaryIds = summaryIds.filter((paragraphId) => recommendation.paragraphs.some((paragraph) => paragraph.paragraphId === paragraphId));
  const summaryReady = !isSummary || (validSummaryIds.length > 0 && summaryConfirmed);
  const familyProfiles = DRAFT_PROFILES.filter((value) => value.competitionId === baseProfile.competitionId);
  const familyYears = [...new Set(familyProfiles.map((value) => value.year))].sort((left, right) => right - left);
  const yearProfiles = familyProfiles.filter((value) => value.year === baseProfile.year);
  const matchingCompetitions = useMemo(() => {
    const query = competitionSearch.trim().toLocaleLowerCase('ko-KR');
    return COMPETITIONS.filter((value) => value.id !== 'paper' && value.schoolLevels.includes(schoolLevel)
      && (query.length === 0 || [value.label, ...value.aliases].some((name) => name.toLocaleLowerCase('ko-KR').includes(query))));
  }, [competitionSearch, schoolLevel]);
  const selectableCompetitions = competition && !matchingCompetitions.some((value) => value.id === competition.id) ? [competition, ...matchingCompetitions] : matchingCompetitions;
  const sourcePositions = useMemo(() => {
    const sectionNumbers = new Map(inspection.sections.map((section, index) => [section.nodeId, index + 1]));
    return new Map(inspection.paragraphs.map((paragraph, index) => [paragraph.nodeId, { index: index + 1, section: sectionNumbers.get(paragraph.sectionId) ?? null }]));
  }, [inspection]);
  const filteredParagraphs = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ko-KR');
    return recommendation.paragraphs.filter((paragraph) => {
      const assigned = assignments[paragraph.paragraphId] ?? paragraph.role;
      return (roleFilter === 'all' || assigned === roleFilter) && (query.length === 0 || paragraph.text.toLocaleLowerCase('ko-KR').includes(query));
    });
  }, [recommendation.paragraphs, assignments, roleFilter, search]);
  const pageCount = Math.max(1, Math.ceil(filteredParagraphs.length / PARAGRAPH_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleParagraphs = filteredParagraphs.slice(currentPage * PARAGRAPH_PAGE_SIZE, (currentPage + 1) * PARAGRAPH_PAGE_SIZE);
  const missingRoles = roles.filter((role) => !recommendation.paragraphs.some((paragraph) => paragraph.text.trim().length > 0 && (assignments[paragraph.paragraphId] ?? paragraph.role) === role) && !activeSupplements.some((supplement) => supplement.role === role));
  const coverValues = { schoolLevel: SCHOOL_LEVEL_LABELS[schoolLevel], subject, researchType, grade, studentCount };
  const coverLabels = { schoolLevel: '학교급', subject: '출품교과', researchType: '연구형태', grade: '학년', studentCount: '학생 수' };
  const missingCoverFields = profile.coverFields.filter((field) => coverValues[field].trim().length === 0).map((field) => coverLabels[field]);
  const resultIsSummary = result?.sourceSelection === 'summary-selection';

  function resetView() { setPage(0); setExpandedId(null); setTextPart(0); setRoleChangeNotice(''); }
  function resetAuthoring(nextProfile: DraftProfile, nextStage: DraftStage, nextSchool: DraftSchoolLevel) {
    const nextKind = nextProfile.competitionId === 'paper' ? 'paper' : 'competition';
    const nextRecommendation = recommendDraft(inspection, nextKind, profileSelection(nextProfile, nextStage, nextSchool, custom));
    setAssignments(recommendedAssignments(nextRecommendation.paragraphs));
    setSummaryIds(nextProfile.documentType === 'summary' ? suggestedSummaryIds(nextRecommendation.paragraphs) : []);
    setSummaryConfirmed(false); setIncludedSupplements({}); setRoleFilter('all'); resetView();
  }
  function selectProfile(nextId: string) {
    if (locked || nextId === profileId) return;
    const next = getDraftProfile(nextId); if (!next) return;
    onInvalidate(); setProfileId(next.id); setKind(next.competitionId === 'paper' ? 'paper' : 'competition'); resetAuthoring(next, stage, schoolLevel);
  }
  function selectCompetition(nextId: string) {
    if (locked || nextId === baseProfile.competitionId) return;
    const candidates = DRAFT_PROFILES.filter((value) => value.competitionId === nextId);
    const next = candidates.find((value) => value.year === baseProfile.year) ?? [...candidates].sort((left, right) => right.year - left.year)[0];
    if (next) selectProfile(next.id);
  }
  function selectYear(nextYear: string) {
    if (locked || nextYear === String(baseProfile.year)) return;
    const candidates = familyProfiles.filter((value) => String(value.year) === nextYear);
    const next = candidates.find((value) => value.documentType === baseProfile.documentType) ?? candidates[0]; if (next) selectProfile(next.id);
  }
  function selectStage(value: string) {
    if (locked || !(DRAFT_STAGES as readonly string[]).includes(value) || value === stage) return;
    const next = value as DraftStage; onInvalidate(); setStage(next); resetAuthoring(baseProfile, next, schoolLevel);
  }
  function selectSchool(value: string) {
    if (locked || !(DRAFT_SCHOOL_LEVELS as readonly string[]).includes(value) || value === schoolLevel) return;
    const next = value as DraftSchoolLevel; onInvalidate(); setSchoolLevel(next); setGrade(''); resetAuthoring(baseProfile, stage, next);
  }
  function changeRole(paragraph: DraftParagraph, role: string, number: number) {
    if (locked || formatOnly || isSummary || !isDraftRole(role) || !roles.includes(role) || role === (assignments[paragraph.paragraphId] ?? paragraph.role)) return;
    onInvalidate(); setAssignments((previous) => ({ ...previous, [paragraph.paragraphId]: role }));
    if (roleFilter !== 'all' && role !== roleFilter) { roleFilterRef.current?.focus(); setExpandedId(null); setTextPart(0); setRoleChangeNotice(`문단 ${number}을 ${labels[role]} 항목에 배치했습니다. 현재 필터에서는 제외됩니다.`); }
    else setRoleChangeNotice(`문단 ${number}을 ${labels[role]} 항목에 배치했습니다.`);
  }
  function resetRecommendations() {
    if (locked) return;
    const nextSummary = suggestedSummaryIds(recommendation.paragraphs);
    if ((isSummary && (summaryConfirmed || nextSummary.join('|') !== summaryIds.join('|'))) || recommendation.paragraphs.some((paragraph) => (assignments[paragraph.paragraphId] ?? paragraph.role) !== paragraph.role)) onInvalidate();
    setAssignments(recommendedAssignments(recommendation.paragraphs)); if (isSummary) { setSummaryIds(nextSummary); setSummaryConfirmed(false); } setRoleFilter('all'); resetView();
  }
  function toggleSummary(paragraphId: string, include: boolean) {
    if (locked || !isSummary) return;
    onInvalidate(); setSummaryConfirmed(false); setSummaryIds((previous) => include ? previous.includes(paragraphId) ? previous : [...previous, paragraphId] : previous.filter((value) => value !== paragraphId));
  }
  function togglePreparation(key: string, checked: boolean) { setPreparationChecks((previous) => ({ ...previous, [key]: checked })); }
  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || !canAuthor || !summaryReady || !combinedTextWithinLimit || title.trim().length === 0) return;
    onGenerate({ kind, title, subject, grade, studentCount, ...selection,
      ...(researchType ? { researchType } : {}), ...(formatOnly ? {} : { supplements: activeSupplements }),
      ...(isSummary ? { summaryParagraphIds: validSummaryIds, summarySelectionConfirmed: true } : {}),
      assignments: recommendation.paragraphs.map((paragraph) => ({ paragraphId: paragraph.paragraphId, sourceText: paragraph.text, role: formatOnly || isSummary ? paragraph.role : assignments[paragraph.paragraphId] ?? paragraph.role })),
    });
  }

  return <section className="panel research-draft-panel" aria-labelledby={`${id}-heading`}>
    <div className="draft-panel-heading"><div><p className="eyebrow">원문으로 만드는 새 문서</p><h2 id={`${id}-heading`}>보고서·논문 초안 만들기</h2></div><span className="badge">별도 HWPX 생성</span></div>
    <p className="draft-introduction">대회와 문서 종류에 맞는 기준을 선택하고 원문 배치를 검토합니다. 업로드한 원본은 그대로 보관됩니다. 연구 결과나 인용문을 자동으로 만들어 채우지 않습니다.</p>
    <div className="draft-kind-selector" role="group" aria-label="초안 종류"><button type="button" aria-pressed={profileId === 'innovation-report'} disabled={locked} onClick={() => selectProfile('innovation-report')}>수업혁신사례연구대회 보고서</button><button type="button" aria-pressed={kind === 'paper'} disabled={locked} onClick={() => selectProfile('paper')}>논문 참고 구성</button></div>
    {kind === 'competition' && <fieldset className="draft-competition-settings" disabled={locked}><legend>대회와 작성 기준</legend><div className="draft-selection-grid">
      <label htmlFor={`${id}-school`}>학교급 선택<select id={`${id}-school`} value={schoolLevel} onChange={(event) => selectSchool(event.target.value)}>{DRAFT_SCHOOL_LEVELS.map((value) => <option key={value} value={value}>{SCHOOL_LEVEL_LABELS[value]}</option>)}</select></label>
      <label htmlFor={`${id}-competition-search`} className="draft-family-search">대회 검색<input id={`${id}-competition-search`} type="search" maxLength={120} value={competitionSearch} placeholder="정식 명칭이나 옛 이름" onChange={(event) => setCompetitionSearch(event.target.value)} /></label>
      <label htmlFor={`${id}-competition`} className="draft-family-select">대회 선택<select id={`${id}-competition`} value={baseProfile.competitionId} onChange={(event) => selectCompetition(event.target.value)}>{selectableCompetitions.map((value) => <option key={value.id} value={value.id}>{value.label}{!matchingCompetitions.some((match) => match.id === value.id) ? ' (현재 선택)' : ''}</option>)}</select></label>
      <label htmlFor={`${id}-year`}>기준 연도<select id={`${id}-year`} value={baseProfile.year} onChange={(event) => selectYear(event.target.value)}>{familyYears.map((value) => <option key={value} value={value}>{value}년</option>)}</select></label>
      <label htmlFor={`${id}-profile`} className="draft-profile-select">문서·분과 선택<select id={`${id}-profile`} value={profileId} onChange={(event) => selectProfile(event.target.value)}>{yearProfiles.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
      <label htmlFor={`${id}-stage`}>작성 단계<select id={`${id}-stage`} value={stage} onChange={(event) => selectStage(event.target.value)}>{DRAFT_STAGES.map((value) => <option key={value} value={value}>{DRAFT_STAGE_LABELS[value]}</option>)}</select></label>
    </div><p className="draft-selection-note" role="status">검색 결과 {matchingCompetitions.length}개 · 검색만으로 현재 선택은 바뀌지 않습니다.{competition?.aliases.length ? ` 옛 이름: ${competition.aliases.join(' · ')}.` : ''}</p>{competition && <div className="draft-eligibility"><p>{competition.organizer} · {competition.schoolLevels.map((value) => SCHOOL_LEVEL_LABELS[value]).join(' / ')}</p><ul>{competition.eligibility.map((text) => <li key={text}>{text}</li>)}</ul></div>}</fieldset>}
    <aside className="draft-official-profile" aria-label="적용할 서식과 출처">
      <h3>{profile.label} · {profile.year}년</h3><div className="draft-support-status"><span>{sourceStatus(profile)}</span><span>{PROFILE_POLICY_LABELS[profile.policy]}</span><span>실제 한글 검수 미실행</span></div>
      <div className="draft-profile-values">{profile.formatSummary.map((value, index) => <span key={`${index}-${value}`}>{value}</span>)}</div>{profile.interpretationNotes.map((text, index) => <p key={`${index}-${text}`}>{text}</p>)}
      {profile.source && <><a href={profile.source.url} target="_blank" rel="noopener noreferrer">{profile.source.label} · {profile.source.location} 확인 <span aria-hidden="true">↗</span><span className="draft-visually-hidden"> (새 창)</span></a><p>자료 확인일 {profile.source.checkedOn} · 최종 제출 공문·서식은 별도로 확인해 주세요.</p></>}
      {!profile.source && <p>기관 서식 미지정 · 개인 참고 구성입니다. 공식 대회 기준으로 표시하지 않습니다.</p>}{profile.policy === 'reference' && <p className="draft-reference-note">확인되지 않은 서식 값은 앱의 참고 기본값입니다. 전국 공식 양식 생성이 완료된 상태를 뜻하지 않습니다.</p>}
      {formatOnly ? <p>기작성 문단의 텍스트와 순서를 유지해 서식만 적용합니다. 새 구성안·스크립트·지시문·제목을 만들거나 교사 보충 문단을 넣지 않습니다. EBS 요강의 생성형 AI 활용 제한도 원문에서 확인해 주세요.</p> : <p>본문 항목의 제목은 작성 보조 제안입니다. 요강에 명시되지 않은 목차를 공식 의무 규정으로 추가하지 않습니다.</p>}
      <p>기준·단계·학교급을 바꾸면 직접 작성한 내용의 포함 승인을 해제합니다. 입력은 남아 있으므로 새 기준에서 읽고 다시 포함 여부를 선택해 주세요.</p>
    </aside>
    {profileId === 'custom' && <CustomDraftSettingsEditor value={custom} disabled={locked} roles={DRAFT_ROLES} labels={baseProfile.labels} onChange={(value) => { onInvalidate(); setCustom(value); setSummaryConfirmed(false); }} />}
    <details className="draft-preparation" open><summary>준비물과 제출 전 확인</summary><p>직접 확인한 준비 상태를 이 화면에만 기록합니다. 체크는 실제 자료·쪽수·익명 처리를 앱이 검증했다는 뜻이 아니며 초안 내용도 바꾸지 않습니다.</p><div className="draft-checklist-grid"><div><h4>별도로 준비할 자료</h4>{profile.requirements.length === 0 && <p>제출 기관의 필수 자료를 직접 확인해 주세요.</p>}{profile.requirements.map((item) => { const key = `${profile.id}:${profile.year}:${stage}:requirement:${item.id}`; return <label key={key}><input type="checkbox" checked={preparationChecks[key] ?? false} onChange={(event) => togglePreparation(key, event.target.checked)} /><span>{item.label}</span></label>; })}</div><div><h4>직접 확인할 항목</h4>{profile.checks.map((text, index) => { const key = `${profile.id}:${profile.year}:${stage}:check:${index}`; return <label key={key}><input type="checkbox" checked={preparationChecks[key] ?? false} onChange={(event) => togglePreparation(key, event.target.checked)} /><span>{text}</span></label>; })}</div></div></details>
    {!canAuthor && <div className="draft-blocker" role="status"><h3>이 문서는 초안 생성 범위를 벗어납니다.</h3>{!stageAllowed && <p>{stage === 'national' ? '전국 진출 후에는 제출 원고의 변경 제한을 확인해야 합니다. 이 단계에서는 새 초안 생성을 제한하며 원본 사본과 준비 목록을 확인할 수 있습니다.' : '이 문서는 선택한 작성 단계에서 초안 생성을 지원하지 않습니다.'}</p>}{!schoolAllowed && <p>선택한 학교급은 이 대회의 등록된 참가 범위에 없습니다. 해당 학교급의 공식 안내를 먼저 확인해 주세요.</p>}{!effective.valid && schoolAllowed && stageAllowed && customValid && <p>이 문서·분과와 학교급의 조합은 지원하지 않습니다. 해당 분과의 참가 자격을 확인하거나 다른 기준을 선택해 주세요.</p>}{!customValid && <p>개인 참고 기준의 이름과 서식 값을 확인해 주세요.</p>}{profile.policy === 'guide-only' && <p>이 문서는 준비 안내만 제공합니다. 생성용 기준 확인을 마치지 않았습니다.</p>}<ul>{recommendation.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker}</li>)}</ul><p>원본 사본은 작업 화면의 ‘원본 그대로 내려받기’로 저장할 수 있습니다.</p></div>}
    {recommendation.warnings.length > 0 && <div className="draft-warning"><h3>자동 분류의 참고 사항</h3><ul>{recommendation.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div>}
    <form onSubmit={generate}>
      <fieldset className="draft-settings" disabled={locked || !canAuthor}><legend>초안 기본 정보</legend><div className="draft-metadata">
        <div className="draft-title-field"><label htmlFor={`${id}-title`}>{formatOnly ? '작업 제목' : '연구 제목'} <span aria-hidden="true">*</span></label><input id={`${id}-title`} required maxLength={DRAFT_LIMITS.maxTitleCharacters} value={title} placeholder={formatOnly ? '이 작업을 구분할 제목' : '확정한 연구 제목을 입력해 주세요'} onChange={(event) => { onInvalidate(); setTitle(event.target.value); }} /></div>
        {profile.coverFields.includes('subject') && <div><label htmlFor={`${id}-subject`}>교과·주제 (선택)</label><input id={`${id}-subject`} maxLength={100} value={subject} placeholder="확인한 출품교과 직접 입력" onChange={(event) => { onInvalidate(); setSubject(event.target.value); }} /></div>}
        {profile.coverFields.includes('researchType') && <div><label htmlFor={`${id}-research-type`}>연구 형태 (선택)</label><select id={`${id}-research-type`} value={researchType} onChange={(event) => { const value = event.target.value; if (value === '' || value === 'individual' || value === 'joint') { onInvalidate(); setResearchType(value); } }}><option value="">미기재</option><option value="individual">개인연구</option><option value="joint">공동연구</option></select></div>}
        {profile.coverFields.includes('grade') && <div><label htmlFor={`${id}-grade`}>대상 학년 (선택)</label>{schoolLevel === 'special' ? <input id={`${id}-grade`} value={grade} maxLength={50} placeholder="실제 대상 학년 직접 입력" onChange={(event) => { onInvalidate(); setGrade(event.target.value); }} /> : <select id={`${id}-grade`} value={grade} onChange={(event) => { onInvalidate(); setGrade(event.target.value); }}><option value="">미기재</option>{(schoolLevel === 'kindergarten' ? [3, 4, 5] : schoolLevel === 'elementary' ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]).map((value) => { const label = schoolLevel === 'kindergarten' ? `만 ${value}세` : `${SCHOOL_LEVEL_LABELS[schoolLevel]} ${value}학년`; return <option key={value} value={label}>{label}</option>; })}</select>}</div>}
        {profile.coverFields.includes('studentCount') && <div><label htmlFor={`${id}-student-count`}>대상 학생 수 (선택)</label><input id={`${id}-student-count`} inputMode="numeric" pattern="[1-9][0-9]{0,3}" maxLength={4} value={studentCount} placeholder="확인한 인원만 입력" onChange={(event) => { onInvalidate(); setStudentCount(event.target.value); }} /></div>}
      </div>{profile.coverFields.includes('schoolLevel') && <p className="draft-metadata-help">표지 학교급: {SCHOOL_LEVEL_LABELS[schoolLevel]} · 위 ‘학교급 선택’에서 바꿀 수 있습니다.</p>}<p className="draft-metadata-help">{formatOnly ? '작업 제목은 작업 구분용이며 기존 문서에 새 제목으로 넣지 않습니다.' : '연구 대상·기간·실천 내용·성과 수치는 실제 자료를 확인해 직접 작성해 주세요.'}</p>{profile.coverFields.length > 0 && <p className="draft-cover-note"><strong>{baseProfile.competitionId === 'innovation' ? '전국 표지 서식6과 대조해 주세요.' : '대회별 공식 표지와 대조해 주세요.'}</strong> {missingCoverFields.length > 0 ? `현재 미기재: ${missingCoverFields.join(' · ')}. ` : ''}초안 단계에서 비워 둔 표지 항목은 제출 전에 확인해야 합니다.{baseProfile.competitionId === 'innovation' && ' 관리번호는 공란으로 둡니다.'} 이름·소속 등 개인 식별정보는 여기서 수집하지 않으며, 기명·익명 제출본은 공식 안내에 따라 한글에서 준비해 주세요. 초안 표지의 외형이 공식 서식과 일치하는지는 미확인입니다.</p>}</fieldset>
      <div className="draft-review-heading"><h3>{isSummary ? '요약에 포함할 원문 선택' : formatOnly ? '원문 순서와 서식 확인' : '원문 문단의 배치 검토'}</h3>{!formatOnly && <button type="button" className="button secondary" disabled={locked || recommendation.paragraphs.length === 0} onClick={resetRecommendations}>{isSummary ? '요약 후보 다시 찾기' : '권장 분류로 되돌리기'}</button>}</div>
      <p className="draft-review-description">{isSummary ? '요약·초록 키워드가 있는 기존 문단을 후보로 표시합니다. 요약문을 새로 쓰거나 쪽수에 맞춰 내용을 줄이지 않습니다. 포함할 원문을 직접 선택하고 확인해 주세요.' : formatOnly ? '문단의 문장과 순서를 그대로 유지합니다. 아래 원문을 확인한 뒤 서식 초안을 만듭니다.' : '원문 키워드에 따른 분류 제안입니다. 아래 항목을 직접 바꾸면 같은 항목의 문단은 원래 순서대로 배치됩니다. 문장 자체는 바꾸지 않습니다.'}</p>
      <div className="draft-search-toolbar"><div className="draft-search"><label htmlFor={`${id}-search`}>원문 문단 검색</label><input id={`${id}-search`} type="search" maxLength={200} value={search} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} onChange={(event) => { setSearch(event.target.value); resetView(); }} /></div>{!formatOnly && <div className="draft-filter-control"><label htmlFor={`${id}-filter`}>배치 항목 필터</label><select ref={roleFilterRef} id={`${id}-filter`} value={roleFilter} onChange={(event) => { if (event.target.value === 'all' || isDraftRole(event.target.value) && roles.includes(event.target.value)) { setRoleFilter(event.target.value as DraftRole | 'all'); resetView(); } }}><option value="all">모든 항목</option>{roles.map((role) => <option key={role} value={role}>{labels[role]}</option>)}</select></div>}</div>
      <p className="draft-review-range" role="status" aria-live="polite">{filteredParagraphs.length === 0 ? '표시할 문단이 없습니다.' : `${currentPage * PARAGRAPH_PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PARAGRAPH_PAGE_SIZE, filteredParagraphs.length)} / ${filteredParagraphs.length}개 문단`} · 분류 대상 총 {recommendation.paragraphs.length}개</p>{roleChangeNotice && <p className="draft-role-notice" role="status" aria-live="polite">{roleChangeNotice}</p>}
      <div className="draft-paragraph-list">{visibleParagraphs.map((paragraph) => {
        const position = sourcePositions.get(paragraph.paragraphId); const number = position?.index ?? recommendation.paragraphs.indexOf(paragraph) + 1;
        const role = assignments[paragraph.paragraphId] ?? paragraph.role; const expanded = paragraph.paragraphId === expandedId;
        const partCount = Math.max(1, Math.ceil(paragraph.text.length / TEXT_WINDOW_SIZE)); const currentPart = Math.min(textPart, partCount - 1);
        const shownText = expanded ? textWindow(paragraph.text, currentPart, TEXT_WINDOW_SIZE) : textWindow(paragraph.text, 0, PREVIEW_LENGTH);
        return <article className={`draft-paragraph-card${isSummary && summaryIds.includes(paragraph.paragraphId) ? ' summary-selected' : ''}`} key={paragraph.paragraphId}><div className="draft-paragraph-top"><div className="draft-paragraph-position"><h4>문단 {number}</h4><p>{position?.section ? `원문 구역 ${position.section}` : '본문 문단'}</p></div>{isSummary ? <label className="draft-summary-choice"><input type="checkbox" disabled={locked || !canAuthor} checked={summaryIds.includes(paragraph.paragraphId)} onChange={(event) => toggleSummary(paragraph.paragraphId, event.target.checked)} />문단 {number}을 요약 후보로 선택</label> : !formatOnly && <div className="draft-role-control"><label htmlFor={`${id}-role-${number}`}>문단 {number}의 배치 항목</label><select id={`${id}-role-${number}`} value={role} disabled={locked || !canAuthor} onChange={(event) => changeRole(paragraph, event.target.value, number)}>{roles.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></div>}</div><p className={`draft-source-text${paragraph.text.length === 0 ? ' empty' : ''}`}>{paragraph.text.length === 0 ? '텍스트가 없는 문단입니다.' : shownText}</p><p className="draft-classification-evidence"><strong>{formatOnly ? '원문 순서 유지' : isSummary ? summaryIds.includes(paragraph.paragraphId) ? '선택한 요약 후보' : '원본에 보존' : `${role === paragraph.role ? '권장 분류' : '사용자 선택'} · ${labels[role]}`}</strong>{!isSummary && paragraph.evidence}</p>
          {paragraph.text.length > PREVIEW_LENGTH && <div className="draft-text-actions"><button type="button" aria-label={`문단 ${number} ${expanded ? '원문 접기' : '원문 펼치기'}`} aria-expanded={expanded} onClick={() => { setExpandedId(expanded ? null : paragraph.paragraphId); setTextPart(0); }}>{expanded ? '원문 접기' : '원문 펼치기'}</button>{expanded ? <><span role="status" aria-live="polite">문단 {number} 원문 · {currentPart + 1} / {partCount} 부분</span>{partCount > 1 && <div><button type="button" aria-label={`문단 ${number} 이전 부분`} disabled={currentPart === 0} onClick={() => setTextPart(currentPart - 1)}>이전 부분</button><button type="button" aria-label={`문단 ${number} 다음 부분`} disabled={currentPart + 1 >= partCount} onClick={() => setTextPart(currentPart + 1)}>다음 부분</button></div>}</> : <span>원문 일부를 표시합니다. 펼치면 나누어 읽을 수 있습니다.</span>}</div>}
        </article>;
      })}</div>
      {pageCount > 1 && <div className="draft-pages"><button type="button" className="button secondary" aria-label="초안 문단 이전 페이지" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setExpandedId(null); setTextPart(0); }}>이전</button><span>{currentPage + 1} / {pageCount} 페이지</span><button type="button" className="button secondary" aria-label="초안 문단 다음 페이지" disabled={currentPage + 1 >= pageCount} onClick={() => { setPage(currentPage + 1); setExpandedId(null); setTextPart(0); }}>다음</button></div>}
      {isSummary && canAuthor && <div className="draft-summary-review"><p role="status">선택한 {validSummaryIds.length}/전체 {recommendation.paragraphs.length} 문단만 요약 후보에 포함, 나머지 문단은 원본에 보존합니다.</p><p>선택한 문단은 원래 순서로 각각 한 번씩 배치합니다. 실제 요약서 쪽수와 대회 상한은 한글에서 확인해야 합니다.</p><label><input type="checkbox" disabled={locked || validSummaryIds.length === 0} checked={summaryConfirmed} onChange={(event) => { onInvalidate(); setSummaryConfirmed(event.target.checked); }} />선택한 원문만 요약 초안에 포함하는 것을 확인했습니다.</label>{validSummaryIds.length === 0 && <p>포함할 원문을 한 개 이상 선택해 주세요.</p>}</div>}
      {!formatOnly && canAuthor && roles.some((role) => profile.prompts[role]) && <details className="draft-supplement-section"><summary>질문을 보고 직접 내용 보완하기</summary><p>실제 자료를 확인한 내용만 직접 입력하세요. 자동 생성하지 않으며, 포함 여부를 선택한 항목만 새 초안에 추가합니다. 원문 문단은 그대로 유지합니다. 기준을 바꾸면 포함 승인을 해제하므로 새 기준에서 다시 확인해 주세요.</p><div className="draft-supplement-list">{roles.filter((role) => profile.prompts[role]).map((role) => <div className="draft-supplement-card" key={role}><h4>{labels[role]}</h4><p>{profile.prompts[role]}</p><label htmlFor={`${id}-supplement-${role}`}>직접 작성: {labels[role]}</label><textarea id={`${id}-supplement-${role}`} value={supplementTexts[role] ?? ''} maxLength={20_000} rows={5} disabled={locked} onChange={(event) => { onInvalidate(); setSupplementTexts((previous) => ({ ...previous, [role]: event.target.value })); setIncludedSupplements((previous) => ({ ...previous, [role]: false })); }} /><label className="draft-supplement-approval"><input type="checkbox" disabled={locked || !supplementTexts[role]?.trim()} checked={includedSupplements[role] ?? false} onChange={(event) => { onInvalidate(); setIncludedSupplements((previous) => ({ ...previous, [role]: event.target.checked })); }} />이 내용을 초안에 포함: {labels[role]}</label><p className="draft-supplement-size">{(supplementTexts[role] ?? '').length.toLocaleString('ko-KR')} / 20,000자 · 포함하기 전에 실제 자료와 문장을 확인해 주세요.</p></div>)}</div></details>}
      {!combinedTextWithinLimit && <p className="draft-error" role="status">원문과 추가 내용의 합계가 200만 문자 한도를 넘었습니다. 추가 내용을 줄여 주세요.</p>}
      {!isSummary && !formatOnly && canAuthor && missingRoles.length > 0 && <div className="draft-missing-sections"><h4>원문에 없는 항목은 직접 작성해야 합니다.</h4><p>배치된 원문·승인한 추가 내용 없음: {missingRoles.map((role) => labels[role]).join(' · ')}</p><p>빠진 연구 자료나 성과를 자동으로 채우지 않습니다. 실제 준비 여부는 위 확인 목록에 기록하고 필요한 내용은 직접 보완해 주세요.</p></div>}
      <div className="draft-action-area"><p>제목과 배치를 확인한 뒤 생성해 주세요. 실제 쪽수·식별정보·공식 표지와 최종 제출 형식은 한글에서 직접 확인해야 합니다.</p><div><button type="submit" className="button primary" disabled={locked || !canAuthor || !summaryReady || !combinedTextWithinLimit || title.trim().length === 0}>{generating ? '초안 생성 중…' : '검토한 내용으로 초안 생성'}</button>{generating && <button type="button" className="button secondary" onClick={onCancel}>초안 생성 취소</button>}</div></div>
    </form>
    {generating && <p className="draft-progress" role="status" aria-live="polite">새 HWPX 초안을 만들고 파일 구조와 원문 텍스트를 다시 확인하고 있습니다.</p>}{error && <p className="draft-error" role="alert">{error}</p>}
    {result && <div className="draft-result" aria-labelledby={`${id}-result-heading`}><div className="draft-result-heading"><div><h3 id={`${id}-result-heading`}>새 HWPX 초안을 만들었습니다.</h3><p>{result.profileLabel ?? profile.label} · {result.profileYear ?? profile.year}년{result.profileVersion ? ` · 기준 ${result.profileVersion}` : ''}</p><p>{resultIsSummary ? `전체 원문 ${result.sourceParagraphCount}개 중 ${result.includedParagraphCount ?? 0}개 문단을 요약 초안에 포함하고 ${result.excludedParagraphCount ?? 0}개는 원본에 보존합니다.` : `원문 ${result.sourceParagraphCount}개 문단을 배치했습니다.`} 교사가 직접 작성한 내용 {result.addedParagraphCount ?? 0}개를 추가했습니다. 제목·구성 항목을 포함한 초안은 {result.outputParagraphCount}개 문단입니다.</p></div><button type="button" className="button primary" disabled={locked} onClick={onDownload}>생성한 초안 내려받기</button></div><dl className="draft-verification"><div><dt>HWPX 파일 구조 재검사</dt><dd>{result.packageVerified ? '완료' : '미확인'}</dd></div><div><dt>{resultIsSummary ? '선택한 원문 텍스트 보존 확인' : '원문 텍스트 보존 확인'}</dt><dd>{result.originalTextVerified ? '완료' : '미확인'}</dd></div><div><dt>한글에서 쪽수·서식 검수</dt><dd className="unverified">미실행</dd></div><div><dt>내려받은 파일 저장 확인</dt><dd className="unverified">미확인</dd></div></dl><div className="draft-final-workflow"><h4>최종 제출은 한글에서 확인해 주세요.</h4><ol><li>내려받은 HWPX를 한글에서 열고 실제 글꼴·쪽수·표지와 식별정보를 확인합니다.</li><li>선택한 대회가 요구하는 HWP·PDF 등의 형식으로 저장합니다. 앱에서 파일 형식 변환을 완료한 상태는 아닙니다.</li><li>저장한 파일을 다시 열어 확인하고, 위 준비 목록의 영상·실물·소스·동의서 등 별도 자료를 함께 준비합니다.</li></ol></div><p className="draft-result-note">{profile.checks.join(' · ')}</p></div>}
  </section>;
}
