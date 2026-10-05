# Korea Buy List — aside browser 브릿지

기존 격일 10:00 Asia/Seoul 루틴 `cisZ0evksgQuTweq`가 발행 일정의 단일 소유자다. 새 cron을 추가하지 않는다. 현재 루틴은 초안 작성 후 게시 승인을 기다린다. 루틴 DB를 직접 수정하지 않는다.

기존 RUNBOOK: `/Users/project.adv/1000project/korea-buy-list/RUNBOOK.md`.

에이전트 저장소: `/Users/project.adv/@Github/jooyongc/asty-blog-agent`.

1. 기존 루틴이 선정한 주제로 EN/JA를 각각 독립 리서치한다. 기존 RUNBOOK의 이미지 4장, 제휴 고지, FAQ, JSON-LD 조건을 유지한다.
2. `npm run bridge-import -- --site korea-buy-list --input /absolute/path/pair.json`로 완성 글을 가져온다. 입력 계약은 `examples/bridge-source.json` 참조. JSON에 기존 완성 HTML을 그대로 `content_html`에 넣을 수 있다. 일본어에는 `authoring_mode: independent`가 필수다.
3. `npm run bridge -- <slug> --site korea-buy-list`로 `outbox/korea-buy-list/<slug>/bundle.json`, `en.html`, `ja.html`을 만든다.
4. aside browser에서 정확한 blogId `2501831991285091849`를 확인하고 초안을 저장한다. EN은 `English`, JA는 `日本語` 라벨을 넣는다. 기존 게시물을 덮어쓰거나 다른 반복 루틴을 만들지 않는다.
5. 저장 후 편집기를 다시 열어 서버에 본문·이미지4장·라벨·JSON-LD가 남았는지 확인한다. 에디터 로컬 값만으로 저장 성공을 판단하지 않는다.
6. 게시 승인을 받은 뒤 실제 URL을 확인한다. 맞춤 URL이 리셋되는 기존 현상이 있으므로 예상 URL로 언어 링크·JSON-LD를 확정하지 않는다. 실제 URL로 EN/JA 언어 링크와 hreflang을 맞춘다.

현재 루틴 프롬프트는 이전 루틴 메모리 경로를 참조한다. RUNBOOK 연결 섹션은 현행 메모리 `/Users/project.adv/.aside/u/0/memory/routines/korea-buy-list-cisz0evksgqutweq/MEMORY.md`를 우선하도록 명시한다. 2026-10-05에 기존 RUNBOOK 상단에 브릿지 전달 절차를 추가하고 읽기 재검증까지 완료했다. 루틴은 이 파일을 매 실행 때 읽으므로 파일 경로를 통해 연결된다. aside 내부 DB와 격일 일정은 직접 변경하지 않았다.

수동 API 전송은 `--send --api-mode`로만 가능하며 **항상 Blogger 임시보관**으로 저장한다. 공개 게시와 격일 일정은 기존 aside 루틴이 담당한다.
