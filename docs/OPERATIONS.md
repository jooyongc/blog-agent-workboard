# Workboard 운영 화면

새 웹 작업실은 https://blog-agent-workboard.pages.dev 입니다. 기존 비밀번호로 로그인하고 왼쪽 사이트 선택 또는 홈의 네 사이트 카드에서 워크스페이스를 바꿉니다. 선택은 새로고침 후에도 유지됩니다.

1. 아이디어 노트에서 사이트별 주제를 저장하거나 새 글 작성으로 시작합니다.
2. 카테고리와 영문 slug를 입력하고 언어별 출처 메모를 준비합니다. Blogger는 EN·JA를 독립 작성합니다.
3. 직접 본문을 쓰거나 AI 초안을 준비한 뒤 Markdown 미리보기로 확인합니다. 임시 저장은 해당 브라우저에만 저장합니다.
4. 내용을 검토한 뒤 자체 사이트는 **초안 저장**, Blogger는 **전달 파일 만들기**를 사용합니다.
5. 사이트 관리자 또는 기존 aside 루틴에서 이미지·SEO·최종 검토와 게시를 완료합니다.

공개 글 현황은 실제 API에서 조회합니다. Blogger 공개 피드는 임시보관·예약 글을 표시하지 않습니다. 실패한 연결은 0건으로 정상 표시하지 않고 경고와 대시로 표시합니다. 웹 AI 비용은 Workboard 리포트에 기록하며 기존 CLI·aside 비용은 아래 기존 운영 도구의 기록을 확인합니다.

[배포 및 환경 변수](CLOUDFLARE-PAGES.md)

---

# 블로그 브릿지 운영 가이드

점검일: 2026-10-05 (Asia/Seoul). 작업 저장소: `/Users/project.adv/@Github/jooyongc/asty-blog-agent`.

## 대상

| 대상 | 언어 | 저장·게시 흐름 |
|---|---|---|
| Korea Buy List | EN + JA | 기존 aside browser 격일 10:00 루틴 → 초안 → 승인 후 게시 |
| Korea by Local | EN | `koreabylocal.blog_posts` 초안 → 기존 사이트 관리자에서 게시 |
| Korea Decode | EN | `public.posts` 초안 → 기존 사이트 관리자에서 게시 |

네이버는 제외했다. ASTY의 기존 EN/JA/ZH 파이프라인은 별도로 유지된다. 새 대상은 ASTY 전용 글 템플릿이나 API로 발행하지 않는다.

## 시작

```bash
cd /Users/project.adv/@Github/jooyongc/asty-blog-agent
nvm use
npm ci
npm run typecheck
npm test
npm run doctor -- --site koreabylocal --live
npm run doctor -- --site koreadecode --live
```

Node 22.12+가 필요하다. 루트 `.env`에는 기존 서버용 인증파일의 **경로**만 지정한다. 키를 새로 복사하지 않는다:

```dotenv
BRIDGE_CREDENTIALS_FILE=/Users/project.adv/@Github/jooyongc/koreabylocal/.env.local
BRIDGE_SUPABASE_URL=https://agkkvtfwqmzgbrqhvohs.supabase.co
```

해당 파일의 `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`를 서버 스크립트에서만 읽는다. 브라우저·Blogger bundle에 키를 포함하지 않는다.

## 기존 완성 글을 가져오기

입력 JSON은 `examples/bridge-source.json` 형식을 따른다. `category`는 대상 config의 값 중 하나다. Blogger는 EN/JA 둘 다 필요하며 JA는 `authoring_mode: independent`가 필수다. 두 자체 사이트는 EN만 사용한다. HTML을 가져오려면 `content_md` 대신 `content_html`을 쓴다.

```bash
npm run bridge-import -- --site korea-buy-list --input /absolute/path/pair.json
npm run bridge -- sample-korea-guide --site korea-buy-list
```

Blogger 전송 bundle은 `outbox/korea-buy-list/<slug>/bundle.json`, `en.html`, `ja.html`이다. 기존 aside 루틴과 연결할 절차는 `docs/ASIDE-BRIDGE-HANDOFF.md`를 따른다. 샘플은 발행용이 아니며 기존 RUNBOOK의 이미지·FAQ·고지 조건을 별도로 채워야 한다.

## 연구 자료로 새 글 작성

`examples/research.json` 형식으로 실제 확인한 자료를 준비한다. 각 언어마다 `brief`, `sources`가 필요하며 각 source에는 `url`, `checked_at`을 적는다. Korea Buy List의 일본어는 독립 자료를 사용한다. 글 생성기는 외부 웹을 읽지 않으므로 제공한 자료만으로 초안을 작성하고 인간 검토를 기다린다.

```bash
npm run compose -- --site koreabylocal --slug my-guide --topic 'My researched topic' --category NEWS --research /absolute/path/research.json
npm run bridge -- my-guide --site koreabylocal
```

## 자체 사이트에 저장

글과 출처·이미지·링크를 확인한 후 현재 버전에 승인 기록을 남긴다. 승인 뒤 본문이나 metadata가 바뀌면 다시 검토해야 한다.

```bash
npm run approve-draft -- my-guide --site koreabylocal --reviewed
npm run bridge -- my-guide --site koreabylocal --send
```

`--send`는 초안 저장이다. 기존 사이트 관리자에서 초안을 확인한 후 게시한다. Korea Decode도 `--site koreadecode`로 같은 흐름을 쓴다. 기존 slug가 있으면 덮어쓰지 않는다.

Blogger는 기존 aside 루틴을 사용한다. OAuth 설정이 준비된 경우에만 `--send --api-mode`로 수동 API 임시보관을 할 수 있다. API는 **항상 isDraft=true**로 보내며 기존 격일 일정은 새로 만들지 않는다. 필요한 scope는 `https://www.googleapis.com/auth/blogger`이다.

## 실패 복구

- `*.attempt.json`만 있고 receipt가 없으면 서버가 저장했지만 응답이 유실됐을 수 있다. 관리자에서 해당 글이 있는지 먼저 확인한다. 파일을 지워 재전송부터 하지 않는다.
- receipt가 있으면 같은 버전 재실행은 중복 저장하지 않는다. 전송 후 내용을 바꾸려면 기존 관리자에서 수정한다.
- `verification.json` 누락·차단·모순은 공개 발행을 막는다. 모델 자체 평가를 외부 사실검증으로 인정하지 않는다.
- 잠금파일 `content/.llm-budget.json.lock`이 남으면 다른 실행 중인지 확인한 뒤 복구한다. 예산 파일과 초안을 삭제해 한도를 우회하지 않는다.
- DeepL이 실패했을 때 유료 LLM 번역으로 자동 전환하지 않는다. 필요하면 `ALLOW_LLM_TRANSLATION_FALLBACK=true`를 명시한다.

## 기존 ASTY 자동화

GitHub schedule은 `BLOG_PIPELINE_ENABLED=true`일 때만 유료 초안 생성이 활성화된다. 수동 실행 기본값은 읽기 전용 dry-run이다. 자동 작업은 공개 발행하지 않는다. CI는 초안·DeepL 사용량·LLM 예산 기록을 캐시에 유지한다. 캐시 손실·별도 컴퓨터·aside 자체 비용은 이 로컬 원장에 합산되지 않으므로 Anthropic 계정의 실제 사용량도 확인해야 한다.

초안 완료 후 검토·승인하고 `npm run publish -- <slug>`로 ASTY 예약 발행한다. 예약 시간은 최소 2시간 이후여야 한다. 이 명령은 새로운 bridge 대상에는 사용하지 않는다.

## 검증 범위

코드 회귀 테스트, 루트/대시보드 타입 검사, 대시보드 프로덕션 빌드, 두 자체 사이트 HTTP/인증 REST 조회, Anthropic 모델 목록 인증 조회와 실제 Haiku 진단 초안 생성·브릿지 변환을 검증했다. 두 native payload는 실제 DB 트랜잭션에서 삽입 후 rollback해 확인했다. 실제 공개 글 발행이나 Blogger 로그인/OAuth 쓰기 테스트는 실행하지 않았다. aside RUNBOOK 파일 연결은 반영했으며 다음 격일 실행에서의 실제 적용은 아직 관찰 전이다. 현재 관리자 권한 정책 상태는 `docs/AUDIT-2026-10-05.md`를 참조한다.
