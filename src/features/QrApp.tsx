import { useId, useRef } from 'react';
import './InstallApp.css';

const PUBLIC_URL = 'gmlduqzhd123-lab.github.io/Hwp/';

/** 📱 QR로 접속: 교실 TV·전자칠판에 이 앱 주소 QR을 띄운다. 빌드에 포함한 qr.svg를 써서 네트워크 요청이 없다. */
export default function QrApp() {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" className="button qr-button" aria-label="QR 코드로 접속" onClick={() => dialog.current?.showModal()}><span aria-hidden="true">📱</span> QR</button>
    <dialog ref={dialog} className="install-dialog qr-dialog" aria-labelledby={`${id}-title`} onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
      <div className="install-dialog-body">
        <h2 id={`${id}-title`}><span aria-hidden="true">📱</span> 카메라로 찍어서 들어와요</h2>
        <p className="install-dialog-sub">한글 마감실</p>
        <img className="qr-image" src={`${import.meta.env.BASE_URL}qr.svg`} alt="한글 마감실 주소 QR 코드" width={420} height={420} />
        <p className="qr-url">{PUBLIC_URL}</p>
        <p className="install-dialog-sub">휴대폰·태블릿 카메라를 QR 코드에 비추면 바로 열려요.</p>
        <form method="dialog"><button className="button secondary install-close">닫기</button></form>
      </div>
    </dialog>
  </>;
}
