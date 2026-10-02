# T-00~T-02 실제 앱 QA와 회귀 수정

확인일: 2026-10-02. 대상은 입력 사전 검사와 원본 바이트 보존을 제공하는 현재 초기 검증판이다. 합성 HWPX, 메모리에서 조립한 공격·경계 입력, 실제 Chromium의 앱·Worker·다운로드 경로를 사용했다. 실제 학생·교사 문서나 개인정보는 사용하지 않았다.

이번 작업은 현재 구현이 주장하는 입력 안전성, 실패 복구, 무변경 저장과 정적 빌드 검사를 확인한다. T-03 문단·표·서식 모델, T-04 자동 교정, T-12 Pages CI·배포를 구현하거나 완료 처리하지 않는다. 최종 통합 시험 결과는 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)에 기록한다.

## 입력 엔진과 원본 보존

| 확인된 문제 | 수정과 회귀 확인 | 관련 파일 |
| --- | --- | --- |
| ZIP 이름을 정규화한 뒤 파일과 디렉터리가 같은 경로를 갖거나, 파일 아래에 자식 경로가 있는 모순을 통과시켰다. | NFC·대소문자 정규화, 디렉터리 끝 슬래시와 부모·자식 충돌을 함께 검사하여 압축 해제 전에 거부한다. | `src/engine/package/paths.ts`, `src/engine/package/metadata.ts`, `tests/security/package-regressions.test.ts` |
| 정상 unsigned ZIP data descriptor의 CRC 값이 signature와 같으면 signed descriptor로 오인할 수 있었다. | CRC와 압축·해제 크기를 함께 비교하여 descriptor 형식을 판정한다. 정상 경계 사례를 허용하고 불일치는 거부한다. | `src/engine/package/metadata.ts`, `tests/security/package-regressions.test.ts`, `tests/security/integrity-regressions.test.ts` |
| 압축 방식이 DEFLATE인데 압축 크기가 없는 디렉터리 항목을 건너뛰고 검사에 성공했다. | 지원하는 디렉터리 표시를 비압축·빈 항목으로 한정하고 모순된 압축 선언을 거부한다. 정상적인 명시적 디렉터리와 symlink 거부도 확인한다. | `src/engine/package/metadata.ts`, `tests/security/package-regressions.test.ts` |
| version 선언, container·manifest MIME, header와 spine의 구역 수·버전이 서로 모순되거나 선언한 section이 spine에서 빠져도 허용했다. | 실제 HWPX targetApplication, MIME, XML 버전, section 선언과 spine의 일관성을 확인한다. MIME의 정상적인 대소문자 차이는 유지한다. | `src/engine/package/identity.ts`, `tests/security/package-regressions.test.ts`, `tests/integration/adversarial.test.ts` |
| container 또는 OPF의 `xml:base`를 무시하고 상대 경로를 해석했다. | 현재 resolver가 지원하지 않는 base 변경을 명시적으로 거부하여 다른 대상을 가리키는 패키지를 처리하지 않는다. | `src/engine/package/identity.ts`, `tests/security/package-regressions.test.ts` |
| 잘못된 사용자 지정 자원 제한을 입력 사본 생성 전에 확인하지 않았다. | 검사 시작과 최초 입력 복사 전에 제한 값을 검증한다. 잘못된 제한은 문서 작업을 시작하지 않는다. | `src/engine/session.ts`, `tests/unit/session-regressions.test.ts` |
| XML parser가 namespace 선언의 앞뒤 공백을 제거하여 위장된 URI를 신뢰하는 패키지 namespace로 해석했다. | 선언 값의 identity가 바뀌는 공백을 거부한다. 정상 namespace 재바인딩·해제와 qualified attribute는 유지한다. | `src/engine/xml/validate.ts`, `tests/security/xml-regressions.test.ts`, `tests/unit/xml-regressions.test.ts` |
| XML 속성의 UNC·혼합 slash 경로가 브라우저에서 외부 주소로 해석되지만 외부 참조 검사에서 빠졌다. | entity 해석 후의 속성에서 UNC·혼합 slash 외부 참조를 거부한다. 안전한 오류에 원문 표식이 포함되지 않으며 입력 바이트가 유지되는지 확인한다. | `src/engine/xml/validate.ts`, `tests/security/xml-regressions.test.ts` |
| 직접 XML API를 호출할 때 NaN 등의 잘못된 제한이나 검사 중 값이 바뀌는 getter가 자원 상한을 무력화했다. | 제한 값을 한 번 복사하여 고정하고 유한한 양의 safe integer인지 확인한다. session·preflight 경로에서도 고정된 제한을 사용한다. | `src/engine/xml/validate.ts`, `src/engine/session.ts`, `src/engine/preflight.ts`, `tests/security/xml-regressions.test.ts`, `tests/unit/session-regressions.test.ts` |

추가 독립 시험은 형식 선언을 하나씩 바꾸거나 CRC·ZIP 메타데이터를 손상시킨 합성 입력을 사용한다. 원본 hash와 다운로드 바이트 비교를 유지하며, 수정된 문서를 가짜 성공값으로 처리하지 않는다.

XML의 BOM·CRLF·한글·보조 평면 문자와 parser chunk 경계를 넘는 원본 위치도 확인한다. 이 위치는 UTF-16 문자 offset이며 T-03의 UTF-8 byte sourceSpan 구현 완료를 의미하지 않는다. 주석·CDATA 안의 비활성 예시는 허용하고 실제 DTD·processing instruction은 거부하는 구분도 유지한다.

## 앱과 Worker의 실패 복구

| 확인된 문제 | 수정과 회귀 확인 | 관련 파일 |
| --- | --- | --- |
| 작업 중인 문서를 새 파일이나 예시가 확인 없이 교체했다. | 새 작업 전에 저장 여부를 확인하고, 취소하면 기존 원본·상태·다운로드를 유지한다. 새 입력의 검사 성공 전에 기존 원본을 버리지 않는다. | `src/App.tsx`, `tests/e2e/lifecycle.spec.ts` |
| Worker가 초기화 메시지에 응답하지 않으면 준비 상태가 끝나지 않아 다시 시도할 수 없었다. | 초기화 시간 제한과 작업 ID 없는 실패 메시지를 처리하여 안전한 오류와 재시도 경로를 제공한다. | `src/App.tsx`, `tests/e2e/lifecycle.spec.ts` |
| 같은 Worker에 중복 `INSPECT`가 도착하면 엔진 작업이 동시에 시작됐다. | 활성 작업이 있는 동안 추가 검사를 거부하고, 성공·실패 모두 처리 상태를 해제하여 후속 순차 검사를 허용한다. | `src/workers/document.worker.ts`, `tests/e2e/lifecycle.spec.ts` |
| 파일을 검사 영역 밖에 놓으면 브라우저의 기본 파일 열기로 앱을 떠날 수 있었다. | 파일 drag/drop의 기본 동작을 막고 검사 영역을 안내한다. 일반 텍스트·링크 drop은 방해하지 않는다. | `src/App.tsx`, `tests/e2e/lifecycle.spec.ts` |
| 운영 앱 준비 후 네트워크를 끊으면 작업 종료·취소에 따른 Worker 재생성이 외부 Worker 파일을 다시 요청하여 다음 작업을 할 수 없었다. | 최초 Worker는 같은 배포 경로에서 로드하고, 재시작은 이미 받은 빌드 코드의 inline Worker로 실행한다. 실제 offline 종료·새 문서·취소 복구를 확인한다. | `src/App.tsx`, `vite.config.ts`, `scripts/runtime-checks.mjs`, `tests/e2e/lifecycle.spec.ts` |

취소·작업 종료·새 작업의 늦은 Worker 응답, 늦게 끝난 파일 읽기, 다운로드 Object URL 정리, 실제 내보내기와 새 파일 확인, 키보드·확대 화면도 브라우저 회귀 대상으로 삼는다. 실패 후 원본을 다시 내려받아 입력 바이트와 비교한다.

inline Worker는 검토한 앱 코드를 빌드에 포함한 것이며 이용자 문서를 실행 코드로 만들지 않는다. 운영 CSP는 재시작에 필요한 `worker-src 'self' blob:`만 허용하고 `script-src 'self'`·`connect-src 'none'`을 유지한다. 이 offline 보장은 운영 번들을 준비한 뒤의 작업에 해당하며, 최초 접속이나 개발 서버 HMR의 offline 사용을 보장하지 않는다.

## 빌드·경로·공개 산출물 검사

| 확인된 문제 | 수정과 회귀 확인 | 관련 파일 |
| --- | --- | --- |
| 외부 자원 검사에서 특정 호스트 접두어만 차단하여 다른 호스트의 HTML script와 CSS import를 놓쳤다. | 공용 자원 검사에서 실행·자원 문맥의 URL을 확인한다. XML namespace 문자열, 라이선스 출처 링크와 현재 SVG data URL favicon은 정상 입력으로 유지한다. HTML named·numeric entity와 CSS escape를 해석하고, JavaScript AST에서 escape된 문자열·정적 template·import·요청 literal을 확인한다. | `scripts/runtime-checks.mjs`, `scripts/check-dist.mjs`, `tests/unit/build-config.test.ts` |
| 공개 텍스트 파일의 키 형태 값과 미검토 HWPX가 정적 산출물 검사를 통과했다. | 허용된 공개 산출물 경로를 명시하고 공개 파일의 키 형태 값을 검사한다. 검토한 합성 demo는 앱 번들에 포함하며 별도 HWPX 공개는 거부한다. | `scripts/check-dist.mjs`, `tests/unit/build-config.test.ts` |
| CSP에 `connect-src 'none'`만 있으면 느슨한 script 실행 정책도 통과했다. | 실제 meta 정책의 필수 지시문과 허용 값을 확인한다. 네트워크가 차단되어 있어도 실행 정책이 느슨한 빌드는 거부한다. | `scripts/check-dist.mjs`, `tests/unit/build-config.test.ts` |
| 소스 제약 검사가 앱의 루트 `index.html`을 검사하지 않았다. | 앱 진입점과 공개 파일을 검사하여 외부 실행 자원을 우회 삽입할 수 없게 한다. | `scripts/check-constraints.mjs`, `scripts/runtime-checks.mjs`, `tests/unit/build-config.test.ts` |
| 임의 중첩 Pages 경로 시험이 `dist`를 덮어쓴 채 종료했다. | 성공·실패 후 원래 빌드 경로를 복원하고 시험 실패 상태를 그대로 전달한다. | `scripts/check-pages-path.mjs`, `tests/unit/build-config.test.ts` |
| 사용자 지정 base를 빌드에만 적용하면 preview와 브라우저 시험이 다른 경로를 사용했다. | build·preview·E2E에서 같은 base를 사용하도록 설정과 실행 안내를 맞춘다. | `playwright.config.ts`, `README.md` |

CLI 검사 회귀는 임시 작업 폴더에서 실제 검사 스크립트를 실행한다. 정상 산출물과 의도적으로 삽입한 외부 자원·키 형태 표식·미검토 파일·느슨한 CSP를 구분한다. 경로 시험에서는 npm 명령을 통제한 재현으로 복원과 종료 코드를 확인하며, 실제 브라우저 중첩 경로 시험도 별도로 실행한다.

## 재검증 명령

저장소 루트에서 고정 Node·npm과 lockfile 설치를 사용한다.

```bash
npm ci
npm run check:constraints
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:security
npm run build
npm run check:dist
npm run test:e2e
npm run test:pages-path
```

이번 추가 회귀만 확인하려면 다음 명령을 사용한다.

```bash
npx vitest run tests/unit/build-config.test.ts tests/unit/session-regressions.test.ts tests/unit/xml-regressions.test.ts
npx vitest run tests/security/package-regressions.test.ts tests/security/integrity-regressions.test.ts tests/security/xml-regressions.test.ts tests/integration/adversarial.test.ts
npx playwright test tests/e2e/lifecycle.spec.ts
```

시험 산출물·trace·다운로드는 합성 입력만 포함하며 Git 제외 경로에 둔다. 시험 개수와 최종 통과 여부는 통합 실행 후에 기록하고 중첩 경로의 재실행을 새 시험으로 중복 계산하지 않는다.

## 남은 제한

모든 허용 문서는 현재 `INSPECT_ONLY`다. 무변경 내보내기는 원본 바이트 보존만 보장하며 서식 교정·전체 되돌리기·수정 재적용 기능이 없다. ZIP64, 암호화, 미지원 형식과 패키지 구조는 보수적으로 거부한다.

AC-32·33의 실제 Windows·한컴 한글 개봉·조판·캐시 검수는 **미실행**이다. 실제 한글 검증 없이 자동 교정 지원이나 G0 전체 통과를 주장하지 않는다. 모바일 실기기 검증도 수행하지 않았으며 자동 브라우저의 좁은 화면 확인과 구분한다.

초기 로컬 QA 뒤 후속 작업에서 GitHub Pages Source를 Actions로 전환하고 운영 배포와 공개 사이트 smoke test를 완료했다. [실제 배포 실행](https://github.com/gmlduqzhd123-lab/Hwp/actions/runs/36953070959)과 [배포 절차](DEPLOYMENT.md)를 확인할 수 있다. 정적 빌드·preview·임의 프로젝트 경로의 브라우저 시험은 공개 사이트 검증과 구분한다. 기존 버전 고정·lockfile·TLS·checksum 검증은 유지한다.

사용자가 보고한 `XML_UNSUPPORTED` 입력 실패 이후 공식 한컴 패키지 구조와 비실행 XML 메타데이터의 호환성 오류를 별도로 수정했다. 근거·수정 범위·사용자 파일 미검증 한계는 [HWPX_COMPATIBILITY.md](HWPX_COMPATIBILITY.md)에 기록한다.
