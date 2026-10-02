# 공개 합성 fixture (T-01)

모든 입력은 `scripts/generate-fixtures.mjs`가 직접 조립한 ZIP/XML 패키지다. 실제 사람·학생·학교 자료, 원격 자원, 실제 문서의 복사본은 포함하지 않는다. 한컴 한글에서 생성하거나 열어 검증한 문서가 아니다. ZIP/XML의 구조 시험이 실제 HWPX 호환성·조판·재저장 검증을 대신하지 않는다.

| ID | 목적 | 연결 기준 |
| --- | --- | --- |
| 01-plain-text | 한글·유니코드·연속 공백·탭·줄바꿈·이스케이프 문자 | AC-05, AC-16 무변경 |
| 02-alternate-prefixes | 같은 namespace URI의 다른 XML prefix | AC-05 |
| 03-spine-order | 파일명 순서와 다른 OPF spine 순서 2→0→1 | AC-04 |
| 04-simple-table | 병합·중첩 없는 2×2 표의 구조 | AC-06 |
| 05-unsupported-tables | 병합 표와 중첩 표의 미지원 경계 | AC-06 |

각 `.golden.json`에는 입력의 SHA-256, entry 순서·원문 바이트 해시, 선언 구역 순서, XML entity를 해석한 문단 텍스트와 검사 전용 제한을 기록한다. 이 해시는 공개 합성 파일의 시험 정답이며 이용자 문서 해시의 지속 저장 기능이 아니다. XML 원문 바이트 해시는 파서의 공백 정규화와 별도로 보존을 확인한다.

재생성은 저장소 루트에서 `node scripts/generate-fixtures.mjs`를 실행한다. 고정 DOS 날짜, 고정 entry 순서, 모든 entry의 STORED 방식, 추가 timestamp 미사용으로 같은 고정 ZIP 라이브러리 버전에서 재현 가능하다. `mimetype`은 첫 entry이며 `application/hwp+zip` 값을 비압축으로 저장한다. OCF container가 `Contents/content.hpf`를 지정하고 OPF manifest/spine이 header와 section을 연결한다.

이 최소 패키지는 스타일·레이아웃 규격 전체를 구현하지 않는다. header의 11pt/12pt 문자 모양과 기존 font ID는 참조 읽기 시험용 후보다. 줄 배치 캐시 정책과 한글 빌드별 출력 호환성은 미검증이다. 다섯 fixture 모두 `INSPECT_ONLY`이며 자동 교정 대상이 아니다. AC-32·33 및 G0 교정 검증은 미실행이다. T-03에서 모델·표 분류 정답을 확장하고 T-04에서 실제 한글에서 확인한 패키지와 수동 검증 기록을 별도로 추가해야 한다.
