# T-00~T-02 구현·검증 기록

확인일: 2026-10-02. 범위: FR-02 입력 사전 검사, FR-12 무변경 보존의 선행 단계, AC-01~03, AC-16 무변경 항목 및 AC-36 기본 제약 검사. 정식 출시나 G0 전체 통과 기록이 아니다.

## 구현

- T-00: React·TypeScript·Vite, Node 24.19.0/npm 11.9.0, 정확한 dependency 버전과 npm lockfile, 실행·검증 스크립트, docs 경로, 정적 산출물 준비.
- T-01: ZIP 후보 비교와 saxes 기능 검토, 라이선스·지원 매트릭스, 결정적 합성 HWPX 5개와 golden. 실제 한글이 생성한 완전한 문서라는 보장은 없다.
- T-02: HWP/PDF/위장 파일 구분, ZIP 중앙·로컬 메타데이터, CRC·암호화·경로·중복·압축·크기 제한, UTF-8 XML·외부 참조·활성 자원 제한, private 원본 사본과 SHA-256, 바이트 동일 무변경 내보내기.
- 초기 화면: Worker 준비와 20초 제한·재시도, 예시, 실제 입력 검사 보고서, 원본 다운로드, 문서 교체 확인, 취소·실패 후 기존 문서 보존, 작업 종료·해시 경로 복구. 운영 빌드는 준비 후 Worker 재시작도 오프라인으로 수행한다. 원문·파일명·해시 지속 저장이나 외부 전송 기능은 없다.
- 실제 앱 QA: XML namespace·UNC·제한 설정, ZIP 경로·descriptor·디렉터리, 패키지 선언, Worker 중복 작업과 오프라인 재시작, 공개 파일·CSP·프로젝트 경로 검사의 재현된 결함을 수정했다. 변경 파일과 회귀 사례는 [QA_FIXES.md](QA_FIXES.md)에 기록했다.

## 실행 결과

작업 디렉터리 `/workspace/Hwp`, Node v24.19.0, npm 11.9.0, Chromium 151.0.7922.173 (Debian 시스템 설치본).

| 명령 | 실제 결과 |
| --- | --- |
| `npm ci` | lockfile 기반 재설치 성공; 저장할 설치 스크립트도 실제 실행 |
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm run check:constraints` | 진입점·public 포함 18개 파일·4개 허용 runtime 의존성 검사 통과 |
| `npm run test:unit` | 132개 통과 (소유권·프로토콜·안전 오류·XML·메타데이터·라이브러리·fixture·빌드 검사) |
| `npm run test:integration` | 40개 통과 (5개 입력 왕복·해시·Worker transfer·선언 순서·일관성·공식 한컴 패키지 관례) |
| `npm run test:security` | 259개 통과 (형식·손상·경로·제한·위조 크기·XML·활성 자원·메타데이터·경로 모호성 회귀) |
| `npm run build` | `/Hwp/` 정적 빌드 성공, source map 없음 |
| `npm run check:dist` | 번들 Worker·CSP·정적 파일 검사 통과 |
| `npm run test:e2e` | 실제 운영 브라우저 19개 통과 |
| `npm run test:pages-path` | `/nested/hwp-check/`로 빌드·dist 검사 후 동일 브라우저 19개 재실행 통과; 기존 기본 빌드 복원 |
| `npm run dev -- --port 5174 --strictPort` | HTTP에서 실제 Worker·합성 예시·다운로드 바이트 일치·종료 후 준비·390px 화면 확인 |

서로 다른 자동 시험은 총 450개다. 초기 검증판 206개, 실제 QA 뒤 344개에 입력 호환성과 안전 오류 회귀 106개를 추가했다. 중첩 경로에서 같은 브라우저 시험을 반복한 횟수는 별도의 새 시험으로 더하지 않았다. 최종 실행에서 실패·skip은 없다. 개발 서버의 직접 확인은 초기 QA 기록이며, 이번 입력 호환성 수정은 운영 빌드·Worker·다운로드와 중첩 경로에서 다시 검증했다.

한컴 공식 자료와 공개 모델을 기준으로 OPF 두 정확 URI, ZIP 루트 경로, header spine, preview/RDF 보조 rootfiles와 역사적 `tagetApplication` 표기를 합성 입력에 반영했다. 비실행 XML 메타데이터 주소는 읽기만 하고, 외부 자원 참조·실행·DTD·이벤트·잘못된 이름공간은 계속 거부한다. 모호한 root/relative 경로, OPF 혼용, 중복·누락과 RDF 자원 제한도 검증했다. 근거와 상세 범위는 [HWPX_COMPATIBILITY.md](HWPX_COMPATIBILITY.md)에 기록했다. 사용자 파일은 받지 않아 그 파일의 성공은 미확인이다.

`npm run test:deployed`의 새 호환성 입력·오프라인 검사·바이트 동일 다운로드 경로를 loopback HTTP preview에서 실제 Chromium으로 확인했다. 원격 공개 주소 검증은 배포 후 같은 스크립트를 GitHub Actions에서 실행한 결과로 확인한다. loopback 성공을 공개 사이트 검증으로 취급하지 않는다.

원본 바이트 소유권은 일반 Uint8Array뿐 아니라 Node Buffer의 `slice()` 공유 동작을 고려해 강제 복사한다. 입력·getter·출력·전송 사본을 변경하거나 detach해도 원본이 유지되는 회귀 시험을 포함한다. XML 요소의 패키지 누적 제한도 추가 OPF 자원의 메모리 증가를 차단한다.

브라우저 시험은 다운로드 파일을 직접 읽어 입력과 비교하고 독립 preflight로 다시 확인한다. 앱 준비 후 네트워크를 끊은 상태에서 실제 DEFLATE 입력과 예시의 검사·다운로드가 성공했고 요청·브라우저 지속 저장·Service Worker 등록이 없음을 확인했다. 오프라인 종료·취소 뒤 새 Worker 준비, 교체 확인의 승인·거절, 늦은 파일 읽기·Worker 결과 무시, 동시 Worker 작업 거부, Worker 무응답·실패 후 재시도와 다운로드 URL 정리도 시험했다. 좁은 화면·200% 확대의 가로 넘침 없음은 합성 화면의 자동 확인이며 모바일 실기기 AC-30의 완료가 아니다.

정적 검사는 모든 공개 파일의 키 형태 값과 허용 파일 경로, 실제 CSP 전체를 확인한다. HTML·CSS 자원과 JavaScript literal 요청/import의 외부 URL을 검사하면서 XML namespace·라이선스 출처 같은 비실행 문자열을 허용한다. 중첩 경로 시험의 성공·실패 시 기존 빌드 복원과 종료 코드 보존을 별도 CLI 회귀로 확인했다. 이 검사는 실제 브라우저 검증과 함께 사용하며 임의 JavaScript 동작 전체를 증명하지 않는다.

## 남은 제한과 다음 단계

- 실제 문서의 모든 HWPX 패키지 변형을 지원하지 않는다. ZIP64, 암호, 서명/미지원 구조의 교정은 제공하지 않는다. 모든 허용 입력은 `INSPECT_ONLY`이고 문단·run·표·서식 모델이나 자동 교정은 없다.
- AC-16의 전체 되돌리기·수정 재적용은 미구현이다. 입력 바이트 그대로 내보내는 항목만 검증했다.
- AC-04~06은 fixture의 정답·namespace·선언 순서 선행 검사만 준비했다. 실제 구조 탐색 전체 완료가 아니다.
- AC-32·33 실제 Windows·한컴 한글 개봉·조판·캐시 검수는 **미실행**이다. 확인자·실제 빌드 기록이 없고, 교정 범위는 열지 않았다.
- QA 당시 Git HTTPS 읽기와 별도 작업 브랜치 대상 `git push --dry-run`은 성공했고 API 조회는 거절되었다. 이후 사용자의 커밋·푸시·배포 요청에서 API 읽기가 가능해져 공개 저장소, `main`, 기존 Pages의 branch 방식을 확인했다. 기존 플랫폼 인증을 사용하며 저장소 공개 여부를 변경하지 않는다.
- 시험 브라우저 다운로드 도메인은 `Domain forbidden`으로 차단되었다. 설치된 시스템 Chromium으로 검증했으며 Playwright가 지정한 다운로드 브라우저와 같은 버전이라고 주장하지 않는다.
- 후속 배포 요청으로 `.github/workflows/pages.yml`, 화면 빌드 commit 표시, `npm run test:deployed`와 [배포 안내](DEPLOYMENT.md)를 추가했다. 검증·main artifact 배포·실제 URL smoke를 분리하고 공식 Action SHA와 최소 권한을 고정한다. 실제 원격 실행 결과는 해당 Actions 실행과 공개 사이트의 commit으로 확인한다. 이는 현재 검사 전용 범위의 배포 구성이며 T-12 또는 전체 제품 출시 완료를 주장하지 않는다.
- 환경 설정 초안 저장과 환경 게시도 서로 다르며, 새 작업에서의 snapshot 복원은 아직 검증하지 않았다.

다음 T-03은 기존 회귀를 유지하며 package namespace/선언 순서와 원본 byte sourceSpan을 바탕으로 문단·run·단순 표·공유 서식 참조를 읽고 지원/읽기 전용/거부를 구분한다. T-04로 넘어갈 때는 실제 한글 시험 환경과 원본 기반 단일 속성 patch·캐시 정책의 증거가 필요하다.

원래의 AGENTS·PRD·TASKS·ACCEPTANCE·CODEX_START는 보존했다. README를 현재 실행 안내로 갱신하고 docs 링크, 앱/엔진/Worker, fixture·시험, 설정·스크립트·라이선스 고지를 추가했다.
