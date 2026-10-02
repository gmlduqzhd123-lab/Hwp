# T-02 HWPX 입력 호환성 수정

확인일: 2026-10-02. 사용자가 입력 시 `XML_UNSUPPORTED` 오류를 보고했다. 사용자 파일은 받지 않았으므로 해당 파일의 정확한 원인은 아직 확정하지 않았다. 공식 한컴 자료와 기존 검사기를 대조하여 정상 패키지를 거부하는 조건을 별도로 재현했다.

## 패키지 구조

기존 합성 fixture는 OPF 이름공간 끝에 `/`가 없고 manifest 경로가 `content.hpf` 디렉터리에 상대적이며 spine에 구역만 들어 있었다. 한컴 공식 예제는 OPF 이름공간 끝에 `/`를 사용하고, `Contents/header.xml` 같은 ZIP 루트 경로와 spine의 header 항목을 포함한다. 공식 serializer는 주 패키지 외에 미리보기와 RDF 정보를 container rootfiles에 선언한다.

검사기는 공식 구조와 기존 시험 구조를 모두 구별하여 읽는다. 두 경로 해석이 서로 다른 실제 파일을 가리키면 거부한다. 주 패키지는 하나만 허용하고 구역의 누락·중복, 선언 모순, 외부 주소, 경로 이탈과 CRC 검사는 유지한다. 보조 rootfile은 확인한 로컬 경로·형식만 허용하며 RDF도 XML 안전성 검사를 거친다.

## XML과 오류 안내

XML 속성에 있는 주소를 모두 외부 자원으로 취급하던 조건을 좁혔다. 이름공간 URI로 확인한 XML Schema Instance의 schema hint, OPF metadata 아래 meta의 content, RDF 문서의 Description.about와 type.resource만 실행되지 않는 메타데이터로 읽는다. 스키마와 RDF 주소를 가져오거나 실행하는 기능은 없다. 일반 href·src 같은 외부 참조, DTD·처리 지시문·이벤트 속성·실행 가능 개체는 계속 거부한다.

지원하지 않는 XML은 문자 인코딩, XML 버전, DTD, 처리 지시문, 이름공간, 실행 가능 개체, 이벤트 속성, 외부 자원 참조를 구별해 안내한다. 엔진→Worker→화면은 허용 목록의 식별자와 고정 문구만 전달한다. 문서 원문·URL·파일명·parser 세부 오류를 메시지에 넣지 않는다. 새 파일이 실패했을 때 이전 성공 문서가 남아 있다는 점도 구분해 안내한다.

## 근거와 검증 범위

- [한컴 HWPX 구조 설명](https://tech.hancom.com/hwpxformat/): 실제 패키지·spine 예시.
- [한컴 Python HWPX 분석](https://tech.hancom.com/python-hwpx-parsing-1/): head의 OPF 이름공간과 ZIP 루트 기준 manifest 경로.
- [한컴 serializer](https://github.com/hancom-io/hwpx-owpml-model/blob/1453388472c703a4b299a0834f425cdac16644b9/OWPMLApi/OWPMLSerialize.cpp#L804-L820): 복수 container 선언.
- [OPF meta 문자열 처리](https://github.com/hancom-io/hwpx-owpml-model/blob/1453388472c703a4b299a0834f425cdac16644b9/OWPML/Class/Etc/meta.cpp#L44-L60), [RDF 식별자 문자열 처리](https://github.com/hancom-io/hwpx-owpml-model/blob/1453388472c703a4b299a0834f425cdac16644b9/OWPML/Class/RDF/RDF.cpp#L48-L103): 공식 Apache-2.0 모델의 고정 commit.
- [W3C schemaLocation](https://www.w3.org/TR/xmlschema-1/#xsi_schemaLocation): 스키마 위치를 제안하는 hint이며 이 앱은 스키마 검색·검증을 하지 않는다.

시험 입력은 기존 공개 합성 fixture에서 공식 구조를 반영해 메모리로 조립한다. 실제 학생 자료나 사용자 파일을 저장소·Actions·로그에 넣지 않는다. 원본 반환은 모든 입력 바이트와 비교하고, 브라우저에서는 준비 뒤 오프라인 상태에서 실제 Worker 검사·다운로드와 외부 요청 부재를 확인한다.

최종 로컬 검증: 타입·lint·제약·빌드·dist 검사 통과, 단위 132개·통합 40개·보안 259개·브라우저 19개 통과(총 450개). 중첩 Pages 경로에서 같은 브라우저 19개도 통과했다. 배포 smoke 스크립트는 loopback preview에서 실제로 새 호환성 입력을 검사하고 동일 사본을 다운로드했다. 공개 사이트 결과는 배포 workflow의 후속 smoke job으로 확인한다.

이 수정은 T-02 입력 검사 범위다. 문단·표 서식 검사, 자동 교정, 문서 미리보기와 실제 Windows·한컴 한글 개봉·조판 검수는 제공하거나 완료 처리하지 않는다. 재현 시험의 통과는 사용자가 보고한 파일 자체의 성공 확인을 대신하지 않는다.
