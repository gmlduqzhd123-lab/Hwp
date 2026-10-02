import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DocumentInspection } from '../domain/document';
import { DRAFT_LIMITS, DRAFT_ROLES, isDraftRole } from '../domain/research';
import type { DraftParagraph, DraftRole, ResearchDraftKind, ResearchDraftOptions, ResearchDraftResult } from '../domain/research';
import { DRAFT_ROLE_LABELS, OFFICIAL_PROFILE, PAPER_PAGE, recommendDraft } from '../engine/draft/plan';
import './ResearchDraftPanel.css';

const PARAGRAPH_PAGE_SIZE = 40;
const PREVIEW_LENGTH = 500;
const TEXT_WINDOW_SIZE = 3000;

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

function textWindow(text: string, part: number, size: number): string {
  let start = part * size;
  let end = Math.min(start + size, text.length);
  // Keep a surrogate pair intact at either edge without copying the whole
  // document into a second array of code points.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? '') && /[\uD800-\uDBFF]/u.test(text[start - 1] ?? '')) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? '') && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end -= 1;
  return text.slice(start, end);
}

function millimeters(value: number): string {
  return (value * 25.4 / 7200).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

const PAPER_FORMAT_SUMMARY = [
  `A4 · ${PAPER_PAGE.fontFace} ${PAPER_PAGE.fontSizePt}pt · 줄간격 ${PAPER_PAGE.lineSpacingPercent}%`,
  `여백: 위 ${millimeters(PAPER_PAGE.margins.top)} / 아래 ${millimeters(PAPER_PAGE.margins.bottom)} / 좌 ${millimeters(PAPER_PAGE.margins.left)} / 우 ${millimeters(PAPER_PAGE.margins.right)}mm`,
  `머리말 ${millimeters(PAPER_PAGE.margins.header)} / 꼬리말 ${millimeters(PAPER_PAGE.margins.footer)} / 제본 ${millimeters(PAPER_PAGE.margins.gutter)}mm`,
  `문단: 들여쓰기 ${PAPER_PAGE.indent / 100} / 위 ${PAPER_PAGE.beforeSpacing / 100} / 아래 ${PAPER_PAGE.afterSpacing / 100}pt`,
  '초록 → 서론 → 방법·절차 → 결과 → 논의·결론',
];

export default function ResearchDraftPanel({
  inspection, disabled, onGenerate, onCancel, generating, result, error, onDownload, onInvalidate,
}: ResearchDraftPanelProps) {
  const id = useId();
  const [kind, setKind] = useState<ResearchDraftKind>('competition');
  const recommendation = useMemo(() => recommendDraft(inspection, kind), [inspection, kind]);
  const [assignments, setAssignments] = useState<Record<string, DraftRole>>(() => recommendedAssignments(recommendDraft(inspection, 'competition').paragraphs));
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [grade, setGrade] = useState('');
  const [studentCount, setStudentCount] = useState('');
  const [researchType, setResearchType] = useState<'individual' | 'joint' | ''>('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<DraftRole | 'all'>('all');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [textPart, setTextPart] = useState(0);
  const [roleChangeNotice, setRoleChangeNotice] = useState('');
  const roleFilterRef = useRef<HTMLSelectElement>(null);
  const locked = disabled || generating;
  const labels = DRAFT_ROLE_LABELS[kind];

  const sourcePositions = useMemo(() => {
    const sectionNumbers = new Map(inspection.sections.map((section, index) => [section.nodeId, index + 1]));
    return new Map(inspection.paragraphs.map((paragraph, index) => [paragraph.nodeId, {
      index: index + 1,
      section: sectionNumbers.get(paragraph.sectionId) ?? null,
    }]));
  }, [inspection]);
  const filteredParagraphs = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ko-KR');
    return recommendation.paragraphs.filter((paragraph) => {
      const role = assignments[paragraph.paragraphId] ?? paragraph.role;
      return (roleFilter === 'all' || role === roleFilter)
        && (query.length === 0 || paragraph.text.toLocaleLowerCase('ko-KR').includes(query));
    });
  }, [recommendation.paragraphs, assignments, roleFilter, search]);
  const pageCount = Math.max(1, Math.ceil(filteredParagraphs.length / PARAGRAPH_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleParagraphs = filteredParagraphs.slice(currentPage * PARAGRAPH_PAGE_SIZE, (currentPage + 1) * PARAGRAPH_PAGE_SIZE);
  const missingRoles = DRAFT_ROLES.filter((role) => !recommendation.paragraphs.some((paragraph) => paragraph.text.trim().length > 0 && (assignments[paragraph.paragraphId] ?? paragraph.role) === role));
  const missingCoverFields = [
    { label: '출품교과', value: subject },
    { label: '연구형태', value: researchType },
    { label: '학년', value: grade },
    { label: '학생 수', value: studentCount },
  ].filter((field) => field.value.trim().length === 0).map((field) => field.label);

  function resetView() {
    setPage(0);
    setExpandedId(null);
    setTextPart(0);
    setRoleChangeNotice('');
  }

  function changeKind(nextKind: ResearchDraftKind) {
    if (locked || nextKind === kind) return;
    onInvalidate();
    setKind(nextKind);
    setAssignments(recommendedAssignments(recommendDraft(inspection, nextKind).paragraphs));
    setRoleFilter('all');
    resetView();
  }

  function changeRole(paragraph: DraftParagraph, role: string, number: number) {
    if (locked || !isDraftRole(role) || role === (assignments[paragraph.paragraphId] ?? paragraph.role)) return;
    onInvalidate();
    setAssignments((previous) => ({ ...previous, [paragraph.paragraphId]: role }));
    if (roleFilter !== 'all' && role !== roleFilter) {
      // The edited card will leave the filtered list. Move focus to a stable
      // control before React removes its select.
      roleFilterRef.current?.focus();
      setExpandedId(null);
      setTextPart(0);
      setRoleChangeNotice(`문단 ${number}을 ${labels[role]} 항목에 배치했습니다. 현재 필터에서는 제외됩니다.`);
    } else {
      setRoleChangeNotice(`문단 ${number}을 ${labels[role]} 항목에 배치했습니다.`);
    }
  }

  function resetRecommendations() {
    if (locked) return;
    if (recommendation.paragraphs.some((paragraph) => (assignments[paragraph.paragraphId] ?? paragraph.role) !== paragraph.role)) onInvalidate();
    setAssignments(recommendedAssignments(recommendation.paragraphs));
    setRoleFilter('all');
    resetView();
  }

  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !recommendation.eligible || title.trim().length === 0) return;
    onGenerate({
      kind, title, subject, grade, studentCount,
      ...(researchType ? { researchType } : {}),
      assignments: recommendation.paragraphs.map((paragraph) => ({
        paragraphId: paragraph.paragraphId,
        sourceText: paragraph.text,
        role: assignments[paragraph.paragraphId] ?? paragraph.role,
      })),
    });
  }

  return <section className="panel research-draft-panel" aria-labelledby={`${id}-heading`}>
    <div className="draft-panel-heading">
      <div><p className="eyebrow">원문으로 만드는 새 문서</p><h2 id={`${id}-heading`}>보고서·논문 초안 만들기</h2></div>
      <span className="badge">별도 HWPX 생성</span>
    </div>
    <p className="draft-introduction">원문 문단을 검토한 뒤 항목별로 배치하고, 새 HWPX 초안의 서식을 맞춥니다. 업로드한 원본은 그대로 보관됩니다. 연구 결과나 원문에 없는 내용을 새로 쓰지는 않습니다.</p>

    <div className="draft-kind-selector" role="group" aria-label="초안 종류">
      <button type="button" aria-pressed={kind === 'competition'} disabled={locked} onClick={() => changeKind('competition')}>수업혁신사례연구대회 보고서</button>
      <button type="button" aria-pressed={kind === 'paper'} disabled={locked} onClick={() => changeKind('paper')}>논문 참고 구성</button>
    </div>

    <aside className="draft-official-profile" aria-label="적용할 서식과 출처">
      <h3>{kind === 'competition' ? OFFICIAL_PROFILE.title : '기관 서식 미지정 · 참고용 논문 구성'}</h3>
      <p>{kind === 'competition'
        ? OFFICIAL_PROFILE.scope
        : '논문은 요약·서론·방법·결과·논의 등의 참고 구성으로 정리합니다. 제출할 기관의 양식과 인용 기준을 별도로 확인해야 합니다.'}</p>
      <div className="draft-profile-values">{(kind === 'competition' ? OFFICIAL_PROFILE.formatSummary : PAPER_FORMAT_SUMMARY).map((value) => <span key={value}>{value}</span>)}</div>
      {kind === 'competition' ? <>
        <p>A4는 앱 초안의 기본값이며 전국 운영계획에 명시된 용지 규격으로 확인되지 않았습니다. 원문에 단위가 적히지 않은 여백은 mm, 문단 들여쓰기·간격은 pt로 해석해 적용합니다. 제출 기관의 안내로 다시 확인해 주세요. 휴먼명조의 실제 설치 여부와 대체 글꼴은 한글에서 확인해야 합니다.</p>
        <a href={OFFICIAL_PROFILE.sourceUrl} target="_blank" rel="noopener noreferrer">{OFFICIAL_PROFILE.sourceLabel} · {OFFICIAL_PROFILE.sourcePage} 확인 <span aria-hidden="true">↗</span><span className="draft-visually-hidden"> (새 창)</span></a>
      </> : <p>위 값은 참고용 초안의 서식입니다. 기관에서 정한 양식이 아니며, 글꼴 설치·대체 여부도 한글에서 확인해야 합니다.</p>}
      <p>본문 항목의 제목은 내용을 정리하기 위한 작성 보조입니다. 공식적으로 강제된 본문 목차를 뜻하지 않습니다.</p>
    </aside>

    {!recommendation.eligible && <div className="draft-blocker" role="status">
      <h3>이 문서는 초안 생성 범위를 벗어납니다.</h3>
      <ul>{recommendation.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker}</li>)}</ul>
      <p>초안 생성은 지원하는 본문 텍스트만 있는 문서를 대상으로 합니다. 원본 사본은 작업 화면에서 내려받을 수 있습니다.</p>
    </div>}
    {recommendation.warnings.length > 0 && <div className="draft-warning">
      <h3>자동 분류의 참고 사항</h3>
      <ul>{recommendation.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
    </div>}

    <form onSubmit={generate}>
      <fieldset className="draft-settings" disabled={locked || !recommendation.eligible}>
        <legend>초안 기본 정보</legend>
        <div className="draft-metadata">
          <div className="draft-title-field"><label htmlFor={`${id}-title`}>연구 제목 <span aria-hidden="true">*</span></label><input id={`${id}-title`} required maxLength={DRAFT_LIMITS.maxTitleCharacters} value={title} placeholder="확정한 연구 제목을 입력해 주세요" onChange={(event) => { onInvalidate(); setTitle(event.target.value); }} /></div>
          {kind === 'competition' && <>
            <div><label htmlFor={`${id}-subject`}>교과·주제 (선택)</label><input id={`${id}-subject`} maxLength={100} value={subject} placeholder="출품교과 직접 입력" onChange={(event) => { onInvalidate(); setSubject(event.target.value); }} /></div>
            <div><label htmlFor={`${id}-research-type`}>연구 형태 (선택)</label><select id={`${id}-research-type`} value={researchType} onChange={(event) => { const value = event.target.value; if (value === '' || value === 'individual' || value === 'joint') { onInvalidate(); setResearchType(value); } }}><option value="">미기재</option><option value="individual">개인연구</option><option value="joint">공동연구</option></select></div>
            <div><label htmlFor={`${id}-grade`}>대상 학년 (선택)</label><select id={`${id}-grade`} value={grade} onChange={(event) => { onInvalidate(); setGrade(event.target.value); }}><option value="">미기재</option>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={`초등학교 ${value}학년`}>초등학교 {value}학년</option>)}</select></div>
            <div><label htmlFor={`${id}-student-count`}>대상 학생 수 (선택)</label><input id={`${id}-student-count`} inputMode="numeric" pattern="[1-9][0-9]{0,3}" maxLength={4} value={studentCount} placeholder="확인한 인원만 입력" aria-describedby={`${id}-metadata-help`} onChange={(event) => { onInvalidate(); setStudentCount(event.target.value); }} /></div>
          </>}
        </div>
        <p className="draft-metadata-help" id={`${id}-metadata-help`}>연구 대상·기간·실천 내용·성과 수치는 원문과 실제 자료로 확인한 뒤 직접 작성해 주세요.</p>
        {kind === 'competition' && <p className="draft-cover-note"><strong>전국 표지 서식6과 대조해 주세요.</strong> 출품교과·연구형태·학년·학생 수는 공식 표지 항목입니다. 초안 생성 단계에서는 비워 둘 수 있지만 제출 전에 확인해야 합니다.{missingCoverFields.length > 0 && ` 현재 미기재: ${missingCoverFields.join(' · ')}.`} 학교급은 초등학교로 표기하고 관리번호는 공란으로 둡니다. 초안 표지의 외형이 공식 서식과 일치하는지는 미확인입니다.</p>}
      </fieldset>

      <div className="draft-review-heading"><h3>원문 문단의 배치 검토</h3><button type="button" className="button secondary" disabled={locked || recommendation.paragraphs.length === 0} onClick={resetRecommendations}>권장 분류로 되돌리기</button></div>
      <p className="draft-review-description">원문 키워드에 따른 분류 제안입니다. 아래 항목을 직접 바꾸면 같은 항목의 문단은 원래 순서대로 배치됩니다. 문장 자체는 바꾸지 않습니다.</p>
      <div className="draft-search-toolbar">
        <div className="draft-search"><label htmlFor={`${id}-search`}>원문 문단 검색</label><input id={`${id}-search`} type="search" maxLength={200} value={search} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} onChange={(event) => { setSearch(event.target.value); resetView(); }} /></div>
        <div className="draft-filter-control"><label htmlFor={`${id}-filter`}>배치 항목 필터</label><select ref={roleFilterRef} id={`${id}-filter`} value={roleFilter} onChange={(event) => { if (event.target.value === 'all' || isDraftRole(event.target.value)) { setRoleFilter(event.target.value); resetView(); } }}><option value="all">모든 항목</option>{DRAFT_ROLES.map((role) => <option key={role} value={role}>{labels[role]}</option>)}</select></div>
      </div>
      <p className="draft-review-range" role="status" aria-live="polite">{filteredParagraphs.length === 0 ? '표시할 문단이 없습니다.' : `${currentPage * PARAGRAPH_PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PARAGRAPH_PAGE_SIZE, filteredParagraphs.length)} / ${filteredParagraphs.length}개 문단`} · 분류 대상 총 {recommendation.paragraphs.length}개</p>
      {roleChangeNotice && <p className="draft-role-notice" role="status" aria-live="polite">{roleChangeNotice}</p>}

      <div className="draft-paragraph-list">
        {visibleParagraphs.map((paragraph) => {
          const position = sourcePositions.get(paragraph.paragraphId);
          const number = position?.index ?? recommendation.paragraphs.indexOf(paragraph) + 1;
          const role = assignments[paragraph.paragraphId] ?? paragraph.role;
          const expanded = paragraph.paragraphId === expandedId;
          const partCount = Math.max(1, Math.ceil(paragraph.text.length / TEXT_WINDOW_SIZE));
          const currentPart = Math.min(textPart, partCount - 1);
          const shownText = expanded ? textWindow(paragraph.text, currentPart, TEXT_WINDOW_SIZE) : textWindow(paragraph.text, 0, PREVIEW_LENGTH);
          return <article className="draft-paragraph-card" key={paragraph.paragraphId}>
            <div className="draft-paragraph-top">
              <div className="draft-paragraph-position"><h4>문단 {number}</h4><p>{position?.section ? `원문 구역 ${position.section}` : '본문 문단'}</p></div>
              <div className="draft-role-control"><label htmlFor={`${id}-role-${number}`}>문단 {number}의 배치 항목</label><select id={`${id}-role-${number}`} value={role} disabled={locked} onChange={(event) => changeRole(paragraph, event.target.value, number)}>{DRAFT_ROLES.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></div>
            </div>
            <p className={`draft-source-text${paragraph.text.length === 0 ? ' empty' : ''}`}>{paragraph.text.length === 0 ? '텍스트가 없는 문단입니다.' : shownText}</p>
            <p className="draft-classification-evidence"><strong>{role === paragraph.role ? '권장 분류' : '사용자 선택'} · {labels[role]}</strong>권장: {labels[paragraph.role]} · {paragraph.evidence}</p>
            {paragraph.text.length > PREVIEW_LENGTH && <div className="draft-text-actions">
              <button type="button" aria-label={`문단 ${number} ${expanded ? '원문 접기' : '원문 펼치기'}`} aria-expanded={expanded} onClick={() => { setExpandedId(expanded ? null : paragraph.paragraphId); setTextPart(0); }}>{expanded ? '원문 접기' : '원문 펼치기'}</button>
              {expanded ? <><span role="status" aria-live="polite">문단 {number} 원문 · {currentPart + 1} / {partCount} 부분</span>{partCount > 1 && <div><button type="button" aria-label={`문단 ${number} 이전 부분`} disabled={currentPart === 0} onClick={() => setTextPart(currentPart - 1)}>이전 부분</button><button type="button" aria-label={`문단 ${number} 다음 부분`} disabled={currentPart + 1 >= partCount} onClick={() => setTextPart(currentPart + 1)}>다음 부분</button></div>}</>
                : <span>원문 일부를 표시합니다. 펼치면 나누어 읽을 수 있습니다.</span>}
            </div>}
          </article>;
        })}
      </div>
      {pageCount > 1 && <div className="draft-pages"><button type="button" className="button secondary" aria-label="초안 문단 이전 페이지" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setExpandedId(null); setTextPart(0); }}>이전</button><span>{currentPage + 1} / {pageCount} 페이지</span><button type="button" className="button secondary" aria-label="초안 문단 다음 페이지" disabled={currentPage + 1 >= pageCount} onClick={() => { setPage(currentPage + 1); setExpandedId(null); setTextPart(0); }}>다음</button></div>}

      {recommendation.eligible && missingRoles.length > 0 && <div className="draft-missing-sections"><h4>원문에 없는 항목은 직접 작성해야 합니다.</h4><p>배치된 원문 없음: {missingRoles.map((role) => labels[role]).join(' · ')}</p><p>빠진 연구 자료나 성과를 자동으로 채우지 않습니다. 초안 생성 뒤 실제 자료를 확인해 보완해 주세요.</p></div>}
      <div className="draft-action-area"><p>연구 제목을 입력하고 분류와 기본 정보를 확인한 뒤 생성해 주세요. 생성한 초안은 한글에서 쪽수·익명 처리·표지를 직접 확인해야 합니다.</p><div><button type="submit" className="button primary" disabled={locked || !recommendation.eligible || title.trim().length === 0}>{generating ? '초안 생성 중…' : '검토한 내용으로 초안 생성'}</button>{generating && <button type="button" className="button secondary" onClick={onCancel}>초안 생성 취소</button>}</div></div>
    </form>

    {generating && <p className="draft-progress" role="status" aria-live="polite">새 HWPX 초안을 만들고 파일 구조와 원문 텍스트를 다시 확인하고 있습니다.</p>}
    {error && <p className="draft-error" role="alert">{error}</p>}
    {result && <div className="draft-result" aria-labelledby={`${id}-result-heading`}>
      <div className="draft-result-heading"><div><h3 id={`${id}-result-heading`}>새 HWPX 초안을 만들었습니다.</h3><p>원문 {result.sourceParagraphCount}개 문단을 배치했습니다. 제목·구성 항목을 포함한 초안은 {result.outputParagraphCount}개 문단입니다.</p></div><button type="button" className="button primary" disabled={locked} onClick={onDownload}>생성한 초안 내려받기</button></div>
      <dl className="draft-verification"><div><dt>HWPX 파일 구조 재검사</dt><dd>{result.packageVerified ? '완료' : '미확인'}</dd></div><div><dt>원문 텍스트 보존 확인</dt><dd>{result.originalTextVerified ? '완료' : '미확인'}</dd></div><div><dt>한글에서 쪽수·서식 검수</dt><dd className="unverified">미실행</dd></div><div><dt>내려받은 파일 저장 확인</dt><dd className="unverified">미확인</dd></div></dl>
      <p className="draft-result-note">{result.kind === 'competition' ? OFFICIAL_PROFILE.checks.join(' · ') : '제출 기관의 서식·인용 기준, 쪽수·익명 처리·표지를 직접 확인해 주세요. 이 초안은 기관 서식이 지정되지 않은 참고 구성입니다.'}</p>
    </div>}
  </section>;
}
