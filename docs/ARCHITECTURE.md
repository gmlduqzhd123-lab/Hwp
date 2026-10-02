# T-00~T-02 구조

`src/domain/`은 오류 코드, 중앙 자원 제한, 입력 검사 보고서를 정의한다. `src/engine/package/metadata.ts`는 압축 해제 전에 ZIP 중앙 디렉터리·로컬 헤더·경로·중복·파일/디렉터리 충돌·암호화·압축 방식·선언 크기·겹침을 검사한다. data descriptor는 CRC와 두 크기를 비교하여 signed/unsigned 형식을 구분한다. `src/engine/preflight.ts`는 각 엔트리를 순서대로 스트리밍 해제하면서 CRC와 실제 크기를 확인한다. 바이너리 자원은 전체 버퍼로 보관하지 않는다.

`src/engine/xml/validate.ts`는 UTF-8/XML 1.0, namespace, XML 깊이·속성·요소·토큰·텍스트 제한을 검사한다. 직접 XML API도 필수 제한의 양의 정수를 검증하고 설정 사본을 사용한다. XML 요소는 패키지 전체에서도 100,000개로 누적 제한한다. 공백이 붙은 namespace 바인딩, DTD, 외부 엔티티, 실행 요소, 외부 URL·UNC 경로는 거부한다. 원문 XML을 HTML로 렌더링하거나 직렬화하지 않는다. 패키지 경로·manifest·spine과 버전·MIME·구역 수의 선언 일관성을 검사하며, 지원하지 않는 `xml:base`는 거부한다. T-03의 문단·서식 모델은 아직 구현하지 않았다.

`createDocumentSession`은 첫 비동기 호출 전에 입력을 복사하여 private closure에 보관한다. 원본·Worker·출력 getter는 매번 별도 바이트 사본을 반환한다. `exportUnchanged()`는 ZIP을 다시 압축하거나 XML을 다시 쓰지 않는다. 원본 해시는 세션 메모리에만 있으며 앱은 이를 원격 전송·지속 저장하지 않는다.

화면은 원본 사본을 보관하고 Worker에는 별도 사본을 transfer한다. Worker는 원본·파일명·해시·본문 없이 검사 보고서 또는 안전한 오류 코드만 반환하고 한 번에 한 검사만 처리한다. Worker protocolVersion·jobId와 현재 작업 ID로 늦은 응답을 거부하고, 취소·종료 때 Worker를 종료한다. 첫 준비가 20초를 넘으면 실패와 재시도를 제공한다. 새 문서 검사 전에 저장 여부를 확인하며, 완료된 원본은 다음 파일 검사 실패로 임의 변경하지 않는다. 취소 후 늦게 읽힌 입력은 지운다. 새로고침·작업 종료 후 원문 복구 기능은 없다.

ZIP은 `@zip.js/zip.js/lib/zip-core-native.js`의 번들에 포함된 JavaScript 코덱을 사용한다. 추가 Worker나 WASM을 가져오지 않는다. 빌드된 예시 한 개는 합성 fixture를 data URL로 포함한다. 첫 Worker는 배포된 같은 출처의 파일로 준비하고 재시작은 앱에 사전 포함한 `?worker&inline`의 코드로 Blob Worker를 만든다. 이용자 문서에서 실행 코드를 생성하지 않는다. 코드가 앱과 Worker 파일에 함께 포함되는 빌드 크기 비용을 감수하여 준비 후 종료·취소·재시도에 HTTP 요청을 없앴다.

운영 CSP는 `script-src 'self'`, `worker-src 'self' blob:`, `connect-src 'none'`이며 문서 선택 후 네트워크 요청이나 지속 저장소 사용이 없다. 개발 서버의 HMR·모듈 로딩과 오프라인 새로고침은 운영 오프라인 보장의 범위 밖이다. 소스/정적 검사에서 진입점·공개 파일·실행 자원 URL·키 형태 값·전체 CSP를 확인한다. 정적 검사만으로 임의 JavaScript 동작 전체를 증명하지 않으며 실제 오프라인 브라우저 시험을 함께 수행한다.

페이지는 해시 라우팅과 검증된 Vite base를 사용한다. 빌드 기본 경로는 `/Hwp/`이며 임의 중첩 경로 시험도 수행한다. 사용자 지정 경로는 preview·E2E에도 동일하게 적용한다. 중첩 경로 시험은 이전 `dist`를 보존하고 성공·실패 후 복원한다. `dist`는 정적 빌드 산출물이며 직접 편집하지 않는다. Pages 배포 workflow는 T-12의 별도 작업이다.
