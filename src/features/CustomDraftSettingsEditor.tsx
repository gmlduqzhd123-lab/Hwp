import type { CustomDraftSettings, DraftRole } from '../domain/research';
import { isCustomDraftSettings } from '../domain/research';
import './CustomDraftSettingsEditor.css';

const MARGIN_LABELS: Record<keyof CustomDraftSettings['marginMm'], string> = {
  top: '위', bottom: '아래', left: '왼쪽', right: '오른쪽', header: '머리말', footer: '꼬리말', gutter: '제본',
};

export default function CustomDraftSettingsEditor({ value, onChange, disabled, roles, labels }: {
  value: CustomDraftSettings;
  onChange: (value: CustomDraftSettings) => void;
  disabled: boolean;
  roles: readonly DraftRole[];
  labels: Readonly<Record<DraftRole, string>>;
}) {
  function numeric(text: string): number { return text === '' ? Number.NaN : Number(text); }
  function shown(number: number): number | '' { return Number.isFinite(number) ? number : ''; }
  return <fieldset className="draft-custom-settings" disabled={disabled}>
    <legend>개인 참고 기준 설정</legend>
    <p>직접 입력하는 참고 서식입니다. 공식 대회 기준으로 인증하지 않습니다. 용지는 A4이며, 실제 글꼴과 쪽수는 한글에서 확인해 주세요.</p>
    <div className="draft-custom-grid">
      <label>참고 기준 이름<input maxLength={100} value={value.name} required onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
      <label>참고 글꼴<input maxLength={128} value={value.fontFace} required onChange={(event) => onChange({ ...value, fontFace: event.target.value })} /></label>
      <label>참고 글자 크기 (pt)<input type="number" min={6} max={72} step="0.01" required value={shown(value.fontSizePt)} onChange={(event) => onChange({ ...value, fontSizePt: numeric(event.target.value) })} /></label>
      <label>참고 줄간격 (%)<input type="number" min={80} max={300} step={1} required value={shown(value.lineSpacingPercent)} onChange={(event) => onChange({ ...value, lineSpacingPercent: numeric(event.target.value) })} /></label>
    </div>
    <h4>여백</h4><div className="draft-custom-grid margins">{(Object.keys(MARGIN_LABELS) as Array<keyof CustomDraftSettings['marginMm']>).map((key) => <label key={key}>참고 {MARGIN_LABELS[key]} 여백 (mm)<input type="number" min={0} max={80} step="0.1" required value={shown(value.marginMm[key])} onChange={(event) => onChange({ ...value, marginMm: { ...value.marginMm, [key]: numeric(event.target.value) } })} /></label>)}</div>
    <h4>구성 항목의 제목</h4><p>비워 두면 기본 항목명을 사용합니다. 항목을 추가하거나 원문을 자동으로 새로 쓰지는 않습니다.</p>
    <div className="draft-custom-grid">{roles.map((role) => <label key={role}>참고 {labels[role]} 항목 제목<input maxLength={100} value={value.labels?.[role] ?? ''} placeholder={labels[role]} onChange={(event) => { const next = { ...value.labels }; if (event.target.value.trim()) next[role] = event.target.value; else delete next[role]; onChange({ ...value, labels: next }); }} /></label>)}</div>
    {!isCustomDraftSettings(value) && <p className="draft-custom-invalid" role="status">참고 기준의 이름·글꼴과 수치를 확인해 주세요. 글자 크기는 6–72pt, 줄간격은 정수 80–300%, 여백은 0–80mm이며 용지 안에 본문 공간이 남아야 합니다.</p>}
  </fieldset>;
}
