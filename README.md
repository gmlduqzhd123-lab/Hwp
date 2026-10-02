# 한글 마감실 · 보고서·논문 작성 초안

버전: PRD v2.0 / 2026-09-29

React·TypeScript·Vite로 구현한 검사·작성 초안 시험판입니다. HWPX를 검사하고 대회·연도·분과·작성 단계·문서 종류에 맞춰 줄글 문단의 배치를 추천합니다. 검토한 내용으로 별도 HWPX 초안을 생성·재검사해 내려받습니다. 업로드 원본의 사본은 **원본 바이트 그대로** 유지합니다. 원문에 없는 연구 결과를 작성하지 않으며, 실제 Windows 한컴 한글 조판·최종 제출 적합성 검증은 **NOT_RUN**입니다.

- `AGENTS.md`: 저장소 루트에 둘 Codex 개발 규칙
- `docs/PRD.md`: 전체 제품·개발 명세
- `docs/TASKS.md`: T-00~T-15 작업 순서
- `docs/ACCEPTANCE.md`: AC-01~AC-36 시험과 출시 게이트
- `docs/CODEX_START.md`: 첫 작업 요청문
- `docs/DEPENDENCIES.md`: 후보 시험과 라이브러리 선정 근거
- `docs/SUPPORTED_FEATURES.md`: 현재 지원·미지원 범위
- `docs/IMPLEMENTATION_STATUS.md`: 검증 결과와 남은 단계
- `docs/QA_FIXES.md`: 실제 앱 점검에서 재현한 오류와 회귀 수정
- `docs/COMPETITION_CATALOG.md`: 대회별 공식 출처·작성 기준·제출물·지원 정책
- `docs/RESEARCH_DRAFT.md`: 작성 흐름·원문 보존·수업혁신 전국 기준의 상세 근거
- `docs/DOCUMENT_INSPECTION.md`: 문단·표·서식 읽기와 원본 위치 연결의 범위
- `docs/HWPX_COMPATIBILITY.md`: 한컴 패키지 입력 호환성과 XML 오류 안내 수정
- `docs/DEPLOYMENT.md`: GitHub Pages 검증·배포·롤백 안내

## 보고서·논문 초안 만들기

파일을 올리기 전에도 ‘대회별 작성 기준 찾아보기’에서 학교급·연도·옛 이름으로 공식 자료와 준비물을 비교할 수 있습니다.

1. HWPX를 선택합니다. HWP는 한글에서 **다른 이름으로 저장 → HWPX**로 저장한 뒤 선택합니다.
2. 작업 화면에서 ‘학교급 선택’ → ‘대회 검색/대회 선택’ → ‘기준 연도’ → ‘문서·분과 선택’ → ‘작성 단계’를 정합니다. 출처의 전국·지역·전년도 범위와 지원 정책을 확인하고 제목을 입력합니다.
3. 문단의 추천 역할을 검토합니다. ‘질문을 보고 직접 내용 보완하기’에 실제 연구 내용을 직접 입력하고 ‘이 내용을 초안에 포함’에 동의한 항목만 추가합니다. 요약서는 원문 문단을 고르고 ‘선택한 원문만 요약 초안에 포함하는 것을 확인했습니다.’를 선택합니다.
4. 검토한 설정으로 초안을 생성·재검사해 내려받습니다. ‘준비물과 제출 전 확인’을 참고하고 실제 한글에서 쪽수·글꼴·표지·기명/익명 조건·연구 근거·최종 확장자를 확인합니다.

‘개인 참고 기준 설정’과 논문 구성은 공식 대회 양식이 아닙니다. 기준·단계·학교급을 바꾸면 이전 출력과 보충 내용의 포함 승인을 해제하므로 남아 있는 입력도 다시 읽고 포함 여부를 선택합니다. 준비 목록의 체크는 파일 내용을 바꾸지 않습니다.

대회군 10개의 2026 공식 자료와 2025 전국교원 발명연구대회 참고 자료를 구분합니다. 보고서·설명서 작성 지원과 교육자료 실물·SW 소스·영상·발표 준비는 별개입니다. 인성교육은 전국 전체 서식 미확인 참고 기준이며, 인성·EBS 전국 단계는 예선 원고·작품 변경 금지에 따라 새 초안을 잠급니다. EBS 제출 전 설명서는 원문 순서와 문장을 유지해 서식만 적용합니다. 대회별 차이와 원문 링크는 [대회 목록](docs/COMPETITION_CATALOG.md)에 있습니다.

서식의 공식 명시값, 생략 단위를 해석한 값, 앱 기본값을 구분합니다. 현재 템플릿은 줄글 중심이며 표·사진을 포함한 공식 표지의 정확한 외형은 미검증입니다. 한국교총 현장교육·교육자료전의 공식 전자 제출 형식은 **hwp 또는 PDF**이고, EBS 작품설명서는 **PDF**입니다. 앱의 HWPX는 준비용 초안으로 실제 한글에서 최종 저장·검수해야 합니다.

초안 생성은 2,000문단·200만 문자 이내의 순수 본문을 지원합니다. 표·그림·각주·필드·의미가 불명확한 개체가 있으면 생성을 중단하고 원본을 유지합니다. 보고서는 모든 원문 문단을 옮기고, 요약서는 사용자가 제외 내용을 확인한 선택 문단만 그대로 옮기며 포함·제외 수를 표시합니다. 교사가 입력한 보충 내용은 별도 집계합니다. 준비 목록은 제출 완료·연구 진위·익명성 인증이 아닙니다. 외부 AI·서버·지속 저장소 없이 브라우저 메모리에서 처리합니다.

## 실행

Node.js **24.19.0**, npm **11.9.0**을 사용합니다. `.nvmrc`·`package.json`으로 버전을 고정하고 `package-lock.json`으로 의존성을 고정합니다.

```bash
npm ci
npm run dev
```

개발 서버는 기본적으로 loopback에서 실행합니다. `npm run build`는 `/Hwp/` 프로젝트 경로로 정적 `dist/`를 생성하고 `npm run preview`로 HTTP에서 검토할 수 있습니다. 해시 화면은 `#/start`, `#/workspace`, `#/help`입니다.

다른 프로젝트 경로에는 영문·숫자·밑줄·하이픈을 사용하고 끝에 `/`를 붙입니다. 빌드·미리보기·시험에 같은 경로를 설정합니다. 브라우저 시험은 자체 미리보기 서버를 시작하므로 수동 미리보기를 종료한 뒤 실행합니다.

```bash
PAGES_BASE_PATH=/custom/hwp/ npm run build
PAGES_BASE_PATH=/custom/hwp/ npm run preview
# 수동 미리보기를 종료한 뒤
PAGES_BASE_PATH=/custom/hwp/ npm run test:e2e
```

화면의 ‘로컬 검사 준비 완료’ 뒤에 파일을 선택합니다. 현재 문서를 다른 파일로 교체하면 저장 여부를 확인하고, 새 파일 검사에 실패하거나 취소하면 기존 원본을 유지합니다. 준비가 20초 안에 끝나지 않으면 오류와 ‘준비 다시 시도’를 표시합니다. 운영 빌드는 준비 후 오프라인 검사·다운로드·취소·작업 종료 후 새 검사를 지원합니다. Vite 개발 모드의 모듈 로딩·HMR과 오프라인 새로고침은 이 보장에 포함되지 않습니다.

```bash
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

`test:pages-path`는 임의 중첩 경로를 검증한 뒤 성공·실패 모두 기존 `dist/`를 복원합니다. 기존 빌드가 없으면 시험 뒤 기본 빌드를 생성합니다.

브라우저 시험은 시스템 `/usr/bin/chromium`이 있으면 사용합니다. 다른 기기에서는 `npx playwright install chromium`을 실행하거나 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`로 설치된 Chromium 경로를 지정합니다. 이 클라우드에서는 다운로드 도메인이 차단되어 기존 시스템 Chromium을 사용했습니다.

합성 시험 입력 5종은 `tests/fixtures/`에 있습니다. `npm run fixtures`로 결정적으로 재생성할 수 있습니다. 실제 한컴 한글에서 생성·조판 확인한 문서가 아니며, 합성 구조 시험의 통과를 실제 한글 검수 완료로 취급하지 않습니다. 위험 파일은 시험 중 메모리에서 만들며 공개 예시에는 포함하지 않습니다.

Codex로 개발하고 GitHub Pages에만 배포합니다. Vercel·Supabase·별도 서버·DB·AI API는 사용하지 않습니다. GitHub Actions는 시험·정적 빌드·배포용입니다. 실제 학생 문서와 민감 자료를 저장소나 Codex 작업 입력에 넣지 않습니다.

원래의 PRD·작업표·인수 명세는 루트에 보존했고 `docs/`의 같은 이름은 원본을 가리키는 링크입니다. 현재 구현의 진행 상태는 `docs/IMPLEMENTATION_STATUS.md`를 확인합니다.

## GitHub Pages

공개 주소: [한글 마감실](https://gmlduqzhd123-lab.github.io/Hwp/). 현재 검사·작성 초안 시험판을 배포하며 자동 교정 정식 출시나 실제 한컴 한글 검수 완료를 의미하지 않습니다.

`.github/workflows/pages.yml`은 PR에서 검증만 하고, 검증에 성공한 현재 `main`의 `dist/`를 GitHub Pages에 배포합니다. 배포 후 실제 사이트에서 빌드 commit, Worker, 예시 검사, 원본 다운로드와 오프라인 재시작을 확인합니다. 화면 아래 ‘빌드’에 commit 7자리를 표시합니다. Pages Source는 GitHub Actions를 사용하며 실행·권한·확인·롤백 절차는 `docs/DEPLOYMENT.md`에 있습니다.
