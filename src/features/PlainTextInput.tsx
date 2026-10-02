import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isPlainTextInput, PLAIN_TEXT_LIMITS } from '../domain/plain-text';
import './PlainTextInput.css';

export default function PlainTextInput({ ready, busy, onUse, onClose }: {
  ready: boolean; busy: boolean; onUse: (text: string) => void; onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.scrollIntoView({ block: 'center' }); }, []);
  const valid = isPlainTextInput(text);
  const lines = text.split('\n').length;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready && !busy && valid) onUse(text);
  }
  return <section className="plain-text-input panel" aria-labelledby={`${id}-heading`}>
    <div className="plain-text-heading"><h2 id={`${id}-heading`}>글 붙여넣기</h2><button type="button" className="button text-button" disabled={busy} onClick={onClose}>닫기</button></div>
    <p id={`${id}-description`}>한글에서 본문을 복사해 붙여넣으세요. 입력한 글만으로 새 원고를 만들며, 원본 파일의 표·사진·서식은 포함하지 않습니다.</p>
    <form onSubmit={submit}><label htmlFor={`${id}-text`}>보고서로 만들 글</label><textarea ref={input} id={`${id}-text`} aria-describedby={`${id}-description ${id}-limit`} required value={text} maxLength={PLAIN_TEXT_LIMITS.maxCharacters} rows={8} disabled={busy} placeholder="보고서로 정리할 본문을 여기에 붙여넣으세요." onChange={(event) => setText(event.target.value)} />
      <p id={`${id}-limit`} className="plain-text-count">{text.length.toLocaleString('ko-KR')}자 · {lines.toLocaleString('ko-KR')}줄 / 최대 {PLAIN_TEXT_LIMITS.maxLines.toLocaleString('ko-KR')}줄</p>
      {text.length > 0 && !valid && <p className="plain-text-error" role="status">내용을 입력하고 200만 자·1,999줄 이내로 줄여 주세요.</p>}
      <button type="submit" className="button primary" disabled={!ready || busy || !valid}>{busy ? '글을 준비하고 있어요…' : '이 글로 시작하기'}</button>
    </form>
  </section>;
}
