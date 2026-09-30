# 한글 마감실 · Codex 인계용 명세 묶음

버전: PRD v2.0 / 2026-09-29

이 묶음은 **개발 명세**입니다. 실행 가능한 웹앱 소스, 완료된 시험 결과 또는 배포 산출물이 아닙니다.

- `AGENTS.md`: 저장소 루트에 둘 Codex 개발 규칙
- `docs/PRD.md`: 전체 제품·개발 명세
- `docs/TASKS.md`: T-00~T-15 작업 순서
- `docs/ACCEPTANCE.md`: AC-01~AC-36 시험과 출시 게이트
- `docs/CODEX_START.md`: 첫 작업 요청문

## 적용 방법

사용할 GitHub 저장소에 파일을 배치합니다. 기존 AGENTS.md와 같은 이름의 문서가 있으면 기존 지시·자료를 덮어쓰지 말고 검토 후 병합합니다. Codex에서 `docs/CODEX_START.md`의 요청으로 T-00~T-02부터 시작합니다.

Codex로 개발하고 GitHub Pages에만 배포합니다. Vercel·Supabase·별도 서버·DB·AI API는 사용하지 않습니다. GitHub Actions는 시험·정적 빌드·배포용입니다. 실제 학생 문서와 민감 자료를 저장소나 Codex 작업 입력에 넣지 않습니다.

PRD의 npm 명령은 이후 구현해야 할 스크립트 계약입니다. 이 명세 파일들만으로 npm 설치·빌드를 실행할 수 있는 상태는 아닙니다. 실제 저장소 생성·수정·배포는 이번 문서 작성 작업에서 수행하지 않았습니다.
