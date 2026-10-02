import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FONT_LANGUAGES } from '../domain/document';
import type {
  DocumentInspection, FontLanguage, FormatValue, InspectionCell, InspectionParagraph,
  InspectionReason, InspectionRun, InspectionTable,
} from '../domain/document';

const PAGE_SIZE = 40;
const RUN_PAGE_SIZE = 20;
const CELL_PAGE_SIZE = 20;
const TEXT_WINDOW_SIZE = 3000;

const REASON_LABELS: Record<InspectionReason, string> = {
  MISSING_FORMAT_REFERENCE: '서식 참조를 찾을 수 없습니다.',
  AMBIGUOUS_FORMAT_REFERENCE: '같은 서식 참조가 여러 개여서 값을 확정할 수 없습니다.',
  MISSING_FORMAT_VALUE: '선언되지 않은 서식 값이 있습니다.',
  INVALID_FORMAT_VALUE: '해석할 수 없는 서식 값이 있습니다.',
  UNSUPPORTED_FORMAT: '지원 범위 밖의 서식이 있습니다.',
  COMPATIBILITY_BRANCH: '호환성 분기가 있어 표시된 정보만 확인할 수 있습니다.',
  UNKNOWN_NAMESPACE: '지원하지 않는 이름공간이 있습니다.',
  UNKNOWN_ELEMENT: '지원하지 않는 문서 요소가 있습니다.',
  FIELD_CONTROL: '필드가 포함된 영역입니다.',
  HEADER_FOOTER: '머리말 또는 꼬리말 영역입니다.',
  NOTE_CONTEXT: '각주 또는 미주 영역입니다.',
  UNSUPPORTED_CONTROL: '지원하지 않는 문서 제어 요소가 있습니다.',
  NON_TEXT_OBJECT: '그림·도형 등 텍스트 이외의 개체가 있습니다. 개체는 표시하지 않습니다.',
  MERGED_TABLE: '병합 표입니다. 셀 위치와 읽은 텍스트만 표시합니다.',
  NESTED_TABLE: '중첩 표입니다. 원래 배치를 재현하지 않습니다.',
  INVALID_TABLE_STRUCTURE: '표의 행·열·셀 관계를 완전히 확인할 수 없습니다.',
  SUPERSCRIPT_OR_SUBSCRIPT: '위첨자 또는 아래첨자가 포함되어 있습니다.',
  UNSUPPORTED_CONTEXT: '지원 범위 밖의 문단 영역입니다.',
};

const LANGUAGE_LABELS: Record<FontLanguage, string> = {
  HANGUL: '한글', LATIN: '영문', HANJA: '한자', JAPANESE: '일본어',
  OTHER: '기타', SYMBOL: '기호', USER: '사용자',
};

const CONTEXT_LABELS: Record<InspectionParagraph['context'], string> = {
  BODY: '본문', TABLE_CELL: '표 안 문단', HEADER: '머리말', FOOTER: '꼬리말', NOTE: '주석', UNKNOWN: '영역 미확인',
};

const ALIGNMENT_LABELS: Record<string, string> = {
  LEFT: '왼쪽', CENTER: '가운데', RIGHT: '오른쪽', JUSTIFY: '양쪽',
  DISTRIBUTE: '배분', DISTRIBUTE_SPACE: '나눔',
};

function formatValue(value: FormatValue<number | string>): string {
  if (value.value === null) return '미확인';
  const text = typeof value.value === 'number'
    ? value.value.toLocaleString('ko-KR', { maximumFractionDigits: 3 }) : value.value;
  const end = text.charCodeAt(255) >= 0xd800 && text.charCodeAt(255) <= 0xdbff ? 255 : 256;
  const display = text.length > 256 ? `${text.slice(0, end)}… (일부 표시)` : text;
  return `${display}${value.unit && value.unit !== 'font-face' ? ` ${value.unit}` : ''}`;
}

function alignmentValue(value: FormatValue<string>): string {
  if (value.value === null) return '미확인';
  return ALIGNMENT_LABELS[value.value] ?? value.value;
}

function Reasons({ reasons }: { reasons: InspectionReason[] }) {
  const unique = Array.from(new Set(reasons));
  if (unique.length === 0) return null;
  return <ul className="inspector-reasons">{unique.map((reason) => <li key={reason}>{REASON_LABELS[reason] ?? '이 영역의 일부 정보를 확인할 수 없습니다.'}</li>)}</ul>;
}

function Pages({ page, count, total, size, label, onChange }: {
  page: number; count: number; total: number; size: number; label: string; onChange: (page: number) => void;
}) {
  if (count <= 1) return null;
  return <div className="inspector-pages">
    <button type="button" className="button secondary" aria-label={`${label} 이전 페이지`} disabled={page === 0} onClick={() => onChange(page - 1)}>이전</button>
    <span role="status" aria-live="polite">{page + 1} / {count} <small>· {page * size + 1}–{Math.min((page + 1) * size, total)} / {total}</small></span>
    <button type="button" className="button secondary" aria-label={`${label} 다음 페이지`} disabled={page + 1 >= count} onClick={() => onChange(page + 1)}>다음</button>
  </div>;
}

function TextWindow({ text, label, limit = TEXT_WINDOW_SIZE }: { text: string; label: string; limit?: number }) {
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(text.length / limit));
  const current = Math.min(page, count - 1);
  useEffect(() => { setPage(0); }, [text]);
  let start = current * limit;
  let end = Math.min(start + limit, text.length);
  // Keep a surrogate pair together across text windows without copying the
  // entire document into a second code-point array.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? '') && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
  return <div className="inspector-text-window">
    <p className={`inspector-document-text ${text.length === 0 ? 'empty-text' : ''}`}>{text.length === 0 ? '텍스트가 없는 문단입니다.' : text.slice(start, end)}</p>
    {count > 1 && <div className="inspector-text-controls"><span>긴 텍스트를 나누어 표시합니다. {current + 1} / {count}</span><div>
      <button type="button" aria-label={`${label} 이전 부분`} disabled={current === 0} onClick={() => setPage(current - 1)}>이전 부분</button>
      <button type="button" aria-label={`${label} 다음 부분`} disabled={current + 1 >= count} onClick={() => setPage(current + 1)}>다음 부분</button>
    </div></div>}
  </div>;
}

function mixedFields(runs: InspectionRun[]): string[] {
  const mixed: string[] = [];
  const hasDifferentValues = (values: Array<string | number | null>) => new Set(values.filter((value) => value !== null)).size > 1;
  if (FONT_LANGUAGES.some((language) => hasDifferentValues(runs.map((run) => run.characterFormat.fonts[language].value)))) mixed.push('글꼴');
  if (hasDifferentValues(runs.map((run) => run.characterFormat.fontSize.value))) mixed.push('글자 크기');
  if (FONT_LANGUAGES.some((language) => hasDifferentValues(runs.map((run) => run.characterFormat.ratio[language].value)))) mixed.push('장평');
  if (FONT_LANGUAGES.some((language) => hasDifferentValues(runs.map((run) => run.characterFormat.spacing[language].value)))) mixed.push('자간');
  if (new Set(runs.map((run) => `${run.characterFormat.superscript}/${run.characterFormat.subscript}`)).size > 1) mixed.push('위·아래첨자');
  return mixed;
}

function RunList({ runs }: { runs: InspectionRun[] }) {
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(runs.length / RUN_PAGE_SIZE));
  const current = Math.min(page, count - 1);
  return <div className="inspector-run-list">
    {runs.slice(current * RUN_PAGE_SIZE, (current + 1) * RUN_PAGE_SIZE).map((run, index) => <article className="inspector-run" key={run.nodeId}>
      <h5>문자 구간 {current * RUN_PAGE_SIZE + index + 1}</h5>
      <TextWindow text={run.text} label="문자 구간 텍스트" limit={500} />
      <dl className="inspector-format-grid"><div><dt>글자 크기</dt><dd>{formatValue(run.characterFormat.fontSize)}</dd></div><div><dt>문자 모양 참조</dt><dd>{run.characterFormat.reference.resolved ? '확인됨' : '미확인'}</dd></div><div><dt>위·아래첨자</dt><dd>{run.characterFormat.superscript ? '위첨자' : run.characterFormat.subscript ? '아래첨자' : '선언 없음'}</dd></div></dl>
      <div className="inspector-font-scroll" role="region" aria-label="언어별 문자 서식" tabIndex={0}><table className="inspector-format-table"><caption>언어별 글꼴·장평·자간</caption><thead><tr><th scope="col">언어</th><th scope="col">글꼴</th><th scope="col">장평</th><th scope="col">자간</th></tr></thead><tbody>{FONT_LANGUAGES.map((language) => <tr key={language}><th scope="row">{LANGUAGE_LABELS[language]}</th><td>{formatValue(run.characterFormat.fonts[language])}</td><td>{formatValue(run.characterFormat.ratio[language])}</td><td>{formatValue(run.characterFormat.spacing[language])}</td></tr>)}</tbody></table></div>
      <Reasons reasons={[...run.reasons, ...run.characterFormat.reasons, ...run.characterFormat.reference.reasons]} />
    </article>)}
    <Pages page={current} count={count} total={runs.length} size={RUN_PAGE_SIZE} label="문자 구간" onChange={setPage} />
  </div>;
}

function ParagraphCard({ paragraph, index, runMap }: {
  paragraph: InspectionParagraph; index: number; runMap: Map<string, InspectionRun>;
}) {
  const [open, setOpen] = useState(false);
  const runs = useMemo(() => paragraph.runIds.map((id) => runMap.get(id)).filter((run): run is InspectionRun => !!run), [paragraph, runMap]);
  const mixed = useMemo(() => mixedFields(runs), [runs]);
  const format = paragraph.paragraphFormat;
  return <article className="inspector-node inspector-paragraph" data-inspector-node={paragraph.nodeId} tabIndex={-1}>
    <header className="inspector-node-heading"><div><span className="inspector-node-kind">{CONTEXT_LABELS[paragraph.context]}</span><h3>문단 {index + 1}</h3></div><span className="badge">읽기 전용</span></header>
    <p className="inspector-path">{paragraph.structurePath}</p>
    <TextWindow text={paragraph.text} label="문단 텍스트" />
    <dl className="inspector-format-grid"><div><dt>정렬</dt><dd>{alignmentValue(format.alignment)}</dd></div><div><dt>문단 모양 참조</dt><dd>{format.reference.resolved ? '확인됨' : '미확인'}</dd></div><div><dt>문자 구간</dt><dd>{paragraph.runIds.length}개</dd></div></dl>
    {mixed.length > 0 && <p className="inspector-mixed">혼합 서식: {mixed.join(' · ')}. 문자 구간마다 값을 확인해 주세요.</p>}
    <Reasons reasons={[...paragraph.reasons, ...paragraph.styleReference.reasons, ...format.reasons, ...format.reference.reasons]} />
    {runs.length !== paragraph.runIds.length && <p className="inspector-mixed">일부 문자 구간 정보를 찾을 수 없습니다.</p>}
    <details className="inspector-format-details" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>문단·문자 구간 서식 보기</summary>{open && <div>
      <dl className="inspector-format-grid"><div><dt>줄 간격 방식</dt><dd>{formatValue(format.lineSpacingType)}</dd></div><div><dt>줄 간격</dt><dd>{formatValue(format.lineSpacing)}</dd></div><div><dt>왼쪽 여백</dt><dd>{formatValue(format.leftMargin)}</dd></div><div><dt>오른쪽 여백</dt><dd>{formatValue(format.rightMargin)}</dd></div><div><dt>들여쓰기</dt><dd>{formatValue(format.indent)}</dd></div><div><dt>문단 앞 간격</dt><dd>{formatValue(format.beforeSpacing)}</dd></div><div><dt>문단 뒤 간격</dt><dd>{formatValue(format.afterSpacing)}</dd></div><div><dt>스타일 참조</dt><dd>{paragraph.styleReference.resolved ? '확인됨' : '미확인'}</dd></div></dl>
      {runs.length > 0 ? <RunList runs={runs} /> : <p className="inspector-empty">읽은 문자 구간이 없습니다.</p>}
    </div>}</details>
  </article>;
}

function TableCard({ table, index, cells, onParagraph }: {
  table: InspectionTable; index: number; cells: InspectionCell[]; onParagraph: (nodeId: string) => void;
}) {
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(cells.length / CELL_PAGE_SIZE));
  const current = Math.min(page, count - 1);
  const merged = table.reasons.includes('MERGED_TABLE');
  const nested = table.reasons.includes('NESTED_TABLE') || table.parentTableId !== null;
  return <article className="inspector-node inspector-table" data-inspector-node={table.nodeId} tabIndex={-1}>
    <header className="inspector-node-heading"><div><span className="inspector-node-kind">{nested ? '중첩 표' : merged ? '병합 표' : table.reasons.length === 0 ? '단순 표' : '표 구조'}</span><h3>표 {index + 1}</h3></div><span className="badge">읽기 전용</span></header>
    <p className="inspector-path">{table.structurePath}</p>
    <dl className="inspector-format-grid"><div><dt>선언된 행</dt><dd>{table.rows ?? '미확인'}</dd></div><div><dt>선언된 열</dt><dd>{table.columns ?? '미확인'}</dd></div><div><dt>읽은 셀</dt><dd>{cells.length}개</dd></div></dl>
    <Reasons reasons={table.reasons} />
    <p className="inspector-table-note">셀 위치 목록입니다. 한글에서 보이는 표 너비·배치·쪽 넘김을 재현하지 않습니다.</p>
    {cells.length > 0 ? <div className="inspector-cell-scroll" role="region" aria-label={`표 ${index + 1} 셀 위치 목록`} tabIndex={0}><table className="inspector-cell-table"><caption>셀 {current * CELL_PAGE_SIZE + 1}–{Math.min((current + 1) * CELL_PAGE_SIZE, cells.length)} / {cells.length}</caption><thead><tr><th scope="col">행 · 열</th><th scope="col">차지하는 범위</th><th scope="col">읽은 텍스트와 문단</th></tr></thead><tbody>{cells.slice(current * CELL_PAGE_SIZE, (current + 1) * CELL_PAGE_SIZE).map((cell) => <tr key={cell.nodeId}><td>{cell.rowAddress === null ? '행 미확인' : `${cell.rowAddress + 1}행`}<br />{cell.columnAddress === null ? '열 미확인' : `${cell.columnAddress + 1}열`}</td><td>{cell.rowSpan ?? '?'}행 × {cell.columnSpan ?? '?'}열</td><td><p className="inspector-path">{cell.structurePath}</p><TextWindow text={cell.text} label="셀 텍스트" limit={500} /><Reasons reasons={cell.reasons} />{cell.paragraphIds.length > 0 && <button type="button" className="inspector-inline-button" onClick={() => onParagraph(cell.paragraphIds[0] ?? '')}>이 셀의 첫 문단으로 이동 <span aria-hidden="true">↗</span></button>}<span className="inspector-cell-paragraph-count">문단 {cell.paragraphIds.length}개</span></td></tr>)}</tbody></table></div> : <p className="inspector-empty">확인한 셀이 없습니다.</p>}
    <Pages page={current} count={count} total={cells.length} size={CELL_PAGE_SIZE} label={`표 ${index + 1} 셀`} onChange={setPage} />
  </article>;
}

export interface DocumentInspectorProps { inspection: DocumentInspection }

export default function DocumentInspector({ inspection }: DocumentInspectorProps) {
  const id = useId();
  const [sectionId, setSectionId] = useState(inspection.sections[0]?.nodeId ?? '');
  const [mode, setMode] = useState<'paragraphs' | 'tables'>('paragraphs');
  const [page, setPage] = useState(0);
  const [paragraphNumber, setParagraphNumber] = useState('');
  const [navigationNotice, setNavigationNotice] = useState('');
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const paragraphMap = useMemo(() => new Map(inspection.paragraphs.map((node) => [node.nodeId, node])), [inspection]);
  const tableMap = useMemo(() => new Map(inspection.tables.map((node) => [node.nodeId, node])), [inspection]);
  const runMap = useMemo(() => new Map(inspection.runs.map((node) => [node.nodeId, node])), [inspection]);
  const cellMap = useMemo(() => new Map(inspection.cells.map((node) => [node.nodeId, node])), [inspection]);
  const section = inspection.sections.find((node) => node.nodeId === sectionId) ?? inspection.sections[0];
  const paragraphs = useMemo(() => section?.paragraphIds.map((nodeId) => paragraphMap.get(nodeId)).filter((node): node is InspectionParagraph => !!node) ?? [], [section, paragraphMap]);
  const tables = useMemo(() => section?.tableIds.map((nodeId) => tableMap.get(nodeId)).filter((node): node is InspectionTable => !!node) ?? [], [section, tableMap]);
  const total = mode === 'paragraphs' ? paragraphs.length : tables.length;
  const count = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, count - 1);

  useEffect(() => {
    setSectionId(inspection.sections[0]?.nodeId ?? '');
    setMode('paragraphs'); setPage(0); setParagraphNumber(''); setNavigationNotice(''); setFocusTarget(null);
  }, [inspection]);

  useEffect(() => {
    if (!focusTarget) return;
    const node = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-inspector-node]') ?? [])
      .find((element) => element.dataset.inspectorNode === focusTarget);
    node?.focus();
    setFocusTarget(null);
  }, [focusTarget, current, mode, sectionId]);

  function goToParagraph(nodeId: string) {
    const paragraph = paragraphMap.get(nodeId);
    if (!paragraph) { setNavigationNotice('이 문단의 위치를 찾을 수 없습니다.'); return; }
    const targetSection = inspection.sections.find((candidate) => candidate.nodeId === paragraph.sectionId);
    const index = targetSection?.paragraphIds.indexOf(nodeId) ?? -1;
    if (!targetSection || index < 0) { setNavigationNotice('이 문단의 위치를 찾을 수 없습니다.'); return; }
    setSectionId(targetSection.nodeId); setMode('paragraphs'); setPage(Math.floor(index / PAGE_SIZE));
    setFocusTarget(nodeId); setParagraphNumber(String(index + 1)); setNavigationNotice(`문단 ${index + 1} 위치로 이동했습니다.`);
  }

  function onNumberSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const number = Number(paragraphNumber);
    if (!Number.isSafeInteger(number) || number < 1 || number > paragraphs.length) {
      setNavigationNotice(`현재 구역의 문단 번호 1–${paragraphs.length}를 입력해 주세요.`); return;
    }
    const paragraph = paragraphs[number - 1];
    if (paragraph) goToParagraph(paragraph.nodeId);
  }

  return <section className="document-inspector panel" aria-labelledby={`${id}-heading`}>
    <header className="inspector-heading"><div><p className="eyebrow">문서 읽기 · 구조와 서식</p><h2 id={`${id}-heading`}>문서 구조 보기</h2></div><span className="badge">전체 읽기 전용</span></header>
    <p className="inspector-scope">파일에서 읽은 문단·표·서식 정보입니다. 한글의 쪽 배치를 재현한 미리보기가 아니며, 서식 검사와 자동 교정은 제공하지 않습니다.</p>
    <dl className="inspector-summary"><div><dt>구역</dt><dd>{inspection.summary.sectionCount}개</dd></div><div><dt>문단</dt><dd>{inspection.summary.paragraphCount}개</dd></div><div><dt>문자 구간</dt><dd>{inspection.summary.runCount}개</dd></div><div><dt>표</dt><dd>{inspection.summary.tableCount}개</dd></div></dl>
    <div className="inspector-toolbar"><div className="inspector-section-picker"><label htmlFor={`${id}-section`}>구역 선택</label><select id={`${id}-section`} value={section?.nodeId ?? ''} onChange={(event) => { setSectionId(event.currentTarget.value); setPage(0); setParagraphNumber(''); setNavigationNotice(''); }}>{inspection.sections.map((item, index) => <option key={item.nodeId} value={item.nodeId}>{index + 1}구역 · 문단 {item.paragraphIds.length}개 · 표 {item.tableIds.length}개</option>)}</select></div><div className="inspector-mode" role="group" aria-label="구조 보기 종류"><button type="button" aria-pressed={mode === 'paragraphs'} onClick={() => { setMode('paragraphs'); setPage(0); }}>문단 보기</button><button type="button" aria-pressed={mode === 'tables'} onClick={() => { setMode('tables'); setPage(0); }}>표 보기</button></div></div>
    <Reasons reasons={section?.reasons ?? []} />
    <div className="inspector-navigation"><p className="inspector-range" role="status" aria-live="polite">{total === 0 ? `현재 구역에 읽은 ${mode === 'paragraphs' ? '문단' : '표'}가 없습니다.` : `${mode === 'paragraphs' ? '문단' : '표'} ${current * PAGE_SIZE + 1}–${Math.min((current + 1) * PAGE_SIZE, total)} / ${total}`}</p>{paragraphs.length > 0 && <form onSubmit={onNumberSubmit}><label htmlFor={`${id}-paragraph`}>문단 번호로 이동</label><input id={`${id}-paragraph`} type="number" min={1} max={paragraphs.length} step={1} value={paragraphNumber} onChange={(event) => setParagraphNumber(event.currentTarget.value)} /><button type="submit" className="button secondary">이동</button></form>}</div>
    {navigationNotice && <p className="inspector-navigation-notice" role="status">{navigationNotice}</p>}
    <div className="inspector-content" ref={contentRef}>
      {mode === 'paragraphs' ? paragraphs.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((paragraph, index) => <ParagraphCard key={paragraph.nodeId} paragraph={paragraph} index={current * PAGE_SIZE + index} runMap={runMap} />) : tables.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((table, index) => <TableCard key={table.nodeId} table={table} index={current * PAGE_SIZE + index} cells={table.cellIds.map((nodeId) => cellMap.get(nodeId)).filter((cell): cell is InspectionCell => !!cell)} onParagraph={goToParagraph} />)}
      {total === 0 && <p className="inspector-empty">이 화면에서 표시할 {mode === 'paragraphs' ? '문단' : '표'}가 없습니다. 다른 구역이나 보기 종류를 선택해 주세요.</p>}
    </div>
    <Pages page={current} count={count} total={total} size={PAGE_SIZE} label={mode === 'paragraphs' ? '문단' : '표'} onChange={setPage} />
    <p className="inspector-bottom-note">미확인 값은 문서의 기본값이나 오류 개수로 바꾸지 않습니다. 최종 문서의 모양은 한글에서 확인해 주세요.</p>
  </section>;
}
