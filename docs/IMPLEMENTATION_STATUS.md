# T-00~T-03 구현·검증 기록

확인일: 2026-10-02. 현재 범위는 입력 사전 검사, 문서 구조·서식 읽기, 무변경 원본 사본 내보내기다. FR-02·03, AC-01~06 및 AC-16의 무변경 항목을 검증했다. 정식 출시나 G0 전체 통과 기록이 아니다.

## 구현

- T-00: React·TypeScript·Vite, Node 24.19.0/npm 11.9.0, 고정 dependency와 lockfile, 정적 빌드·검증 스크립트.
- T-01: ZIP/XML 라이브러리 비교, 라이선스·지원 매트릭스, 결정적 합성 HWPX 5종과 golden. 실제 한글에서 조판 확인한 문서라는 보장은 없다.
- T-02: 형식 판별, ZIP CRC·경로·암호·압축·크기 검사, UTF-8 XML·외부 참조·활성 자원 제한, private 원본 사본과 해시, 바이트 동일 내보내기. 한컴 패키지 관례와 비실행 XML 메타데이터 호환성은 [HWPX_COMPATIBILITY.md](HWPX_COMPATIBILITY.md)에 기록했다.
- T-03: 선언 순서에 따른 구역·문단·run·표·행·셀, 실제 텍스트, 글꼴·글자/문단 모양·스타일 참조와 단위·출처, 원본 UTF-8 byte sourceSpan, 구조 경로, 미해석·읽기 전용 사유. 자세한 범위는 [DOCUMENT_INSPECTION.md](DOCUMENT_INSPECTION.md)에 있다.
- 화면: 기존 Worker·취소·교체·원본 다운로드 흐름에 문서 구조 보기를 연결했다. 구역 선택, 문단 번호 이동, 표 셀→문단 이동, 서식 상세와 제한된 목록·긴 텍스트 탐색을 제공한다. 문서 교체 때 탐색 상태를 초기화한다.

모든 결과는 `INSPECT_ONLY`, `editingEnabled=false`다. 서식 값을 추정하거나 기본 ID 0으로 대체하지 않는다. XML 전체 재생성·편집·재압축은 하지 않는다. Worker protocol 2는 같은 탭의 UI로 plain 읽기 모델을 반환하며 원본 bytes·XML tree·파일명·해시는 결과에 넣지 않는다. 원문·파일명·해시의 지속 저장과 외부 전송은 없다.

## 실행 결과

작업 디렉터리 `/workspace/Hwp`. Node v24.19.0, npm 11.9.0, 시스템 Chromium 151.0.7922.173.

| 명령 | 실제 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm run check:constraints` | 25개 source 파일·4개 허용 runtime 의존성 검사 통과 |
| `npm run test:unit` | 223개 통과 |
| `npm run test:integration` | 62개 통과 |
| `npm run test:security` | 291개 통과 |
| `npm run build` | 기본 `/Hwp/` 정적 빌드 통과 |
| `npm run check:dist` | 5개 공개 파일·bundled Worker·CSP·source map 없음 확인 |
| `npm run test:e2e` | 실제 운영 브라우저 25개 통과 |
| `npm run test:pages-path` | `/nested/hwp-check/` 빌드·dist 검사 및 동일 브라우저 25개 재실행 통과, 기본 빌드 복원 |

서로 다른 자동 시험은 총 **601개**다. 이전 입력·보존 검증판 465개에 이번 구조 읽기 회귀 136개를 추가했다. 중첩 경로에서 같은 시험을 반복한 횟수는 새 시험으로 더하지 않았다. 최종 실행에서 실패·skip은 없다.

합성 golden 5종의 실제 텍스트·선언 순서·표 구조를 비교했고, 모든 모델 노드의 span을 원본 ZIP entry 바이트로 독립 확인했다. BOM·CRLF·한글·emoji·entity·CDATA·제어 탭/줄바꿈, 누락·중복 서식·글꼴, 잘못된 표 주소·병합·중첩, 필드 범위와 미지원 namespace를 검사했다. 세션 getter·Worker 전송 사본·모델을 변경해도 원본과 바이트 동일 출력이 유지된다.

새 읽기 경로에서도 기존 XML 안전 gate를 유지한다. 패키지 누적 요소+텍스트/UTF-8 텍스트 예산, 매우 긴 namespace·local·entry 경로의 모델 증폭, 중복 ID lookup과 공유 서식 값의 처리량·메모리를 제한했다. UI는 긴 font 이름도 일부만 표시하고 원문을 React 텍스트로 렌더링한다.

브라우저에서는 실제 Worker의 문단·서식·표 결과, 구역 선언 순서, 셀→문단 이동, 문서 교체 상태 초기화, 85개 문단의 제한된 DOM과 emoji 텍스트창, 매우 긴 글꼴 이름, 원본 다운로드를 확인했다. 준비 후 오프라인 검사·종료·취소·재검사 동안 HTTP 요청이 없고 브라우저 지속 저장소에 문서 데이터가 없다. 좁은 화면·200% 확대의 자동 확인은 모바일 실기기 검수 완료가 아니다.

`npm run test:deployed`는 공개 사이트에서 정확한 commit, Worker·본문·글자 크기·spine 순서·표 셀, 원본 다운로드와 오프라인 재시작을 확인하도록 확장했다. 공개 URL 결과는 해당 main Actions 실행의 smoke job으로 확인한다. loopback HTTP preview의 성공을 공개 사이트 성공으로 취급하지 않는다.

## 남은 제한

- 사용자 파일은 받지 않아 그 파일의 성공은 미확인이다. 실제 HWPX의 모든 변형을 지원하지 않는다. HWP/PDF 변환·암호화·ZIP64는 지원하지 않는다.
- 서식 기준 설정·규칙 평가·승인·최소 교정·공유 서식 복제·전체 되돌리기·재적용은 미구현이다. 현재 출력은 바꾸지 않은 원본 사본이다.
- AC-32·33 실제 Windows·한컴 한글 개봉·조판·캐시 검수는 **미실행**이다. 확인자·실제 빌드 기록이 없고 편집 범위는 열지 않았다.
- 실제 모바일 기기 AC-30과 새 환경 snapshot 복원은 미검증이다. 개발 환경의 기존 pinned 도구·실행 스크립트는 사용 가능하며 추가 설정 변경은 필요하지 않았다.

다음 T-04에서는 원본 기반 승인 속성 한 종류의 patch·공유 모양 복제·독립 출력 검사와 실제 한글 검증을 준비한다. 원래 AGENTS·PRD·TASKS·ACCEPTANCE·CODEX_START는 보존했다.
