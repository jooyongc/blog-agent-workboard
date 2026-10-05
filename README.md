# Blog Agent Workboard

네 개 블로그의 아이디어·작성·검토·운영 현황을 관리하는 작업실입니다. 웹 앱을 React + Vite + Cloudflare Pages Functions로 다시 구성했습니다.

- 운영 주소: https://blog-agent-workboard.pages.dev
- 저장소: https://github.com/jooyongc/blog-agent-workboard
- 웹 앱: `workboard/` · API 진입점: `functions/api/[[path]].ts` · 운영 기록: Cloudflare D1

| 워크스페이스 | 언어 | 전달·게시 방식 |
|---|---|---|
| Korea Buy List / Blogger | 영어 + 일본어 | 독립 작성한 두 글을 전달 파일로 내보내기 → 기존 aside 격일 루틴에서 이미지·SEO 완성 및 승인 |
| Korea by Local | 영어 | 해당 사이트 DB에 초안 저장 → 기존 관리자에서 게시 |
| Korea Decode | 영어 | 해당 사이트 DB에 초안 저장 → 기존 관리자에서 게시 |
| ASTY Cabin | 영어·일본어·중국어 | 기존 로컬 브릿지 및 GitHub 파이프라인 유지 |

워크스페이스 목록과 선택 상태는 하나의 정적 카탈로그를 사용합니다. 콘텐츠 검색·상태 필터, 사이트별 작성기, Markdown 미리보기, 브라우저 임시 저장, 아이디어 노트, AI 사용량 리포트, 연결 상태를 제공합니다. Blogger의 비공개 초안·예약 수는 공개 피드로 확인할 수 없어 관리자에서 확인합니다.

## 개발·검증

Node 22.12 이상이 필요합니다.

```bash
npm ci
npm ci --prefix workboard
npm run typecheck
npm test
npm run workboard:test
npm run validate-configs
npm run build
cp .dev.vars.example .dev.vars
# 로컬용 비밀 값을 입력합니다. VITE_ 변수에 서버 비밀 키를 넣지 않습니다.
npx --prefix workboard wrangler d1 migrations apply blog-agent-workboard --local
npm run pages:dev
```

전체 앱은 http://localhost:8790 에서 실행합니다. `npm run dev:web`은 UI만 개발하는 Vite 서버입니다.

## 배포·운영

[Cloudflare 배포 가이드](docs/CLOUDFLARE-PAGES.md) · [작성 및 브릿지 운영](docs/OPERATIONS.md) · [aside 연결](docs/ASIDE-BRIDGE-HANDOFF.md) · [복구 점검](docs/AUDIT-2026-10-05.md)

Cloudflare Pages가 `main` 변경을 자동으로 빌드합니다. 저장소 루트에서 `npm ci && npm ci --prefix workboard && npm run build`를 실행하고 `workboard/dist`를 배포합니다. 서버는 Web API와 D1만 사용하므로 실행 시 Node 파일 시스템이나 Next.js 서버가 필요하지 않습니다. 로컬 CLI 브릿지는 별도 Node 도구로 유지됩니다.

웹 AI 예산은 글 $0.50 / 주 $2 / 월 $10을 D1 트랜잭션으로 제한합니다. 로컬 CLI와 aside의 지출은 별도 기록이므로 계정 전체 상한은 Anthropic 계정에서 관리해야 합니다. 자체 사이트에는 초안만 저장하며 공개 게시는 기존 관리자·승인 흐름에서 진행합니다.

`dashboard/`는 이전 Next.js/Vercel 화면의 복구 참고 자료입니다. 새 Pages 빌드에는 포함하지 않습니다. 기존 설계는 [ASTY 기록](docs/LEGACY-ASTY-README.md)에 보존했습니다. 로컬 폴더 이름은 기존 aside 경로를 유지하기 위해 `asty-blog-agent`를 사용하며 제품·저장소·배포 이름은 `blog-agent-workboard`입니다.
