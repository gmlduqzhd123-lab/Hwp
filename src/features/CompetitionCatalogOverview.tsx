import { useId, useMemo, useState } from 'react';
import { COMPETITIONS, DRAFT_PROFILES, SCHOOL_LEVEL_LABELS } from '../domain/competitions';
import { DRAFT_SCHOOL_LEVELS } from '../domain/research';
import type { DraftSchoolLevel } from '../domain/research';
import type { DraftProfile } from '../domain/competition-types';
import './CompetitionCatalogOverview.css';

export const PROFILE_POLICY_LABELS: Record<DraftProfile['policy'], string> = {
  draft: '줄글 초안 생성', 'format-only': '기작성 문서의 서식만', reference: '참고 기준 초안', 'guide-only': '준비 안내만',
};

export function sourceStatus(profile: DraftProfile): string {
  if (!profile.source) return '개인 참고 · 공식 기준 아님';
  if (profile.source.scope === 'previous-year') return `${profile.year} 자료 확인 · 최신 운영 확인 필요`;
  if (profile.source.scope === 'national-notice') return '전국 단계 안내 확인 · 전국 단독 서식 미확인';
  return '전국 공식 자료 확인';
}

export function CompetitionCatalogOverview() {
  const id = useId();
  const [search, setSearch] = useState('');
  const [school, setSchool] = useState<DraftSchoolLevel | 'all'>('elementary');
  const [year, setYear] = useState('all');
  const years = [...new Set(DRAFT_PROFILES.filter((profile) => profile.source).map((profile) => profile.year))].sort((left, right) => right - left);
  const matching = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ko-KR');
    return COMPETITIONS.filter((competition) => {
      const profiles = DRAFT_PROFILES.filter((profile) => profile.competitionId === competition.id && profile.source);
      return profiles.length > 0 && (school === 'all' || competition.schoolLevels.includes(school))
        && (year === 'all' || profiles.some((profile) => String(profile.year) === year))
        && (query.length === 0 || [competition.label, ...competition.aliases].some((label) => label.toLocaleLowerCase('ko-KR').includes(query)));
    });
  }, [search, school, year]);
  return <section className="panel competition-catalog-overview" aria-labelledby={`${id}-heading`}>
    <p className="eyebrow">공식 자료를 확인한 대회</p><h2 id={`${id}-heading`}>대회별 작성 기준 찾아보기</h2>
    <p className="catalog-introduction">파일을 올리기 전에 대회 성격과 준비물을 비교할 수 있습니다. 옛 대회명으로도 검색할 수 있으며, 참가 자격·예선·추천 조건은 각 공식 안내로 확인해 주세요. 이 목록은 모든 전국 연구대회를 확정한 목록은 아닙니다.</p>
    <div className="catalog-search-toolbar">
      <label htmlFor={`${id}-school`}>대회 목록 학교급<select id={`${id}-school`} value={school} onChange={(event) => { const value = event.target.value; if (value === 'all' || (DRAFT_SCHOOL_LEVELS as readonly string[]).includes(value)) setSchool(value as DraftSchoolLevel | 'all'); }}><option value="all">모든 학교급</option>{DRAFT_SCHOOL_LEVELS.map((value) => <option key={value} value={value}>{SCHOOL_LEVEL_LABELS[value]}</option>)}</select></label>
      <label htmlFor={`${id}-search`} className="catalog-search-field">대회 목록 검색<input id={`${id}-search`} type="search" maxLength={120} placeholder="정식 명칭이나 옛 이름" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label htmlFor={`${id}-year`}>자료 기준 연도<select id={`${id}-year`} value={year} onChange={(event) => setYear(event.target.value)}><option value="all">확인한 모든 연도</option>{years.map((value) => <option key={value} value={value}>{value}년</option>)}</select></label>
    </div>
    <p className="catalog-range" role="status">{matching.length}개 대회 · 등록, 공식 자료 확인, 초안 생성 지원, 실제 한글 검수는 각각 구분합니다.</p>
    <div className="catalog-competition-list">{matching.map((competition) => {
      const profiles = DRAFT_PROFILES.filter((profile) => profile.competitionId === competition.id && profile.source && (year === 'all' || String(profile.year) === year));
      const sources = [...new Map(profiles.map((profile) => [profile.source?.url, profile])).values()];
      const requirements = [...new Map(profiles.flatMap((profile) => profile.requirements).map((item) => [item.id, item.label])).values()];
      return <article className="catalog-competition-card" key={competition.id}>
        <div className="catalog-card-heading"><h3>{competition.label}</h3><span>실제 한글 검수 미실행</span></div>
        <p className="catalog-organizer">{competition.organizer} · {competition.schoolLevels.map((level) => SCHOOL_LEVEL_LABELS[level]).join(' / ')}</p>
        {competition.aliases.length > 0 && <p className="catalog-aliases">검색 가능한 옛 이름: {competition.aliases.join(' · ')}</p>}
        <ul className="catalog-eligibility">{competition.eligibility.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="catalog-sources">{sources.map((profile) => <div key={`${profile.id}-source`}><strong>{profile.year}년 · {sourceStatus(profile)}</strong>{profile.source && <><a href={profile.source.url} target="_blank" rel="noopener noreferrer">{profile.source.label} (새 창)</a><p>{profile.source.location} · 확인일 {profile.source.checkedOn}</p></>}</div>)}</div>
        <details className="catalog-profile-details"><summary>문서별 지원 범위와 준비물 보기</summary><div className="catalog-profile-scroll" role="region" aria-label={`${competition.label} 문서별 지원`} tabIndex={0}><table><caption>등록된 작성 기준</caption><thead><tr><th scope="col">문서·분과</th><th scope="col">지원</th><th scope="col">서식·제출 전 확인</th></tr></thead><tbody>{profiles.map((profile) => <tr key={profile.id}><th scope="row">{profile.label}<small>{profile.year}년</small></th><td>{PROFILE_POLICY_LABELS[profile.policy]}<small>{profile.allowedStages.includes('national') ? '전국 단계 기준 확인 필요' : '전국 진출 후 생성 제한'}</small></td><td><ul>{profile.formatSummary.map((text) => <li key={text}>{text}</li>)}{profile.checks.map((text) => <li key={text}>{text}</li>)}</ul></td></tr>)}</tbody></table></div>
          <h4>별도로 준비할 자료</h4><ul className="catalog-preparation">{requirements.map((text) => <li key={text}>{text}</li>)}</ul>
        </details>
      </article>;
    })}</div>
    {matching.length === 0 && <p className="catalog-empty">이 조건에 맞는 대회를 찾지 못했습니다. 학교급·연도를 바꾸거나 정식 이름으로 검색해 주세요.</p>}
    <p className="catalog-final-note">앱에서 만든 HWPX는 작성용 초안입니다. 공식 표지, 실제 쪽수와 익명 처리, HWP·PDF 변환, 영상·실물·동의서 등 최종 제출물은 한글과 각 대회 안내에서 따로 확인해야 합니다. 실제 연구 내용과 학생 자료를 저장하거나 보내지 않습니다.</p>
  </section>;
}

export default CompetitionCatalogOverview;
