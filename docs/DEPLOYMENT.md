# GitHub Pages 검증·배포 계약

운영 주소는 `https://gmlduqzhd123-lab.github.io/Hwp/`이고 프로젝트 경로는 `/Hwp/`다. 배포 대상은 입력 사전 검사와 원본 바이트 그대로 내보내기를 제공하는 현재 검증판이다. 정식 자동 교정 출시나 실제 한컴 한글 검수 완료를 의미하지 않는다.

[pages.yml](../.github/workflows/pages.yml)은 `main` push, PR, 수동 실행을 처리한다. PR과 다른 branch의 수동 실행은 검증만 수행한다. 운영 배포와 Pages artifact 업로드는 성공한 `main`의 실행에만 허용한다.

## 검증과 공개 산출물

검증 job은 `.nvmrc`의 Node와 npm `11.9.0`을 사용하고 `npm ci`로 lockfile을 설치한다. Playwright에 고정된 Chromium을 설치하고 해당 executable을 명시하여 runner의 다른 브라우저를 자동 선택하지 않는다.

검증 순서는 다음과 같다. 실패는 후속 단계와 배포를 중단하며 `continue-on-error`로 숨기지 않는다.

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

빌드에는 `PAGES_BASE_PATH=/Hwp/`와 실행 commit의 `VITE_APP_COMMIT`을 전달한다. 중첩 경로 시험은 끝날 때 원래 `dist`를 복원한다. 공식 `upload-pages-artifact`는 검증한 `dist/` 전체만 등록하고 원본 소스, 시험 입력, 로그, trace, 환경 파일이나 dependency 폴더를 공개하지 않는다. 현재 합성 예시는 앱 번들에 포함하며 별도 HWPX 파일을 공개하지 않는다.

## 권한과 오래된 배포 차단

기본·검증·공개 주소 smoke job의 권한은 `contents: read`다. deploy job만 `pages: write`, `id-token: write`를 추가하며 공식 `github-pages` environment를 사용한다. 앱에는 이 토큰이나 인증 정보가 포함되지 않는다. `pull_request_target`은 사용하지 않는다.

deploy job의 동시성 그룹은 `pages-production`이고 실행 중 배포를 취소하지 않는다. 실제 배포 직전에 GitHub API로 `main`의 현재 SHA를 읽어 검증한 SHA와 비교한다. `main`이 진행됐으면 해당 artifact의 배포를 거부한다. `configure-pages`가 반환한 경로도 빌드 경로와 비교하여 다른 base의 산출물을 배포하지 않는다.

`deploy-pages`는 같은 workflow 실행의 `github-pages` artifact만 배포한다. 이후 읽기 권한만 가진 별도 smoke job이 action의 실제 `page_url`과 예상 commit을 받아 `npm run test:deployed`를 실행한다. 공개 주소의 앱 진입·표시 commit·Worker·합성 예시 검사·다운로드를 확인한 결과로 배포 동작을 판단한다. deploy action만 성공하고 smoke가 실패하면 전체 검증·배포 완료로 기록하지 않는다.

## Pages Source와 수동 실행

GitHub 저장소 Settings → Pages → Build and deployment → Source를 **GitHub Actions**로 설정한다. 기존 운영 Pages의 branch 방식에서 전환할 때도 같은 저장소·주소를 사용하며 저장소 공개 여부를 변경하지 않는다. environment 보호 규칙이 있으면 GitHub의 승인·branch 규칙이 적용된다.

이 저장소의 Pages 사이트는 이미 존재하므로 workflow는 `configure-pages`의 `enablement: false`를 사용한다. 공식 action의 자동 생성 옵션 `enablement: true`는 `GITHUB_TOKEN` 이외의 인증과 추가 권한을 요구한다. workflow는 새 token을 요구하거나 Pages 사이트 자동 생성을 우회하지 않는다.

수동으로 현재 `main`을 검증·배포하려면 다음 명령을 사용한다. 다른 ref의 수동 실행은 배포하지 않는다.

```bash
gh workflow run pages.yml --ref main
gh run list --workflow pages.yml --limit 5
gh run watch <run-id> --exit-status
```

로컬에서 실제 배포를 다시 확인할 수 있다.

```bash
PAGES_URL='https://gmlduqzhd123-lab.github.io/Hwp/' EXPECTED_COMMIT="$(git rev-parse HEAD)" npm run test:deployed
```

이는 현재 checkout의 commit을 검사하는 명령이므로, 실제 배포한 commit을 검증할 때는 `EXPECTED_COMMIT`에 그 전체 SHA를 사용한다. 실제 Pages에 연결하지 못했거나 검사가 실행되지 않았으면 공개 주소 smoke는 미실행으로 보고한다.

## Action 고정과 갱신

다음 버전·전체 commit SHA는 2026-10-02 공식 저장소의 `git ls-remote --tags`와 해당 SHA의 `action.yml`을 직접 조회해 존재·입력·Node runtime을 확인했다.

| 공식 Action | 확인한 버전 | 고정 SHA |
| --- | --- | --- |
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/configure-pages` | v6.0.0 | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` |
| `actions/upload-pages-artifact` | v5.0.0 | `fc324d3547104276b827a68afc52ff2a11cc49c9` |
| `actions/deploy-pages` | v5.0.1 | `368f82528645a54fb793d4d04e342629a3f51346` |

각 JavaScript action은 Node 24 runtime을 사용한다. `upload-pages-artifact`는 공식 composite action이며 내부 `upload-artifact` v7.0.0도 전체 SHA `bbbca2ddaa5d8feaa63e36b76fdaad77386f024f`에 고정되어 있음을 확인했다. 갱신 PR에서는 공식 tag가 가리키는 commit, action 입력·권한·runner 호환성을 다시 확인하고 기존 앱·경로·공개 주소 검사를 수행한다.

workflow의 문법·job·expression·shell 검사는 actionlint v1.7.12로 실행했다. 검사 도구는 공식 release의 SHA-256 checksum을 확인한 뒤 사용했다. 이 로컬 검사 통과는 실제 GitHub Actions 실행·Pages 공개 주소 검증 결과와 구분한다.

공식 근거:

- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [configure-pages 입력과 자동 생성 권한](https://github.com/actions/configure-pages/blob/45bfe0192ca1faeb007ade9deae92b16b8254a0d/action.yml)
- [deploy-pages artifact·권한·OIDC 계약](https://github.com/actions/deploy-pages/blob/368f82528645a54fb793d4d04e342629a3f51346/README.md)
- [upload-pages-artifact 형식과 내부 고정 action](https://github.com/actions/upload-pages-artifact/blob/fc324d3547104276b827a68afc52ff2a11cc49c9/action.yml)

## 롤백과 지원 범위

문제가 생기면 원격 Git 이력을 강제로 지우지 않고 해당 변경을 되돌리는 PR을 만든다. 되돌린 변경을 검증한 뒤 `main`에 반영하면 새 commit으로 동일 workflow가 실행된다. 같은 공개 주소에서 새 commit과 실제 다운로드를 재확인한다. 과거의 artifact를 현재 `main`인 것처럼 재배포하지 않는다.

실제 Windows·한컴 한글 개봉·조판·캐시 시험과 모바일 실기기 검증은 이 workflow로 대체하지 않는다. 운영 앱은 정적 파일만 배포하며 서버·DB·외부 AI API·로그인·문서 업로드 서비스를 추가하지 않는다.
