# Workboard Cloudflare 이관 점검 — 2026-10-05

운영 주소: https://blog-agent-workboard.pages.dev
저장소: https://github.com/jooyongc/blog-agent-workboard

## 변경

- 제품·GitHub·Pages·D1 이름을 blog-agent-workboard로 정정. 이번 작업에서 생성한 미사용 오타 프로젝트·빈 DB는 확인 후 정리.
- React/Vite 정적 앱과 Cloudflare Pages Functions로 웹 실행 환경 재구성. Node 파일 시스템·Next.js 서버 의존 제거.
- 사이트 목록·선택·작성·조회에서 동일한 네 사이트 카탈로그 사용. 새로고침 후 선택 유지.
- 전체 화면 재설계: 운영 홈, 실제 수치, 활동 차트, 상태별 콘텐츠 목록·검색, 다국어 작성·미리보기·임시 저장, 아이디어, 발행 흐름, 리포트, 연결 설정.
- 서버 비밀 키 유지, 서명 세션·로그인 시도 제한·출처 검사·Markdown 안전 처리·D1 전송 영수증 및 AI 예산 제한.
- Blogger는 EN/JA 독립 작성 및 전달 파일, 자체 사이트는 실제 스키마에 초안 저장. ASTY 영어 원문·DeepL 번역은 기존 파이프라인에 유지.

## 운영 검증

- Cloudflare Git 배포 성공, GitHub Validate Workboard 성공. 최초 이관 커밋 ca3ad050541de91fda87d76d0fde005a50171107.
- 실제 기존 비밀번호 로그인 성공. 비로그인 사설 API 401, 공개 health 200.
- 실조회: ASTY 46개, Blogger 38개, Korea by Local 55개, Korea Decode 109개. 연결 오류 없음.
- 두 자체 사이트에 비공개 진단 초안을 실제 저장하고 같은 요청 재전송 시 동일 ID를 확인. status=draft와 1개 행을 검증한 뒤 해당 진단 행만 삭제. 기존 운영 글 유지.
- Blogger EN/JA 전달 파일 계약·미리보기·실제 AI 생성 검증. 생성 비용 $0.007933, D1 완료 이력에 기록. 저장·공개 발행 없음.
- 데스크톱과 390px 모바일에서 가로 넘침 없음. 모바일 메뉴 정상. 브라우저 임시 저장 후 제목과 선택한 사이트가 재접속 후 복원.
- Node 브릿지 테스트 15개 및 Cloudflare API 테스트 13개 통과. 타입 검사·Pages 빌드 성공. npm audit 취약점 0개.

## 운영 범위

Blogger 공개 피드는 임시보관·예약 수를 제공하지 않으므로 관리자로 안내합니다. 기존 aside 격일 루틴과 RUNBOOK의 이미지·FAQ·승인 규칙을 유지하며 새 루틴을 생성하지 않았습니다. 이번 이관에서 루틴의 다음 예약 실행 자체를 검증한 것은 아닙니다.

Korea Decode의 기존 DB 권한은 사용자 결정에 따라 유지했습니다. 웹 AI 예산과 로컬·aside 지출 기록은 별개입니다. 기존 Vercel은 복구용으로 보존하고 새 운영 환경은 Pages입니다. 로컬 저장소 폴더는 기존 aside 참조 경로를 유지합니다.
