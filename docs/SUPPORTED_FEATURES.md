# 지원 매트릭스 — T-01~T-03

현재 범위는 안전 입력, 문단·표·서식 참조 읽기와 무변경 원본 반환이다. 편집 속성, 한글 출력 호환성, 실제 조판은 아직 지원으로 선언하지 않는다. 다섯 공개 fixture는 한컴이 생성·검증한 파일이 아닌 직접 조립한 합성 패키지다.

| 영역 | 시험 범위 | 현재 지원 등급 | fixture·AC | 한글 빌드·수동 결과 |
| --- | --- | --- | --- | --- |
| 패키지 식별 | 첫 STORED `mimetype=application/hwp+zip`, OCF container→OPF | 안전 입력 판별 대상 | 전체, AC-01~03 | 미실행 |
| 한컴 패키지 관례 | OPF 끝 `/` 두 정확 URI, ZIP 루트 경로, spine header, 보조 preview/RDF rootfile | `INSPECT_ONLY`; 모호한 경로·선언은 거부 | 메모리 합성 호환성 회귀 | 미실행 |
| 비실행 XML 메타데이터 | XSI schema hint, OPF meta.content, RDF 식별자와 hp:switch/case의 required-namespace | 정확한 문맥의 문자열만 읽고 주소 조회·실행 없음 | XML 단위·보안·브라우저 회귀 | 미실행 |
| 버전 선언 | `major=5 minor=1 micro=0 buildNumber=0`, `xmlVersion=1.5` | 합성 입력 탐색 후보, 실제 버전 지원 미확정 | 전체 | 미실행 |
| 일반 순수 텍스트 문단 | 한글·특수문자·연속 공백·탭·줄바꿈 | `INSPECT_ONLY` | 01, AC-05 | 미실행 |
| 다른 namespace prefix | section/paragraph/head/core/OPF URI 동일 | `INSPECT_ONLY` | 02, AC-05 | 미실행 |
| 여러 구역 | OPF spine 2→0→1 | `INSPECT_ONLY` | 03, AC-04 | 미실행 |
| 단순 표 | 텍스트 셀 2×2 | `INSPECT_ONLY`, 실제 행·셀 구조 읽기 | 04, AC-06 | 미실행 |
| 병합·중첩 표 | 병합 셀·중첩 표 경계 | `INSPECT_ONLY`, 교정 차단 | 05, AC-06 | 미실행 |
| 글꼴 참조 | 기존 언어군 font ID 0, 합성 head | 실제 언어군·정의 참조 읽기; 누락·중복은 unknown, 변경 비활성 | 전체, AC-14 후속 | 미실행 |
| 글자 크기 | 1100/1200 합성 모양 | HWPUNIT 원값과 pt 환산 표시; 변경 비활성 | 전체, AC-10·14 후속 | 미실행 |
| 줄 배치 캐시·Preview | 검증한 정책 없음 | 모든 편집 비활성 | AC-33 | 미실행 |
| 무변경 내보내기 | 입력 전체 ZIP 바이트 동일 반환 | T-02 자동 시험 대상 | 전체, AC-16 | 원본 반환은 조판 검증을 주장하지 않음 |

이 목록의 형식 버전은 fixture에 넣은 선언이며 해당 버전 전체를 지원한다는 뜻이 아니다. 최소 합성 header에는 완전한 스타일·레이아웃 구조가 없다. 문서 전체 재생성, 자동 font 대체, merged/nested table 교정, 실제 페이지 배치 판단을 제공하지 않는다. 입력이 받아들여졌다는 사실과 한글에서 정상 개봉된다는 사실을 구분한다.

T-03은 원본 UTF-8 byte span, 선언 순서, 실제 문단·run·표·참조와 읽기 전용 사유를 제공한다. 병합·중첩 표, 필드·머리말·꼬리말·주석·개체, 미확인 서식은 교정 대상으로 취급하지 않는다. 자세한 지원 범위와 합성 시험 근거는 [DOCUMENT_INSPECTION.md](DOCUMENT_INSPECTION.md)에 있다. T-04 편집 활성화에는 지정 Windows·한글 실제 빌드, 확인자·확인일·fixture·속성별 AC-32/33 결과와 원문·비대상 보존 시험이 필요하다. 결과를 기록하기 전까지 `EDITABLE` 지원 범위는 비어 있다.
