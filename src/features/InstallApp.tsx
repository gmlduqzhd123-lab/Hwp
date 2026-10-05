import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { installGuide, kakaoOpenExternalUrl, type InstallGuide } from '../domain/app-install';
import { installSnapshot, promptInstall, subscribeInstall } from './install-state';
import './InstallApp.css';

/** 📲 앱 설치: 크롬·엣지·삼성 인터넷은 설치 창을 바로 띄우고, 그 밖의 브라우저는 설치 방법을 안내한다. */
export default function InstallApp() {
  const id = useId();
  const state = useSyncExternalStore(subscribeInstall, installSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [guide, setGuide] = useState<InstallGuide | null>(null);
  if (state.installed) return null;

  async function install() {
    if (await promptInstall()) return;
    setGuide(installGuide({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }));
    dialog.current?.showModal();
  }

  return <>
    <button type="button" className="button install-button" onClick={() => { void install(); }}><span aria-hidden="true">📲</span> 앱 설치</button>
    <dialog ref={dialog} className="install-dialog" aria-labelledby={`${id}-title`} onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
      <div className="install-dialog-body">
        <h2 id={`${id}-title`}><span aria-hidden="true">📲</span> 앱으로 설치하기</h2>
        <p className="install-dialog-sub">한글 마감실 · 홈 화면에서 바로 열려요</p>
        {guide?.lead && <p>{guide.lead}</p>}
        {guide?.openExternalLabel && <a className="button primary install-external" href={kakaoOpenExternalUrl(window.location.href)}>{guide.openExternalLabel}</a>}
        {guide && guide.steps.length > 0 && <ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
        {guide?.note && <p className="install-dialog-note">{guide.note}</p>}
        <p className="install-dialog-note">설치해도 문서는 지금처럼 이 브라우저 안에서만 처리하며, 인터넷 없이 다시 여는 기능은 제공하지 않아요.</p>
        <form method="dialog"><button className="button secondary install-close">닫기</button></form>
      </div>
    </dialog>
  </>;
}
