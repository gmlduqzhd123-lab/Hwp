# 라이브러리 선정 기록 — T-01

운영 앱은 브라우저·Worker에서만 파일을 다루는 정적 앱이다. ZIP/XML 후보는 `tests/library/candidates.test.ts`의 작은 합성 입력으로 검토한다. 실제 한글 호환성이나 출력 지원을 이 시험으로 확정하지 않는다.

| 라이브러리 | 고정 버전 | 라이선스 | 역할·판단 |
| --- | --- | --- | --- |
| `@zip.js/zip.js` | 2.22.0 | BSD-3-Clause | 채택. entry 메타데이터, 중복 경로의 노출, `checkSignature` CRC 검사, caller-controlled `WritableStream`, 압축 방식·entry 순서 제어 |
| `saxes` | 6.0.0 | ISC | 채택. Worker에서 DOM 없이 namespace URI 기반 XML 읽기, 엄격한 문법 검사, 위치·DOCTYPE 이벤트 |
| `fflate` | 0.8.3 | MIT | 개발용 비교 후보. 스트림 API도 제공하지만 `unzipSync`는 CRC를 검증하지 않고 중복 경로를 object key 하나로 축약하므로 현재 입력 안전 계층에는 미채택 |

ZIP probe는 첫 STORED `mimetype`의 local/central header, 수정한 payload의 CRC 검출, 중복 이름의 메타데이터 보존, 출력 byte budget 초과 시 stream 중단을 확인한다. ZIP 라이브러리만으로 경로 정규화·암호화·ZIP64·폭증·원본 보존 정책이 자동 충족되지는 않는다. 앱은 사전 metadata 검사와 실제 출력 byte 누적 제한을 함께 적용하고 CRC 검사를 명시적으로 켜야 한다. fflate의 스트림 API 자체가 부적합하다는 결론은 내리지 않았으며, 별도 CRC·중복 metadata 계층을 추가하지 않은 현재 비교 경로의 제한을 기록한다.

앱과 probe는 지원된 `@zip.js/zip.js/lib/zip-core-native.js` entry를 사용한다. `useWebWorkers: false`로 앱의 기존 문서 Worker 안에서 실행하며, WASM의 추가 로딩 없이 포함된 JavaScript codec을 사용한다. 기본 WASM entry의 암묵적인 자원 요청에 의존하지 않는다. 브라우저의 deflate 처리·오프라인 동작은 별도 실제 Worker 시험에서도 검증해야 한다.

기본 DOMParser와 객체 변환 XML 도구도 설계 대안으로 검토했다. DOMParser는 Worker에서 있다고 전제할 수 없고, 객체 변환 결과 자체는 원본 byte span·공백·알 수 없는 token 보존의 근거가 되지 않는다. 해당 대안의 원본 보존 기능을 실제 시험했다고 주장하지 않는다.

출력 sink가 budget 초과로 실패하면 ZIP 작업도 중단되지만 최종 예외 메시지가 라이브러리의 stream-close 오류로 바뀔 수 있다. 앱의 안정된 자원 제한 오류 코드는 sink에서 기록한 초과 상태로 결정하며 vendor 예외 문구에 의존하지 않는다.

saxes probe는 다른 prefix의 동일 URI, namespace attribute, 한글·보조 평면 문자의 원문 위치, DTD 감지 및 미정의 entity·잘못된 XML의 오류를 확인한다. `position`은 JavaScript UTF-16 위치이며 UTF-8 byte offset으로 직접 쓰면 안 된다. token 경계와 byte 매핑은 별도의 원본 보존 계층에서 만들어야 한다. SAX 읽기 이벤트를 다시 직렬화해 출력하는 방식은 채택하지 않는다. saxes는 자동 DTD 차단 정책이나 깊이·속성·텍스트 자원 제한을 제공하는 보안 엔진이 아니므로 앱에서 DOCTYPE 이벤트 즉시 거부와 제한을 구현해야 한다.

공식 API·라이선스 근거: 각 설치 패키지의 README, type declarations, LICENSE. 비교 재실행: 저장소 루트에서 `npx vitest run tests/library tests/fixtures`. 앱의 lockfile은 정확한 의존 트리를 고정한다. 설치·빌드 때 signature·checksum·TLS 검증을 우회하지 않는다.

2026-10-02 실행 결과: 후보 기능 시험 8개와 fixture golden 시험 5개, 총 13개 통과. native JavaScript DEFLATE 생성·CRC 재해제는 `fetch`를 차단한 Node 시험에서도 통과했다. fixture 재생성을 다른 `TZ=Pacific/Honolulu`에서도 실행해 다섯 입력의 byte hash가 동일함을 확인했다. 타입 검사와 변경 파일 lint도 통과했다. 이 결과는 Node 자동 구조 시험이며 한컴 한글의 실제 개봉·조판 검증은 미실행이다.

배포에는 `public/THIRD_PARTY_NOTICES.txt`의 전체 runtime 라이선스 고지를 포함한다. React/React DOM/scheduler, ZIP, saxes와 xmlchars 및 ZIP의 bundled JavaScript zlib port 고지를 보존한다. saxes npm 배포에 LICENSE가 빠져 있어 정확한 upstream v6.0.0 tag에서 가져왔고, zlib port는 설치 패키지 README가 가리키는 공식 저장소의 LICENSE.md를 확인했다. fflate는 개발 비교 시험에만 포함되어 운영 bundle 대상이 아니다.

남은 위험은 실제 문서의 버전별 패키지 규칙, 스타일·언어군 font 참조, byte patch 경계, line-segment 캐시 정책, Preview의 시점, 한글에서의 재개봉과 조판이다. T-03은 URI·선언 순서·sourceSpan을 검증하고 T-04는 수동 한글 기록과 캐시 검증을 갖춘 범위에서만 편집을 열어야 한다.
