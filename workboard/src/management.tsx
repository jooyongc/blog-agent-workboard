import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { modelLabel } from "../shared/model-label";
import { api } from "./api";
import type { Workspace } from "../shared/types";
import { CATALOG } from "../shared/catalog";
type Props = {
  active: Workspace;
  workspaces: Workspace[];
  refresh: () => Promise<void>;
};
const note = (error: string) =>
  error ? (
    <div role="alert" className="error-notice">
      {error}
    </div>
  ) : null;
function Header({ title, note }: { title: string; note: string }) {
  return (
    <header className="overview-heading">
      <div>
        <div className="eyebrow">SEO · AEO · GEO</div>
        <h1>{title}</h1>
        <p>{note}</p>
      </div>
    </header>
  );
}
export function WorkspaceManager({ active, workspaces, refresh }: Props) {
  const [editing, setEditing] = useState<Workspace | null>(null);
  useEffect(() => {
    if (editing)
      document
        .getElementById("workspace-editor")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [editing?.site_id]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  function create() {
    const w = structuredClone(CATALOG[1]);
    w.site_id = "";
    w.name = "";
    w.site_url = "https://";
    w.article_path = "/blog/{slug}";
    w.admin_url = "https://";
    w.description = "";
    w.connection = {
      url_env: "NEW_SITE_API_URL",
      key_env: "NEW_SITE_API_KEY",
      schema: "public",
      table: "posts",
      template: "generic",
    };
    w.site_url_env = "NEW_SITE_URL";
    w.strategy = {
      ...w.strategy,
      audience: "",
      voice: "",
      pillars: [""],
      entities: [],
      templates: [],
    };
    w.schedule = { ...w.schedule, enabled: false, next_run: "" };
    setEditing(w);
    setCreating(true);
    setError("");
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await api<Workspace>("workspaces", {
        method: creating ? "POST" : "PUT",
        body: JSON.stringify(editing),
      });
      setMessage(
        `${saved.name} 설정을 저장했습니다. ${saved.schedule.enabled ? `자동 발행 켜짐 · ${saved.schedule.interval_days}일마다 · ${saved.schedule.mode === "draft" ? "비공개 초안 저장" : "공개 발행"}` : "자동 발행 꺼짐"}`,
      );
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function edit<K extends keyof Workspace>(key: K, value: Workspace[K]) {
    setEditing((w) => (w ? { ...w, [key]: value } : w));
  }
  return (
    <div className="studio-page">
      <Header
        title="워크스페이스와 발행 전략"
        note="사이트를 추가하고 독자·노출 전략·연결·발행 일정을 함께 관리하세요."
      />
      {note(error)}
      {message && (
        <div role="status" className="success-notice">
          {message}
        </div>
      )}
      <div className="flex gap-3">
        <button className="button-primary" onClick={create}>
          ＋ 워크스페이스 추가
        </button>
      </div>
      <MediaLibrary active={active} />
      <div className="workspace-card-grid">
        {workspaces.map((w) => (
          <article className="studio-panel form-body" key={w.site_id}>
            <h2>{w.name}</h2>
            <p className="flow-description">
              {w.site_url}
              <br />
              {w.languages.join(" / ")} · {w.strategy.pillars.join(" · ")}
            </p>
            <span
              className={`status-pill ${w.schedule.enabled ? "green" : "neutral"}`}
            >
              {w.schedule.enabled
                ? `${w.schedule.interval_days}일마다 ${String(w.schedule.hour_kst).padStart(2, "0")}:${String(w.schedule.minute).padStart(2, "0")} KST`
                : "자동 발행 꺼짐"}
            </span>
            <button
              className="button-secondary mt-4"
              onClick={() => {
                setEditing(structuredClone(w));
                setCreating(false);
                setError("");
              }}
            >
              전략·연결·일정 설정
            </button>
          </article>
        ))}
      </div>
      {editing && (
        <form
          id="workspace-editor"
          key={editing.site_id || "new"}
          className="studio-panel"
          onSubmit={save}
        >
          <div className="panel-heading">
            <h2>{creating ? "새 워크스페이스" : "워크스페이스 설정"}</h2>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setEditing(null)}
            >
              닫기
            </button>
          </div>
          <div className="form-body">
            <div className="form-row">
              <label className="field-label">
                이름
                <input
                  value={editing.name}
                  required
                  maxLength={100}
                  onChange={(e) => edit("name", e.target.value)}
                />
              </label>
              <label className="field-label">
                워크스페이스 ID
                <input
                  value={editing.site_id}
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  disabled={!creating}
                  onChange={(e) =>
                    edit("site_id", e.target.value.toLowerCase())
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label className="field-label">
                사이트 URL
                <input
                  type="url"
                  value={editing.site_url}
                  required
                  onChange={(e) => edit("site_url", e.target.value)}
                />
              </label>
              <label className="field-label">
                게시 관리자 URL
                <input
                  type="url"
                  value={editing.admin_url}
                  required
                  onChange={(e) => edit("admin_url", e.target.value)}
                />
              </label>
            </div>
            <label className="field-label">
              공개 글 주소 경로
              <input
                value={editing.article_path ?? "/blog/{slug}"}
                onChange={(e) => edit("article_path", e.target.value)}
                placeholder="/blog/{slug}"
              />
              <small>
                글 주소 위치를 /guidebook/{"{slug}"}처럼 입력하세요.
              </small>
            </label>
            <label className="field-label">
              사이트 URL의 CF 변수 (선택)
              <input
                value={editing.site_url_env ?? ""}
                placeholder="NEW_SITE_URL"
                onChange={(e) => edit("site_url_env", e.target.value)}
              />
              <small>변수 값이 있으면 위 사이트 URL보다 우선합니다.</small>
            </label>
            <label className="field-label">
              사이트 소개
              <input
                value={editing.description}
                onChange={(e) => edit("description", e.target.value)}
              />
            </label>
            <div className="form-row">
              <label className="field-label">
                발행 연결
                <select
                  value={editing.integration}
                  onChange={(e) =>
                    edit(
                      "integration",
                      e.target.value as Workspace["integration"],
                    )
                  }
                >
                  <option value="supabase">자체 사이트 · Supabase</option>
                  <option value="blogger">Google Blogger</option>
                  <option value="webhook">사이트 게시 API</option>
                </select>
              </label>
              <label className="field-label">
                작성 언어
                <input
                  defaultValue={editing.languages.join(", ")}
                  onBlur={(e) =>
                    edit(
                      "languages",
                      e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                />
                <small>en, ja, zh-hans · Supabase 연결은 단일 언어</small>
              </label>
            </div>
            <label className="field-label">
              카테고리
              <input
                defaultValue={editing.categories.join(", ")}
                onBlur={(e) =>
                  edit(
                    "categories",
                    e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  )
                }
              />
            </label>
            <h3>사이트에 맞춘 SEO·AEO·GEO</h3>
            <label className="field-label">
              대상 독자
              <textarea
                value={editing.strategy.audience}
                rows={2}
                onChange={(e) =>
                  edit("strategy", {
                    ...editing.strategy,
                    audience: e.target.value,
                  })
                }
              />
            </label>
            <label className="field-label">
              작성 톤과 사실 확인 규칙
              <textarea
                value={editing.strategy.voice}
                rows={3}
                onChange={(e) =>
                  edit("strategy", {
                    ...editing.strategy,
                    voice: e.target.value,
                  })
                }
              />
            </label>
            <label className="field-label">
              주제 묶음
              <input
                defaultValue={editing.strategy.pillars.join(", ")}
                onBlur={(e) =>
                  edit("strategy", {
                    ...editing.strategy,
                    pillars: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label className="field-label">
              주요 장소·브랜드·개념
              <input
                defaultValue={editing.strategy.entities.join(", ")}
                onBlur={(e) =>
                  edit("strategy", {
                    ...editing.strategy,
                    entities: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label className="field-label">
              신뢰할 출처 도메인
              <input
                defaultValue={editing.strategy.source_domains.join(", ")}
                onBlur={(e) =>
                  edit("strategy", {
                    ...editing.strategy,
                    source_domains: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
              <small>자동 리서치는 지정한 공식 출처만 검색합니다.</small>
            </label>
            <div className="form-row">
              <label className="field-label">
                최소 검증 점수
                <input
                  type="number"
                  min={50}
                  max={100}
                  value={editing.strategy.min_score}
                  onChange={(e) =>
                    edit("strategy", {
                      ...editing.strategy,
                      min_score: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field-label">
                필요 이미지 수
                <input
                  type="number"
                  min={0}
                  max={4}
                  value={editing.strategy.required_images}
                  onChange={(e) =>
                    edit("strategy", {
                      ...editing.strategy,
                      required_images: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label className="field-label">
              제휴 링크 고지
              <textarea
                rows={2}
                value={editing.strategy.affiliate_disclosure}
                onChange={(e) =>
                  edit("strategy", {
                    ...editing.strategy,
                    affiliate_disclosure: e.target.value,
                  })
                }
              />
            </label>
            <label className="field-label">
              미디어 에이전트 방식
              <select
                value={editing.strategy.media_mode || "stock"}
                onChange={(e) =>
                  edit("strategy", {
                    ...editing.strategy,
                    media_mode: e.target.value as "stock" | "hybrid",
                  })
                }
              >
                <option value="stock">무료 사진·라이선스 Stock</option>
                <option value="hybrid">무료 사진 + Adobe 생성 이미지</option>
              </select>
              <small>
                Adobe 생성은 Firefly Services API 연결 후 활성화됩니다.
              </small>
            </label>
            <label className="field-label">
              <span>
                <input
                  type="checkbox"
                  checked={!!editing.strategy.generate_video}
                  onChange={(e) =>
                    edit("strategy", {
                      ...editing.strategy,
                      generate_video: e.target.checked,
                    })
                  }
                />{" "}
                Adobe 생성 영상도 추가
              </span>
            </label>
            <details>
              <summary>저장된 주제 템플릿 편집</summary>
              <label className="field-label">
                한 줄에 제목 | 카테고리 | 핵심 키워드 | 형식 | 그룹 | 아이콘 |
                설명 | 작성 방향
                <textarea
                  rows={6}
                  defaultValue={editing.strategy.templates
                    .map((t) =>
                      [
                        t.title,
                        t.category,
                        t.keyword,
                        t.format,
                        t.group || "",
                        t.emoji || "",
                        t.hint || "",
                        t.direction || "",
                      ].join(" | "),
                    )
                    .join("\n")}
                  onBlur={(e) =>
                    edit("strategy", {
                      ...editing.strategy,
                      templates: e.target.value
                        .split("\n")
                        .filter((s) => s.trim())
                        .map((s, i) => {
                          const [
                            title,
                            category,
                            keyword,
                            format,
                            group,
                            emoji,
                            hint,
                            direction,
                          ] = s.split("|").map((s) => s.trim());
                          return {
                            ...editing.strategy.templates[i],
                            title,
                            category,
                            keyword,
                            format: format || "guide",
                            group,
                            emoji,
                            hint,
                            direction,
                            aeo: group === "AEO 필러",
                          };
                        }),
                    })
                  }
                />
              </label>
            </details>
            <details open>
              <summary>Cloudflare 연결 변수</summary>
              <p className="flow-description">
                키 값은 Cloudflare Pages에 저장합니다. 여기에는 변수 이름만
                입력하세요.
              </p>
              <div className="form-row">
                <label className="field-label">
                  API URL 변수
                  <input
                    value={editing.connection.url_env}
                    onChange={(e) =>
                      edit("connection", {
                        ...editing.connection,
                        url_env: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="field-label">
                  비밀 키 변수
                  <input
                    value={editing.connection.key_env}
                    onChange={(e) =>
                      edit("connection", {
                        ...editing.connection,
                        key_env: e.target.value,
                      })
                    }
                  />
                </label>
              </div>
              {editing.integration === "supabase" ? (
                <>
                  <div className="form-row">
                    <label className="field-label">
                      DB 스키마
                      <input
                        value={editing.connection.schema ?? "public"}
                        onChange={(e) =>
                          edit("connection", {
                            ...editing.connection,
                            schema: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="field-label">
                      글 테이블
                      <input
                        value={editing.connection.table ?? "posts"}
                        onChange={(e) =>
                          edit("connection", {
                            ...editing.connection,
                            table: e.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="field-label">
                    글 저장 형식
                    <select
                      value={editing.connection.template ?? "generic"}
                      onChange={(e) =>
                        edit("connection", {
                          ...editing.connection,
                          template: e.target.value as "generic",
                        })
                      }
                    >
                      <option value="generic">
                        기본 · slug/title/content/category/status
                      </option>
                      <option value="koreabylocal">Korea by Local</option>
                      <option value="koreadecode">Korea Decode</option>
                    </select>
                  </label>
                </>
              ) : editing.integration === "blogger" ? (
                <>
                  <label className="field-label">
                    Blogger blogId
                    <input
                      value={editing.connection.blog_id ?? ""}
                      onChange={(e) =>
                        edit("connection", {
                          ...editing.connection,
                          blog_id: e.target.value,
                        })
                      }
                    />
                  </label>
                  {(
                    [
                      "client_id_env",
                      "client_secret_env",
                      "refresh_token_env",
                    ] as const
                  ).map((k) => (
                    <label key={k} className="field-label">
                      {k.replace("_env", "").replaceAll("_", " ")} 변수
                      <input
                        value={editing.connection[k] ?? ""}
                        onChange={(e) =>
                          edit("connection", {
                            ...editing.connection,
                            [k]: e.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                </>
              ) : null}
              <label className="field-label">
                Search Console 데이터 API (선택)
                <input
                  value={editing.strategy.gsc_url ?? ""}
                  placeholder="https://…"
                  onChange={(e) =>
                    edit("strategy", {
                      ...editing.strategy,
                      gsc_url: e.target.value,
                    })
                  }
                />
              </label>
              <label className="field-label">
                GSC API 키 변수 (선택)
                <input
                  value={editing.strategy.gsc_key_env ?? ""}
                  onChange={(e) =>
                    edit("strategy", {
                      ...editing.strategy,
                      gsc_key_env: e.target.value,
                    })
                  }
                />
              </label>
            </details>
            <h3>정기 발행</h3>
            <label className="review-checkbox">
              <input
                type="checkbox"
                checked={editing.schedule.enabled}
                onChange={(e) =>
                  edit("schedule", {
                    ...editing.schedule,
                    enabled: e.target.checked,
                  })
                }
              />
              자동 발행 사용
            </label>
            <label className="review-checkbox">
              <input
                type="checkbox"
                checked={editing.schedule.auto_generate}
                onChange={(e) =>
                  edit("schedule", {
                    ...editing.schedule,
                    auto_generate: e.target.checked,
                  })
                }
              />
              승인한 아이디어의 리서치·작성·검증 자동 실행
            </label>
            <div className="form-row">
              <label className="field-label">
                발행 간격 (일)
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={editing.schedule.interval_days}
                  onChange={(e) =>
                    edit("schedule", {
                      ...editing.schedule,
                      interval_days: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field-label">
                발행 방식
                <select
                  value={editing.schedule.mode}
                  onChange={(e) =>
                    edit("schedule", {
                      ...editing.schedule,
                      mode: e.target.value as "publish",
                    })
                  }
                >
                  <option value="publish">검증 통과한 글 공개 발행</option>
                  <option value="draft">사이트에 초안만 저장</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label className="field-label">
                한국 시간 · 시
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={editing.schedule.hour_kst}
                  onChange={(e) =>
                    edit("schedule", {
                      ...editing.schedule,
                      hour_kst: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field-label">
                분
                <select
                  value={editing.schedule.minute}
                  onChange={(e) =>
                    edit("schedule", {
                      ...editing.schedule,
                      minute: Number(e.target.value),
                    })
                  }
                >
                  {[0, 15, 30, 45].map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="flow-description">
              출처·FAQ·이미지·품질 기준을 충족하지 못한 글은 검토 대기로
              남습니다. 전송 결과가 불명확한 작업은 자동 재발행하지 않습니다.
            </p>
            {error && (
              <div role="alert" className="error-notice">
                저장하지 못했습니다: {error}
              </div>
            )}
            <button className="button-primary" disabled={busy}>
              {busy ? "저장 중…" : "워크스페이스 저장"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
export function StrategyTopics({ active }: Pick<Props, "active">) {
  const [templateGroup, setTemplateGroup] = useState("전체");
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<number | null>(null);
  const [approvedNotice, setApprovedNotice] = useState("");
  const [votes, setVotes] = useState<Record<number, string>>({});
  const groups = [
    "전체",
    ...new Set(active.strategy.templates.map((t) => t.group || t.category)),
  ];
  const month = new Date().getMonth() + 1;
  const [direction, setDirection] = useState(
    active.strategy.pillars.join(", ") + "\n",
  );
  const [proposals, setProposals] = useState<Record<string, any>[]>([]);
  const [approvedTitles, setApprovedTitles] = useState<string[]>([]);
  const [topics, setTopics] = useState<Record<string, any>[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(active.categories[0]);
  const load = () =>
    api<{ topics: typeof topics }>(`topics?site_id=${active.site_id}`).then(
      (r) => setTopics(r.topics),
    );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [active.site_id]);
  async function suggest() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ data: { proposals: typeof proposals } }>(
        "strategy/propose",
        {
          method: "POST",
          body: JSON.stringify({ site_id: active.site_id, direction }),
        },
      );
      setProposals(r.data.proposals);
      setVotes({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function approve(t: Record<string, any>) {
    setBusy(true);
    setError("");
    try {
      await api("topics", {
        method: "POST",
        body: JSON.stringify({
          site_id: active.site_id,
          title: t.title,
          category: t.category,
          note: t.rationale ?? "",
          brief: t,
          status: "approved",
        }),
      });
      setApprovedTitles((a) => [...a, t.title]);
      await load();
      setApprovedNotice(
        "아이디어를 승인했습니다. 에이전트가 조사·집필·사진 선정·검증·임시 발행을 자동으로 진행합니다.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="studio-page">
      <Header
        title="디렉션"
        note={`${active.name} · 대상 독자, 기존 글, 키워드 기회와 질문 의도를 함께 살펴봅니다.`}
      />
      {note(error)}
      {approvedNotice && (
        <div className="success-notice" role="status">
          {approvedNotice}{" "}
          <Link to="/flow" className="button-secondary">
            에이전트 진행 상황
          </Link>
        </div>
      )}
      <section className="studio-panel direction-assistant">
        <div className="panel-heading">
          <h2>✳ 방향 어시스턴트</h2>
          <span className="subtle-pill">
            {active.strategy.templates.length}개 템플릿
          </span>
          <button
            className="button-secondary"
            aria-expanded={templatesOpen}
            onClick={() => setTemplatesOpen(!templatesOpen)}
          >
            {templatesOpen ? "접기" : "펼치기"}
          </button>
        </div>
        {templatesOpen && (
          <div className="form-body">
            <div className="direction-filters" aria-label="디렉션 카테고리">
              {groups.map((group) => (
                <button
                  key={group}
                  aria-pressed={templateGroup === group}
                  className={templateGroup === group ? "selected" : ""}
                  onClick={() => setTemplateGroup(group)}
                >
                  {group}
                </button>
              ))}
            </div>
            <div className="direction-template-grid">
              {active.strategy.templates
                .map((t, i) => ({ t, i }))
                .filter(
                  ({ t }) =>
                    templateGroup === "전체" ||
                    (t.group || t.category) === templateGroup,
                )
                .map(({ t, i }) => (
                  <button
                    key={i}
                    className={`direction-template ${selectedTemplate === i ? "selected" : ""}`}
                    aria-pressed={selectedTemplate === i}
                    onClick={() => {
                      setSelectedTemplate(i);
                      setDirection(
                        t.direction ||
                          `${active.name}의 독자를 대상으로 ${t.title} 방향에서 주제 3개를 제안하세요. 핵심 키워드: ${t.keyword}. 형식: ${t.format}.`,
                      );
                    }}
                  >
                    <div className="direction-template-heading">
                      <strong>
                        {t.emoji || "✦"} {t.title}
                      </strong>
                      {t.aeo && <span className="direction-aeo">● AEO</span>}
                      {t.seasonal_months?.includes(month) && (
                        <span className="direction-aeo">● 제철</span>
                      )}
                      <span className="subtle-pill direction-category">
                        {t.group || t.category}
                      </span>
                    </div>
                    <p>{t.hint || t.keyword}</p>
                    <div className="direction-tags">
                      {(t.tags || [t.category, t.format]).map((tag) => (
                        <span key={tag} className="subtle-pill">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
            </div>
            <small>
              템플릿을 선택하면 아래 작성 방향에 반영됩니다. 사이트 전략에 맞춰
              자유롭게 수정하세요.
            </small>
          </div>
        )}
      </section>
      <section className="studio-panel">
        <div className="panel-heading">
          <h2>저장된 사이트 전략</h2>
        </div>
        <div className="form-body">
          <p>{active.strategy.audience}</p>
          <div className="flex gap-2 flex-wrap">
            {active.strategy.pillars.map((p) => (
              <span key={p} className="subtle-pill">
                {p}
              </span>
            ))}
          </div>
          <p className="flow-description">{active.strategy.voice}</p>
          <Link className="button-secondary" to="/workspaces">
            전략 편집
          </Link>
        </div>
      </section>
      <section className="studio-panel">
        <div className="panel-heading">
          <h2>
            이번 주 작성 방향{" "}
            {selectedTemplate !== null && (
              <span className="subtle-pill">
                {active.strategy.templates[selectedTemplate]?.title}
              </span>
            )}
          </h2>
        </div>
        <div className="form-body">
          <textarea
            className="direction-input"
            aria-label="이번 주 작성 방향"
            rows={5}
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          />
          <button
            className="button-primary mt-4"
            disabled={busy || !direction.trim()}
            onClick={() => void suggest()}
          >
            {busy
              ? "주제 기회를 분석하고 있어요…"
              : "SEO·AEO·GEO 주제 3개 제안"}
          </button>
          <small>
            GSC 연결 시 실제 8~20위 키워드를 우선합니다. 데이터가 없으면 전략
            기반 제안으로 표시합니다.
          </small>
        </div>
      </section>
      <div className="integration-grid">
        {proposals.map((t, i) => (
          <article className="studio-panel form-body" key={i}>
            <span className="status-pill green">
              추천 {i + 1} · 적합도 {t.score}
            </span>
            <h3>{t.title}</h3>
            <p>{t.primary_keyword}</p>
            <p className="flow-description">{t.rationale}</p>
            <ul>
              {t.aeo_question_variants?.map((q: string) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
            <small>
              {t.source === "gsc_striking"
                ? "실측 GSC 기회"
                : "저장된 전략 기반 · 검색량 추정 없음"}
            </small>
            <div className="direction-votes">
              {[1, -1].map((rating) => (
                <button
                  className="button-secondary"
                  key={rating}
                  disabled={busy || !!votes[i]}
                  onClick={() => {
                    setVotes((v) => ({ ...v, [i]: "저장 중" }));
                    void api("topics/feedback", {
                      method: "POST",
                      body: JSON.stringify({
                        site_id: active.site_id,
                        title: t.title,
                        rating,
                        context: t,
                      }),
                    })
                      .then(() =>
                        setVotes((v) => ({
                          ...v,
                          [i]: rating === 1 ? "선호 반영됨" : "비선호 반영됨",
                        })),
                      )
                      .catch((e) => {
                        setVotes((v) => ({ ...v, [i]: "" }));
                        setError(e.message);
                      });
                  }}
                >
                  {rating === 1 ? "👍 이런 방향 좋아요" : "👎 다른 방향 원해요"}
                </button>
              ))}
              {votes[i] && <small role="status">{votes[i]}</small>}
            </div>
            <button
              className="button-primary mt-4"
              disabled={busy || approvedTitles.includes(t.title)}
              onClick={() => void approve(t)}
            >
              {approvedTitles.includes(t.title)
                ? "승인됨 · 에이전트 진행 중"
                : "승인하고 자동 작성"}
            </button>
          </article>
        ))}
      </div>
      <section className="studio-panel">
        <div className="panel-heading">
          <h2>사이트별 저장 주제</h2>
        </div>
        <div className="idea-list">
          {topics.map((t) => (
            <article key={t.id}>
              <span
                className={`status-pill ${t.status === "approved" ? "green" : "neutral"}`}
              >
                {(
                  {
                    approved: "에이전트 작업 대기",
                    used: "작성 완료",
                    proposed: "제안",
                    in_progress: "에이전트 작업 중",
                  } as Record<string, string>
                )[t.status] ?? t.status}
              </span>
              <h3>{t.title}</h3>
              <p>{t.note}</p>
              <div className="flex gap-3">
                <Link
                  className="button-secondary"
                  to={
                    t.status === "proposed"
                      ? `/compose?topic=${encodeURIComponent(t.title)}&category=${encodeURIComponent(t.category)}`
                      : "/flow"
                  }
                >
                  {t.status === "proposed"
                    ? "자료 자동 준비"
                    : "에이전트 진행 확인"}
                </Link>
                {t.status === "proposed" && (
                  <button
                    className="button-secondary"
                    onClick={() =>
                      void api("topics/status", {
                        method: "POST",
                        body: JSON.stringify({
                          id: t.id,
                          site_id: active.site_id,
                          status: "approved",
                        }),
                      })
                        .then(load)
                        .catch((e) => setError(e.message))
                    }
                  >
                    자동 작성 승인
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        <div className="form-body">
          <label className="field-label">
            직접 주제 추가
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="독자가 궁금해할 질문"
            />
          </label>
          <label className="field-label">
            카테고리
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {active.categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button
            className="button-secondary"
            disabled={busy || title.trim().length < 3}
            onClick={() => void approve({ title, category })}
          >
            주제 승인·저장
          </button>
        </div>
      </section>
    </div>
  );
}
function parseVerification(quality: string | null | undefined) {
  try {
    const v = quality ? JSON.parse(quality).verification : null;
    return v && v.passed === false ? v : null;
  } catch {
    return null;
  }
}
export function AutomationFlow({ active }: Pick<Props, "active">) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [check, setCheck] = useState("");
  const load = useCallback(
    () =>
      api(`automation?site_id=${active.site_id}`)
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((e) => setError(e.message)),
    [active.site_id],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <div className="studio-page">
      <Header
        title={`${active.name}의 에이전트 작업실`}
        note="아이디어만 승인하세요. 역할별 에이전트가 작업을 이어서 임시 발행까지 완료합니다."
      />
      {note(error)}
      <section className="orchestration-banner">
        <div>
          <strong>Cloudflare 백그라운드 실행</strong>
          <p>
            창을 닫거나 다른 페이지로 이동해도 계속됩니다. 상위 검토가 판단하고
            보완 에이전트에 작업을 배정합니다.
          </p>
        </div>
        <span className="status-pill green">
          상위 검토 · {modelLabel(data?.orchestration?.supervisor_model)}
        </span>
      </section>
      <p className="flow-description">
        무료 사진: {data?.media?.pexels ? "Pexels 연결" : "Pexels 미연결"} ·{" "}
        {data?.media?.unsplash ? "Unsplash 연결" : "Unsplash 미연결"} · Adobe
        라이선스 자료 사용 가능 · Firefly:{" "}
        {data?.media?.firefly ? "연결됨" : "Developer API 연결 대기"}
      </p>
      <div className="workflow-guide">
        {[
          "공식 출처 조사",
          "독자별 집필",
          "무료 사진 선정",
          "SEO·AEO·GEO 검증",
          "상위 검토 · " + modelLabel(data?.orchestration?.supervisor_model),
          "필요 시 보완 → 재검증",
          "승인된 글 임시 발행",
        ].map((s, i) => (
          <div key={s} className="workflow-step">
            <small>STEP 0{i + 1}</small>
            <h3>{s}</h3>
          </div>
        ))}
      </div>
      <section className="studio-panel">
        <div className="panel-heading">
          <h2>발행 일정</h2>
          <span
            className={`status-pill ${active.schedule.enabled ? "green" : "neutral"}`}
          >
            {active.schedule.enabled ? "자동 발행 켜짐" : "자동 발행 꺼짐"}
          </span>
        </div>
        <div className="form-body">
          <p>
            {active.schedule.interval_days}일마다{" "}
            {String(active.schedule.hour_kst).padStart(2, "0")}:
            {String(active.schedule.minute).padStart(2, "0")} KST ·{" "}
            {active.schedule.mode === "publish"
              ? "공개 발행"
              : "원격 초안 저장"}
          </p>
          <p>
            다음 실행:{" "}
            {active.schedule.next_run
              ? new Date(active.schedule.next_run).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })
              : "설정 후 예약"}
          </p>
          <p>
            연결 상태:{" "}
            {data?.connection.ready ? "준비됨" : "CF 연결 변수 확인 필요"}
          </p>
          <div className="flex gap-3">
            <Link className="button-primary" to="/workspaces">
              발행 설정
            </Link>
            <button
              className="button-secondary"
              onClick={() =>
                void api("automation/check", { method: "POST", body: "{}" })
                  .then(() =>
                    setCheck(
                      "예약 설정과 발행 대기열을 읽기 전용으로 점검했습니다.",
                    ),
                  )
                  .catch((e) => setError(e.message))
              }
            >
              예약 점검
            </button>
          </div>
          {check && <p role="status">{check}</p>}
        </div>
      </section>
      <section className="studio-panel">
        <div className="panel-heading">
          <h2>발행 대기열</h2>
        </div>
        {data?.jobs.length ? (
          <div className="idea-list">
            {data.jobs.map((j: any) => {
              const report = parseVerification(j.quality_json);
              const workflow = data?.workflows?.find(
                (f: any) => f.job_id === j.id,
              );
              const recovery = workflow?.recovery_json
                ? JSON.parse(workflow.recovery_json)
                : null;
              const supervision = workflow?.supervision_json
                ? JSON.parse(workflow.supervision_json)
                : [];
              const roles: Record<string, string> = {
                researcher: "출처 조사",
                writer: "독자별 집필",
                photo_editor: "사진 선정",
                verifier: "근거·구조 검증",
                supervisor: "상위 검토",
                editor: "근거·구조 보완",
                publisher: "임시 발행",
              };
              return (
                <article key={j.id}>
                  <span
                    className={`status-pill ${j.status === "published" ? "green" : "amber"}`}
                  >
                    {(
                      {
                        ready: "예약 대기",
                        review: "검토 필요",
                        budget_wait: "예산 갱신 후 자동 재개",
                        retry_wait: "AI 요청 제한 · 자동 재개 대기",
                        published: "발행 완료",
                        drafted: "초안 저장",
                        failed: "실패 · 결과 확인",
                        researching: "리서치 중",
                        generating: "작성 중",
                        agent_pending: "에이전트 자동 실행 대기",
                        verifying: "검증 에이전트 작업 중",
                        supervising: "상위 에이전트 검토 중",
                        editing: "에이전트 자동 보완 중",
                        publishing: "임시 발행 중",
                        needs_reconcile: "중단 · 원격 확인",
                      } as Record<string, string>
                    )[j.status] ?? j.status}
                  </span>
                  <h3>{j.title}</h3>
                  <p>
                    {j.publish_at
                      ? new Date(j.publish_at).toLocaleString("ko-KR", {
                          timeZone: "Asia/Seoul",
                        })
                      : j.status === "budget_wait"
                        ? "예산 갱신 대기"
                        : "작성 중"}
                  </p>
                  <div
                    className="orchestration-track"
                    aria-label="에이전트 실행 단계"
                  >
                    {Object.entries(roles).map(([agent, label]) => {
                      const step = data?.steps?.find(
                        (s: any) => s.job_id === j.id && s.agent === agent,
                      );
                      const current =
                        workflow?.stage === agent &&
                        [
                          "pending",
                          "running",
                          "budget_wait",
                          "retry_wait",
                        ].includes(workflow?.status);
                      const status = current
                        ? workflow.status === "budget_wait"
                          ? "예산 대기"
                          : workflow.status === "running"
                            ? "실행 중"
                            : "실행 대기"
                        : step?.status === "complete"
                          ? "완료"
                          : step?.status === "failed"
                            ? "재검토"
                            : "대기";
                      return (
                        <div
                          key={agent}
                          aria-current={current ? "step" : undefined}
                          className={`orchestration-node ${current ? "current" : ""} ${step?.status === "complete" ? "complete" : ""}`}
                        >
                          <strong>{label}</strong>
                          <small>
                            {["supervisor", "editor"].includes(agent)
                              ? modelLabel(
                                  (step?.output_json
                                    ? JSON.parse(step.output_json).model
                                    : null) ||
                                    data?.orchestration?.supervisor_model,
                                )
                              : ["writer", "researcher", "verifier"].includes(
                                    agent,
                                  )
                                ? modelLabel(
                                    (step?.output_json
                                      ? JSON.parse(step.output_json).model
                                      : null) ||
                                      (step?.status === "complete"
                                        ? "claude-haiku-4-5"
                                        : data?.orchestration?.worker_model),
                                  )
                                : "서버 도구"}
                          </small>
                          <span>{status}</span>
                        </div>
                      );
                    })}
                  </div>
                  {supervision.length > 0 && (
                    <div className="supervisor-decisions">
                      <strong>
                        상위 검토의 판단 · {supervision.length}/
                        {data?.orchestration?.max_review_rounds || 3}회
                      </strong>
                      {supervision.map((decision: any, index: number) => (
                        <div
                          key={index}
                          className={`supervisor-decision ${decision.action === "approve" ? "approved" : ""}`}
                        >
                          <span
                            className={`status-pill ${decision.action === "approve" ? "green" : "amber"}`}
                          >
                            {
                              (
                                {
                                  approve: "임시 발행 승인",
                                  edit: "보완 배정",
                                  research: "추가 조사 배정",
                                  blocked: "추가 근거 필요",
                                } as Record<string, string>
                              )[decision.action]
                            }
                          </span>
                          <small>
                            {modelLabel(decision.model)} ·{" "}
                            {new Date(decision.at).toLocaleTimeString("ko-KR", {
                              timeZone: "Asia/Seoul",
                            })}{" "}
                            KST
                          </small>
                          <p>{decision.reason}</p>
                          {decision.instructions &&
                            decision.action !== "approve" && (
                              <p className="flow-description">
                                보완 지시: {decision.instructions}
                              </p>
                            )}
                        </div>
                      ))}
                    </div>
                  )}
                  <details className="agent-timeline">
                    <summary>에이전트 실행 이력</summary>
                    <ol>
                      {(data?.steps || [])
                        .filter((step: any) => step.job_id === j.id)
                        .slice(0, 14)
                        .reverse()
                        .map((step: any) => (
                          <li key={step.id}>
                            <time>
                              {new Date(step.started_at).toLocaleTimeString(
                                "ko-KR",
                                { timeZone: "Asia/Seoul" },
                              )}
                            </time>
                            <strong>{roles[step.agent] || step.agent}</strong>
                            <span>
                              {(
                                {
                                  running: "진행",
                                  complete: "완료",
                                  failed: "중단",
                                  waiting: "대기",
                                } as Record<string, string>
                              )[step.status] || step.status}
                            </span>
                            {step.error && <p>{step.error}</p>}
                          </li>
                        ))}
                    </ol>
                  </details>
                  {j.error && <p role="alert">{j.error}</p>}
                  {recovery?.retry_at && (
                    <p>
                      자동 재개 예정:{" "}
                      {new Date(recovery.retry_at).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                      })}{" "}
                      KST 이후 정기 실행
                    </p>
                  )}
                  {report && (
                    <div className="verification-report" role="alert">
                      <p>{report.reason}</p>
                      {report.claims?.length ? (
                        <ul>
                          {report.claims
                            .slice(0, 12)
                            .map((c: any, index: number) => (
                              <li key={index}>
                                <strong>
                                  {String(c.lang).toUpperCase()} ·{" "}
                                  {c.status === "contradicted"
                                    ? "모순"
                                    : "근거 없음"}
                                </strong>{" "}
                                {c.claim}
                              </li>
                            ))}
                        </ul>
                      ) : null}
                    </div>
                  )}
                  {data?.workflows?.some(
                    (f: any) =>
                      f.job_id === j.id &&
                      ["failed", "interrupted"].includes(f.status),
                  ) && (
                    <button
                      className="button-secondary"
                      onClick={() =>
                        void api("automation/retry", {
                          method: "POST",
                          body: JSON.stringify({
                            site_id: active.site_id,
                            job_id: j.id,
                          }),
                        })
                          .then(() => {
                            setCheck("실패한 단계부터 재개합니다.");
                            void load();
                          })
                          .catch((e) => setError(e.message))
                      }
                    >
                      중단 단계부터 재개
                    </button>
                  )}
                  {j.status === "drafted" && (
                    <Link
                      className="button-secondary"
                      to={`/compose?job=${j.id}`}
                    >
                      완성 글·사진 미리보기
                    </Link>
                  )}
                  {j.quality_json && (
                    <details>
                      <summary>검증 결과</summary>
                      <pre className="quality-json">
                        {JSON.stringify(JSON.parse(j.quality_json), null, 2)}
                      </pre>
                    </details>
                  )}
                  {["review", "ready"].includes(j.status) && (
                    <Link
                      className="button-secondary mt-4"
                      to={`/compose?job=${j.id}`}
                    >
                      글 검토·보완
                    </Link>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="form-body">
            <p>
              아직 등록한 작업이 없습니다. 주제를 승인하거나 작성한 글을 발행
              큐에 넣으세요.
            </p>
            <Link className="button-primary" to="/topics">
              SEO 주제 준비
            </Link>
          </div>
        )}
      </section>
      <section className="studio-panel">
        <div className="panel-heading">
          <h2>정기 실행 기록</h2>
        </div>
        <div className="idea-list">
          {data?.runs.map((r: any) => (
            <article key={r.id}>
              <span className="subtle-pill">
                {r.status} · {r.phase}
              </span>
              <p>{r.message}</p>
              <small>{new Date(r.created_at).toLocaleString("ko-KR")}</small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
export function Connections({
  workspaces,
  active,
}: Pick<Props, "workspaces" | "active">) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [measurement, setMeasurement] = useState<any>(null);
  const [measuring, setMeasuring] = useState(false);
  useEffect(() => {
    api(`measurement?site_id=${active.site_id}`)
      .then(setMeasurement)
      .catch((e) => setError(e.message));
  }, [active.site_id]);
  useEffect(() => {
    api("settings")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="studio-page">
      <Header
        title="연결 상태와 Cloudflare 변수"
        note="서버 키를 화면에 노출하지 않고 사이트별 준비 상태를 확인합니다."
      />
      {note(error)}
      <section className="studio-panel form-body">
        <p>실행 환경: Cloudflare Pages + Cron Worker</p>
        <p>AI 연결: {data?.ai_ready ? "준비됨" : "설정 필요"}</p>
        <p>작업 기록: {data?.database_ready ? "준비됨" : "설정 필요"}</p>
        <p>스케줄러: blog-agent-workboard-scheduler · 15분 간격 실행</p>
      </section>
      <div className="integration-grid">
        {workspaces.map((w) => {
          const r = data?.workspaces.find((x: any) => x.site_id === w.site_id);
          return (
            <article key={w.site_id} className="studio-panel form-body">
              <h2>{w.name}</h2>
              <span className={`status-pill ${r?.ready ? "green" : "amber"}`}>
                {r?.ready ? "연결 준비됨" : "변수 설정 필요"}
              </span>
              <p>
                URL: <code>{w.connection.url_env}</code>
              </p>
              <p>
                키: <code>{w.connection.key_env}</code>
              </p>
              {w.integration === "blogger" && (
                <p>
                  OAuth: {w.connection.client_id_env},{" "}
                  {w.connection.client_secret_env},{" "}
                  {w.connection.refresh_token_env}
                </p>
              )}
              {w.integration === "blogger" && (
                <>
                  <button
                    className="button-primary mt-4"
                    onClick={() =>
                      void api<{ url: string }>("blogger/oauth/start", {
                        method: "POST",
                        body: JSON.stringify({ site_id: w.site_id }),
                      })
                        .then((r) => window.location.assign(r.url))
                        .catch((e) => setError(e.message))
                    }
                  >
                    Google 계정으로 Blogger 연결
                  </button>
                  <small>
                    Google OAuth 승인된 리다이렉트 URI:
                    https://blog-agent-workboard.pages.dev/api/blogger/oauth/callback
                  </small>
                </>
              )}
              <small>
                사이트 연결 변수는 Pages에 등록하세요. Scheduler Worker는 작업실
                URL과 실행 인증 키를 사용합니다.
              </small>
            </article>
          );
        })}
      </div>
      <section className="studio-panel">
        <div className="panel-heading">
          <h2>{active.name} · 크롤러 눈으로 검증</h2>
          <button
            className="button-secondary"
            disabled={measuring}
            onClick={() => {
              setMeasuring(true);
              void api("measurement", {
                method: "POST",
                body: JSON.stringify({ site_id: active.site_id }),
              })
                .then(setMeasurement)
                .catch((e) => setError(e.message))
                .finally(() => setMeasuring(false));
            }}
          >
            {measuring ? "원본 HTML 측정 중…" : "기준선 측정"}
          </button>
        </div>
        <div className="form-body">
          <p>
            다음 재측정:{" "}
            {measurement?.next_measure_at
              ? new Date(measurement.next_measure_at).toLocaleDateString(
                  "ko-KR",
                  { timeZone: "Asia/Seoul" },
                )
              : "첫 측정 후 14일"}
          </p>
          {measurement?.checks &&
            Object.entries(measurement.checks).map(([name, value]) => (
              <div className="quality-card" key={name}>
                <strong>{name}</strong>
                <p>{(value as any).url}</p>
                <p>
                  {(value as any).error ??
                    `HTTP ${(value as any).status} · H1 ${(value as any).h1 ? "있음" : "없음"} · JSON-LD ${(value as any).jsonld ? "있음" : "없음"} · noindex ${(value as any).noindex ? "차단됨" : "없음"}`}
                </p>
              </div>
            ))}
          <small>
            노출·클릭·AI 인용은 실측 데이터가 연결되기 전까지 추정치로 표시하지
            않습니다.
          </small>
        </div>
      </section>
      <Link className="button-primary" to="/workspaces">
        연결·전략 수정
      </Link>
    </div>
  );
}

function MediaLibrary({ active }: Pick<Props, "active">) {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [provider, setProvider] = useState("Adobe Firefly");
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setMessage("");
    try {
      const data = new FormData(form);
      data.set("site_id", active.site_id);
      const r = await fetch("/api/media-library/upload", {
        method: "POST",
        body: data,
        credentials: "same-origin",
      });
      const result = (await r.json()) as { error?: string };
      if (!r.ok) throw Error(result.error || "등록 실패");
      form.reset();
      setMessage(
        "미디어가 저장되었습니다. 태그에 맞는 글에서 에이전트가 재사용합니다.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="studio-panel form-body">
      <summary>Adobe 웹 생성물·라이선스 미디어 등록</summary>
      <p className="flow-description">
        Firefly 웹에서 만든 이미지·영상 또는 무료 라이선스를 받은 Stock 원본을
        저장해 에이전트가 재사용할 수 있습니다.
      </p>
      <form onSubmit={(e) => void upload(e)}>
        <label className="field-label">
          종류
          <select
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option>Adobe Firefly</option>
            <option>Adobe Stock</option>
          </select>
        </label>
        <label className="field-label">
          설명
          <input
            required
            name="title"
            placeholder="예: AI로 만든 한국 여행 준비 장면"
          />
        </label>
        <label className="field-label">
          영문 주제 태그
          <input
            required
            name="tags"
            placeholder="Korea travel, shopping, skincare"
          />
        </label>
        {provider === "Adobe Stock" && (
          <label className="field-label">
            라이선스 이력·에셋 ID
            <input
              required
              name="license_reference"
              placeholder="무료 라이선스 이력의 에셋 ID 또는 참조"
            />
          </label>
        )}
        <label className="field-label">
          원본 이미지·영상
          <input
            required
            type="file"
            name="file"
            accept="image/jpeg,image/png,video/mp4,video/quicktime"
          />
        </label>
        <button disabled={busy} className="button-primary">
          {busy ? "저장 중…" : "미디어 등록"}
        </button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
