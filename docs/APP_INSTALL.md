# 앱 설치(홈 화면에 추가) — F-APP-INSTALL

## 범위

상단 오른쪽(휴대폰은 메뉴 줄 오른쪽) `📲 앱 설치` 버튼으로 한글 마감실을 홈 화면·바탕화면 앱처럼 설치한다. 앱으로 열린 상태(`display-mode: standalone`)에서는 버튼을 숨긴다.

- 크롬·엣지·삼성 인터넷처럼 설치 창을 띄울 수 있는 브라우저는 `beforeinstallprompt` 신호를 앱이 그려지기 전에 받아 두었다가 바로 설치 창을 연다.
- 그 밖의 환경은 `src/domain/app-install.ts`가 브라우저 정보(userAgent·platform·터치 지점 수)만으로 아이폰 Safari·카카오톡·인앱 브라우저·안드로이드·PC 안내를 고른다. 카카오톡은 `kakaotalk://web/openExternal`로 같은 주소(해시 제외)를 기본 브라우저에서 다시 연다.

## 제약과 보안

- 서비스 워커·캐시·지속 저장소를 사용하지 않는다. 설치 후에도 문서는 지금처럼 열린 화면의 메모리에서만 처리하며 오프라인 재접속은 제공하지 않는다(`check:constraints`의 `navigator.serviceWorker` 금지 유지).
- 공개 파일은 `manifest.webmanifest`와 `icons/`의 PNG 네 개(192·512·maskable 512·apple-touch 180)만 추가로 허용한다(`check:dist`).
- 운영 CSP에 `manifest-src 'self'`만 추가했다. 나머지 지시어는 그대로이며 `requireProductionPolicy`가 전체 정책을 확인한다.
- 안내 문구와 설치 상태는 문서·파일명·해시와 무관하다.

## 시험

| 명령 | 확인 |
| --- | --- |
| `tests/unit/app-install.test.ts` | 아이폰·아이패드(데스크톱 모드)·카카오톡·인앱·삼성 인터넷·PC·파이어폭스 분류, 카카오톡 외부 열기 주소 |
| `tests/unit/build-config.test.ts` | 허용한 manifest·아이콘만 공개, 다른 PNG 거부, `manifest-src` 없는 정책 거부 |
| `tests/e2e/app-install.spec.ts` | 운영 빌드에서 Chromium이 manifest를 CSP 오류 없이 읽고 아이콘이 모두 200, 버튼→안내 창→닫기 후 포커스 복귀 |

실제 기기의 설치 창과 홈 화면 아이콘 모양은 자동 시험으로 확인하지 않았다(미실행).
