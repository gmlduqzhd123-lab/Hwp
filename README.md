# 한글 마감실 · 문서 구조 검사판

버전: PRD v2.0 / 2026-09-29

React·TypeScript·Vite로 구현한 T-00~T-03 검사판입니다. HWPX의 파일 형식·ZIP·XML·자원 제한을 확인하고 선언 순서에 따라 문단·표의 내용과 서식 참조를 읽습니다. 검사한 입력은 **원본 바이트 그대로** 내려받습니다. 서식 교정·조판·한글 화면 검증 기능은 아직 제공하지 않습니다.

- `AGENTS.md`: 저장소 루트에 둘 Codex 개발 규칙
- `docs/PRD.md`: 전체 제품·개발 명세
- `docs/TASKS.md`: T-00~T-15 작업 순서
- `docs/ACCEPTANCE.md`: AC-01~AC-36 시험과 출시 게이트
- `docs/CODEX_START.md`: 첫 작업 요청문
- `docs/DEPENDENCIES.md`: 후보 시험과 라이브러리 선정 근거
- `docs/SUPPORTED_FEATURES.md`: 현재 지원·미지원 범위
- `docs/IMPLEMENTATION_STATUS.md`: 검증 결과와 남은 단계
- `docs/QA_FIXES.md`: 실제 앱 점검에서 재현한 오류와 회귀 수정
- `docs/DOCUMENT_INSPECTION.md`: 문단·표·서식 읽기와 원본 위치 연결의 범위
- `docs/HWPX_COMPATIBILITY.md`: 한컴 패키지 입력 호환성과 XML 오류 안내 수정
- `docs/DEPLOYMENT.md`: GitHub Pages 검증·배포·롤백 안내

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

공개 주소: [한글 마감실](https://gmlduqzhd123-lab.github.io/Hwp/). 현재 문서 구조 검사판을 배포하며 자동 교정 정식 출시나 실제 한컴 한글 검수 완료를 의미하지 않습니다.

`.github/workflows/pages.yml`은 PR에서 검증만 하고, 검증에 성공한 현재 `main`의 `dist/`를 GitHub Pages에 배포합니다. 배포 후 실제 사이트에서 빌드 commit, Worker, 예시 검사, 원본 다운로드와 오프라인 재시작을 확인합니다. 화면 아래 ‘빌드’에 commit 7자리를 표시합니다. Pages Source는 GitHub Actions를 사용하며 실행·권한·확인·롤백 절차는 `docs/DEPLOYMENT.md`에 있습니다.
