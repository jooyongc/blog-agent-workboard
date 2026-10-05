# Cloudflare Pages 운영

제품 이름은 **blog-agent-workboard**입니다. `wordboard`는 오타였으며 운영 이름으로 사용하지 않습니다.

## 구성

- Pages 프로젝트: `blog-agent-workboard`, 운영 브랜치 `main`
- 사이트: https://blog-agent-workboard.pages.dev
- D1: `blog-agent-workboard`, 바인딩 `WORKBOARD_DB`
- DB ID: `9c2cbd5f-fd44-46a8-9ceb-f007ca2a1759`
- 빌드 루트: 저장소 루트, 출력: `workboard/dist`
- 빌드 명령: `npm ci && npm ci --prefix workboard && npm run build`
- Node 버전: 22.12 이상
- `/api/*`만 Pages Functions에서 처리, 나머지는 정적 SPA 라우팅
- Git 미리보기 배포는 비활성화. 운영 비밀 키를 PR에 전달하지 않음

브라우저는 동일 출처 API만 호출합니다. Supabase 서비스 키·Anthropic 키·GitHub 토큰은 서버 환경에만 저장됩니다. 로그인은 기존 대시보드 비밀번호를 사용하며 서명된 HttpOnly 세션을 발급합니다. 세션 비밀 값은 32자 이상이어야 합니다.

## 서버 환경 변수

| 값 | 용도 |
|---|---|
| `DASHBOARD_PASSWORD` | 운영자 로그인, 기존 비밀번호 유지 |
| `DASHBOARD_SESSION_SECRET` | 세션 서명, 32자 이상 |
| `NATIVE_BLOG_SUPABASE_KEY` | 자체 사이트 서버용 서비스 키 |
| `ANTHROPIC_API_KEY` | AI 초안 작성 |
| `ASTY_AGENT_API_KEY` | 기존 ASTY 글 목록 |
| `GITHUB_TOKEN` | 기존 GitHub 실행 상태·수동 실행 |
| `NATIVE_BLOG_SUPABASE_URL` | 기존 공유 DB URL |
| `ASTY_SITE_URL` | 기존 ASTY API 주소 |
| `GITHUB_REPO` | `jooyongc/blog-agent-workboard` |
| `AI_ENABLED` | `true`일 때만 AI 작성 허용 |

비밀 값은 Cloudflare Pages 설정 또는 `wrangler pages secret put <이름> --project-name blog-agent-workboard`로 등록합니다. `VITE_` 접두사로 등록하면 클라이언트 번들에 노출되므로 사용하지 않습니다. 로컬은 루트 `.dev.vars`를 사용합니다. `.env`는 로컬 브릿지용이며 Pages가 파일 경로의 값을 읽지 않습니다.

## 배포 절차

```bash
npm ci
npm ci --prefix workboard
npm run typecheck
npm test
npm run workboard:test
npm run validate-configs
npm run build
npx --prefix workboard wrangler d1 migrations apply blog-agent-workboard --remote
# Git main 푸시 시 Pages가 자동 배포합니다.
# 필요할 때만 동일 산출물을 수동 배포:
npm run pages:deploy
```

`wrangler.toml`은 출력·바인딩 설정을 관리합니다. DB 마이그레이션은 빌드 중 실행하지 않습니다. 새 마이그레이션은 운영 배포 전에 별도로 적용합니다. 빌드 실패 시 기존 정상 배포가 유지됩니다. Pages 대시보드에서 이전 정상 배포로 롤백할 수 있습니다.

배포 후 `/api/health` 200, 비로그인 `/api/workspaces` 401을 확인합니다. 로그인 후 네 사이트의 목록·선택 유지, 연결 설정, EN/JA 작성 탭, Markdown 미리보기, 모바일 메뉴를 확인합니다. 자체 사이트 초안 저장은 운영 글을 공개하지 않습니다. 중복 전송은 D1 영수증과 대상 slug 검사로 막습니다. 결과가 불명확한 저장 실패는 관리자에서 확인한 뒤 새 전송을 진행합니다.

## 운영 범위

Blogger 직접 발행 API와 새 격일 cron은 추가하지 않았습니다. 기존 aside 루틴이 일정과 최종 검토를 담당합니다. Workboard에서 전달 JSON을 내려받은 뒤 다음 명령으로 기존 로컬 브릿지에 가져옵니다.

```bash
npm run bridge-import -- --site=korea-buy-list --input=/absolute/path/korea-buy-list-your-slug.json
```

기존 `RUNBOOK.md`의 이미지·FAQ·언어 링크·승인 규칙을 마무리해야 발행할 수 있습니다. 웹 AI는 사용자가 제공한 출처 메모로 초안을 작성하므로 실제 출처 검토를 대신하지 않습니다.

Korea Decode의 DB 권한은 사용자의 요청에 따라 기존 정책을 유지했습니다. Workboard 접근은 비밀번호로 제한되지만 대상 사이트의 기존 권한 정책을 변경하지 않았습니다. 이전 Vercel 프로젝트는 복구용으로 보존하며 새 운영 주소는 Pages입니다.
