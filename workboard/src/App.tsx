import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Icons, type IconName } from "./icons";
import { workspaceLook, LANGUAGE_LABEL } from "./workspace-look";
import { api, ApiError } from "./api";
import {
  WorkspaceManager,
  StrategyTopics,
  AutomationFlow,
  Connections,
} from "./management";
import type {
  Workspace,
  Post,
  PostsResult,
  Article,
  DraftInput,
} from "../shared/types";

type SiteData = PostsResult & { site_id: string };
type Store = {
  workspaces: Workspace[];
  active: Workspace;
  sites: SiteData[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  choose: (id: string) => Promise<void>;
  logout: () => Promise<void>;
};
const StoreContext = createContext<Store | null>(null);
function useStore() {
  const s = useContext(StoreContext);
  if (!s) throw new Error("Workspace store unavailable");
  return s;
}
function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const C = Icons[name];
  return <C size={size} />;
}
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="error-notice" role="alert">
      {children}
    </div>
  );
}
function Loader() {
  return (
    <div className="loading-screen">
      <span className="loading-mark">W</span>
      <h2>작업실을 준비하고 있어요.</h2>
      <p>워크스페이스와 콘텐츠를 연결합니다.</p>
    </div>
  );
}
function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="studio-empty">
      <span>
        <Icon name="Doc" size={26} />
      </span>
      <h3>{title}</h3>
      <p>{note}</p>
      <Link to="/compose" className="button-primary">
        새 글 작성하기
      </Link>
    </div>
  );
}
export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState("");
  const [sites, setSites] = useState<SiteData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api("auth/session")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [w, o] = await Promise.all([
        api<{ workspaces: Workspace[]; active_id: string }>("workspaces"),
        api<{ sites: SiteData[] }>("overview"),
      ]);
      setWorkspaces(w.workspaces);
      setActiveId(w.active_id);
      setSites(o.sites);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (authed) void refresh();
  }, [authed, refresh]);
  const choose = async (id: string) => {
    await api("workspaces/active", {
      method: "POST",
      body: JSON.stringify({ site_id: id }),
    });
    setActiveId(id);
    setError("");
  };
  const logout = async () => {
    await api("auth/logout", { method: "POST", body: "{}" });
    setAuthed(false);
    setSites([]);
  };
  const active =
    workspaces.find((w) => w.site_id === activeId) ?? workspaces[0];
  if (authed === null) return <Loader />;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  if (!active)
    return (
      <div className="loading-screen">
        {error ? (
          <>
            <Notice>{error}</Notice>
            <button
              className="button-primary mt-4"
              onClick={() => void refresh()}
            >
              다시 연결하기
            </button>
          </>
        ) : (
          <Loader />
        )}
      </div>
    );
  return (
    <StoreContext.Provider
      value={{
        workspaces,
        active,
        sites,
        loading,
        error,
        refresh,
        choose,
        logout,
      }}
    >
      <Shell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/compose" element={<Composer key={active.site_id} />} />
          <Route path="/content" element={<ContentPage />} />
          <Route path="/topics" element={<Topics key={active.site_id} />} />
          <Route path="/workspaces" element={<Workspaces />} />
          <Route path="/flow" element={<Flow />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/queue" element={<Navigate to="/content" replace />} />
          <Route path="/pipeline" element={<Navigate to="/flow" replace />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </StoreContext.Provider>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <section className="login-story">
        <div className="login-brand">
          <span>W</span> Workboard
        </div>
        <div>
          <div className="eyebrow">YOUR WORDS. YOUR WORLD.</div>
          <h1>
            좋은 이야기는
            <br />
            좋은 작업실에서.
          </h1>
          <p>
            내 블로그, 각자의 독자.
            <br />
            아이디어부터 게시까지 한곳에서 준비하세요.
          </p>
          <div className="login-illustration" aria-hidden="true">
            <div className="illustration-card">
              <span />
              <b>한 편의 좋은 글</b>
              <i />
              <i />
              <i />
              <div>
                <em>EN</em>
                <em>JA</em>
                <em>Publish</em>
              </div>
            </div>
            <div className="illustration-note">
              <Icon name="Check" /> Ready for your readers
            </div>
          </div>
        </div>
        <small>blog-agent-workboard · Cloudflare Pages</small>
      </section>
      <section className="login-form-area">
        <form onSubmit={submit} className="login-form">
          <div className="eyebrow">WELCOME BACK</div>
          <h2>내 블로그 작업실로.</h2>
          <p>기존 대시보드 비밀번호로 로그인하세요.</p>
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {error && <Notice>{error}</Notice>}
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? "연결 중…" : "작업실 열기"}
            <Icon name="Chevron" />
          </button>
          <small>블로그 운영자를 위한 비공개 작업 공간입니다.</small>
        </form>
      </section>
    </div>
  );
}
const PRIMARY: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "운영 홈", icon: "Home" },
  { to: "/compose", label: "새 글 작성", icon: "Edit" },
  { to: "/content", label: "콘텐츠 현황", icon: "Doc" },
  { to: "/topics", label: "아이디어 노트", icon: "Sparkle" },
  { to: "/flow", label: "발행 흐름", icon: "Flow" },
];
const SECONDARY: { to: string; label: string; icon: IconName }[] = [
  { to: "/workspaces", label: "워크스페이스", icon: "Layers" },
  { to: "/reports", label: "운영 리포트", icon: "Chart" },
  { to: "/settings", label: "연결 설정", icon: "Settings" },
];
function Shell({ children }: { children: React.ReactNode }) {
  const { active, loading, refresh, logout, error } = useStore();
  const [mobile, setMobile] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMobile(false);
    window.scrollTo(0, 0);
  }, [location.pathname, active.site_id]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobile(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);
  const title =
    [...PRIMARY, ...SECONDARY].find((n) => n.to === location.pathname)?.label ??
    "Workboard";
  const links = (items: typeof PRIMARY) =>
    items.map((n) => (
      <NavLink
        key={n.to}
        to={n.to}
        end={n.to === "/"}
        className={({ isActive }) =>
          `studio-nav-link ${isActive ? "selected" : ""}`
        }
      >
        <Icon name={n.icon} size={18} />
        <span>{n.label}</span>
        {n.to === "/compose" && <span className="nav-plus">＋</span>}
      </NavLink>
    ));
  return (
    <div className="studio-shell">
      <a href="#main-content" className="skip-link">
        본문으로 건너뛰기
      </a>
      {mobile && (
        <button
          className="studio-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`studio-sidebar ${mobile ? "mobile-open" : ""}`}>
        <Link to="/" className="studio-brand">
          <span className="brand-mark workboard-mark">W</span>
          <span>
            <strong>Workboard</strong>
            <small>더 좋은 글, 더 쉬운 운영</small>
          </span>
        </Link>
        <div className="sidebar-label">WORKSPACE</div>
        <WorkspacePicker />
        <nav aria-label="주 메뉴">
          <div className="sidebar-label mt-8">글 운영</div>
          {links(PRIMARY)}
          <div className="sidebar-label mt-7">관리</div>
          {links(SECONDARY)}
        </nav>
        <div className="sidebar-bottom">
          <span className="operator-avatar">J</span>
          <div>
            <strong>내 콘텐츠 작업실</strong>
            <small>{active.name}</small>
          </div>
          <button
            title="로그아웃"
            aria-label="로그아웃"
            onClick={() => void logout()}
          >
            <Icon name="External" />
          </button>
        </div>
      </aside>
      <div className="studio-main">
        <header className="studio-topbar">
          <button
            className="mobile-menu-button"
            aria-label="메뉴 열기"
            onClick={() => setMobile(true)}
            aria-expanded={mobile}
          >
            <Icon name="Menu" size={20} />
          </button>
          <div className="topbar-crumb">
            <span>{active.name}</span>
            <Icon name="Chevron" size={12} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className={`refresh-control ${loading ? "spinning" : ""}`}
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="콘텐츠 새로고침"
            >
              <Icon name="Clock" size={15} />
            </button>
            <span className="topbar-language">
              {active.languages.map((l) => l.toUpperCase()).join(" / ")}
            </span>
            <Link to="/compose" className="button-primary compact">
              <Icon name="Plus" size={15} /> 새 글
            </Link>
          </div>
        </header>
        <main id="main-content" className="studio-content">
          {error && <Notice>{error}</Notice>}
          {children}
        </main>
        <footer className="studio-footer">
          blog-agent-workboard <span>아이디어에서 게시까지, 한곳에서.</span>
        </footer>
      </div>
    </div>
  );
}
function WorkspacePicker() {
  const { active, workspaces, choose } = useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const look = workspaceLook(active.site_id);
  async function select(id: string) {
    setBusy(true);
    setError("");
    try {
      await choose(id);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace-picker" ref={ref}>
      <button
        className="workspace-picker-trigger"
        aria-expanded={open}
        aria-controls="workspace-options"
        disabled={busy}
        onClick={() => setOpen((x) => !x)}
      >
        <span className="workspace-avatar" style={{ background: look.color }}>
          {look.initials}
        </span>
        <span className="min-w-0 flex-1 text-left">
          <strong className="block truncate">{active.name}</strong>
          <small>
            {busy ? "전환 중…" : `${workspaces.length}개 사이트 · 전환하기`}
          </small>
        </span>
        <Icon name="ChevronD" size={14} />
      </button>
      {open && (
        <div className="workspace-options" id="workspace-options">
          <div className="picker-caption">작업할 사이트 선택</div>
          {workspaces.map((w) => (
            <button
              key={w.site_id}
              onClick={() => void select(w.site_id)}
              aria-pressed={active.site_id === w.site_id}
              disabled={busy}
            >
              <span
                className="workspace-avatar small"
                style={{ background: workspaceLook(w.site_id).color }}
              >
                {workspaceLook(w.site_id).initials}
              </span>
              <span className="flex-1 text-left">
                <strong>{w.name}</strong>
                <small>
                  {w.languages.map((l) => l.toUpperCase()).join(" · ")}
                </small>
              </span>
              {active.site_id === w.site_id && <Icon name="Check" size={14} />}
            </button>
          ))}
          <Link
            to="/workspaces"
            onClick={() => setOpen(false)}
            className="picker-manage"
          >
            <Icon name="Layers" size={13} /> 전체 워크스페이스 관리
          </Link>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
function WorkspaceCards() {
  const { workspaces, sites, active, choose } = useStore();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function select(id: string) {
    setBusy(id);
    setError("");
    try {
      await choose(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="workspace-card-grid">
        {workspaces.map((w) => {
          const look = workspaceLook(w.site_id);
          const d = sites.find((s) => s.site_id === w.site_id);
          const count =
            d && !d.error
              ? d.posts.filter((p) => p.status === "published").length
              : null;
          const drafts =
            w.integration === "blogger" || !d || d.error
              ? null
              : d.posts.filter((p) => p.status === "draft").length;
          return (
            <button
              key={w.site_id}
              onClick={() => void select(w.site_id)}
              aria-pressed={active.site_id === w.site_id}
              disabled={!!busy}
              className={`workspace-card ${active.site_id === w.site_id ? "current" : ""}`}
              style={{ "--workspace-color": look.color } as CSSProperties}
            >
              <div className="flex justify-between items-center">
                <span
                  className="workspace-logo"
                  style={{ background: look.soft, color: look.color }}
                >
                  {look.initials}
                </span>
                {active.site_id === w.site_id ? (
                  <span className="status-pill green">
                    <Icon name="Check" size={11} /> 선택됨
                  </span>
                ) : (
                  <Icon name="Chevron" />
                )}
              </div>
              <h3>{w.name}</h3>
              <p>{w.site_url.replace("https://", "")}</p>
              <div className="workspace-card-language">
                {w.languages.map((l) => (
                  <span key={l}>{LANGUAGE_LABEL[l] ?? l}</span>
                ))}
              </div>
              <div className="workspace-card-stats">
                <span>
                  <b>{count ?? "—"}</b> 게시
                </span>
                <span>
                  <b>{drafts ?? "—"}</b> 초안
                </span>
                <small>
                  {busy === w.site_id
                    ? "전환 중…"
                    : w.integration === "blogger"
                      ? "Blogger · Cloudflare"
                      : d?.error
                        ? "연결 확인 필요"
                        : "사이트 연결"}
                </small>
              </div>
            </button>
          );
        })}
      </div>
      {error && <Notice>{error}</Notice>}
    </>
  );
}
function Heading({
  eyebrow,
  title,
  note,
  action,
}: {
  eyebrow: string;
  title: string;
  note: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="overview-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{note}</p>
      </div>
      {action}
    </header>
  );
}
function SectionHeading({
  title,
  note,
  link,
}: {
  title: string;
  note?: string;
  link?: { to: string; label: string };
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </div>
      {link && (
        <Link to={link.to}>
          {link.label}
          <Icon name="Chevron" size={12} />
        </Link>
      )}
    </div>
  );
}
function Workflow() {
  const { active } = useStore();
  return (
    <div className="workflow-guide">
      {[
        ["01", "아이디어 정리", "독자와 주제를 정해요.", "Sparkle"],
        [
          "02",
          "초안 작성",
          active.integration === "blogger"
            ? "영어·일본어를 각각 준비해요."
            : "AI와 함께 초안을 다듬어요.",
          "Edit",
        ],
        ["03", "내용 검토", "출처·이미지·표현을 확인해요.", "Check"],
        [
          "04",
          "게시 완료",
          active.integration === "blogger"
            ? "Cloudflare에서 정기 발행해요."
            : "검증 후 예약 발행해요.",
          "Send",
        ],
      ].map(([n, title, note, icon], i) => (
        <div className="workflow-step" key={n}>
          <span className="workflow-step-icon">
            <Icon name={icon as IconName} size={18} />
          </span>
          <small>STEP {n}</small>
          <h3>{title}</h3>
          <p>{note}</p>
          {i === 0 && (
            <Link to="/compose">
              시작하기 <Icon name="Chevron" size={11} />
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
function Home() {
  const { active, sites, loading } = useStore();
  const data = sites.find((s) => s.site_id === active.site_id);
  const posts = data?.posts ?? [];
  const online = !!data && !data.error;
  const published = posts.filter((p) => p.status === "published").length;
  const drafts = posts.filter((p) => p.status === "draft").length;
  const scheduled = posts.filter((p) => p.status === "scheduled").length;
  const look = workspaceLook(active.site_id);
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const end = Date.now() - (7 - i) * 7 * 86400000;
    const start = end - 7 * 86400000;
    return {
      label: new Date(start).toLocaleDateString("ko-KR", {
        month: "numeric",
        day: "numeric",
        timeZone: "Asia/Seoul",
      }),
      count: posts.filter(
        (p) =>
          Date.parse(p.createdAt) >= start && Date.parse(p.createdAt) < end,
      ).length,
    };
  });
  const max = Math.max(1, ...weeks.map((w) => w.count));
  return (
    <div className="studio-page animate-enter">
      <Heading
        eyebrow="YOUR PUBLISHING WORKSPACE"
        title="오늘도, 좋은 글 한 편."
        note={`${active.name}의 콘텐츠를 준비하고 운영 현황을 확인하세요.`}
        action={
          <Link to="/compose" className="button-primary">
            <Icon name="Plus" size={17} /> 새 글 작성
          </Link>
        }
      />
      <div className="active-workspace-banner">
        <div
          className="workspace-logo"
          style={{ color: look.color, background: look.soft }}
        >
          {look.initials}
        </div>
        <div>
          <strong>{active.name}</strong>
          <span>{active.description}</span>
        </div>
        <span className={`status-pill ${online ? "green" : "amber"}`}>
          {loading ? "연결 중…" : online ? "콘텐츠 연결됨" : "연결 확인 필요"}
        </span>
        <a
          href={active.site_url}
          target="_blank"
          rel="noopener noreferrer"
          className="banner-link"
        >
          사이트 보기 <Icon name="External" size={13} />
        </a>
      </div>
      {data?.error && <Notice>{data.error}</Notice>}
      <section className="studio-metrics">
        {[
          {
            label: "게시된 글",
            value: online ? published : "—",
            note: "독자에게 공개된 콘텐츠",
            icon: "Globe",
            tone: "green",
          },
          {
            label: "검토할 초안",
            value:
              active.integration === "blogger" ? "—" : online ? drafts : "—",
            note:
              active.integration === "blogger"
                ? "Blogger에서 임시보관 확인"
                : "다음 게시를 기다리는 글",
            icon: "Edit",
            tone: "amber",
          },
          {
            label: "예약된 글",
            value:
              active.integration === "blogger" ? "—" : online ? scheduled : "—",
            note:
              active.integration === "blogger"
                ? "발행 흐름에서 확인"
                : "일정에 맞춰 준비된 콘텐츠",
            icon: "Clock",
            tone: "blue",
          },
          {
            label: "작성 언어",
            value: active.languages.length,
            note: active.languages.map((l) => l.toUpperCase()).join(" · "),
            icon: "Book",
            tone: "violet",
          },
        ].map((m) => (
          <article className="studio-metric" key={m.label}>
            <div>
              <span>{m.label}</span>
              <span className={`metric-icon ${m.tone}`}>
                <Icon name={m.icon as IconName} size={18} />
              </span>
            </div>
            <strong>{m.value}</strong>
            <small>{m.note}</small>
          </article>
        ))}
      </section>
      <section className="overview-split">
        <article className="studio-panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>콘텐츠가 쌓이는 시간</h2>
              <p>최근 8주간 등록한 글</p>
            </div>
            <span className="subtle-pill">{active.name}</span>
          </div>
          <div
            className="activity-chart"
            role="img"
            aria-label={weeks.map((w) => `${w.label}: ${w.count}개`).join(", ")}
          >
            {weeks.map((w) => (
              <div className="activity-column" key={w.label}>
                <span>{online ? w.count : "—"}</span>
                <div className="activity-bar-track">
                  <div
                    style={{
                      height: `${Math.max(4, (w.count / max) * 100)}%`,
                      opacity: w.count ? 1 : 0.25,
                    }}
                  />
                </div>
                <small>{w.label}</small>
              </div>
            ))}
          </div>
        </article>
        <article className="studio-panel next-action-panel">
          <div className="eyebrow">NEXT STEP</div>
          <h2>
            {drafts
              ? "기다리는 초안이 있어요."
              : "다음 콘텐츠를 시작해 볼까요?"}
          </h2>
          <p>
            {drafts
              ? `${drafts}개 초안의 내용과 출처를 확인하고 다음 글을 게시하세요.`
              : "독자가 궁금해할 주제를 정하면 AI가 초안 작성을 도와드려요."}
          </p>
          <Link
            to={drafts ? "/content" : "/compose"}
            className="button-primary"
          >
            {drafts ? "초안 확인하기" : "글 작성하기"}
            <Icon name="Chevron" size={14} />
          </Link>
          <div className="action-detail">
            <Icon name="Check" size={15} /> 초안을 먼저 저장하고, 검토 후
            게시합니다.
          </div>
        </article>
      </section>
      <section>
        <SectionHeading
          title="내 워크스페이스"
          note="사이트를 선택하면 작업 공간이 함께 바뀝니다."
          link={{ to: "/workspaces", label: "전체 관리" }}
        />
        <WorkspaceCards />
      </section>
      <section className="studio-panel">
        <div className="panel-heading">
          <div>
            <h2>최근 콘텐츠</h2>
            <p>{data?.warning ?? "현재 작업 공간의 최근 글"}</p>
          </div>
          <Link to="/content" className="text-link">
            모두 보기 <Icon name="Chevron" size={12} />
          </Link>
        </div>
        <ContentTable posts={posts} limit={5} />
      </section>
      <section>
        <SectionHeading
          title="게시까지, 네 단계"
          note="무엇을 해야 할지 매 단계에서 확인하세요."
        />
        <Workflow />
      </section>
    </div>
  );
}
function ContentTable({ posts, limit }: { posts: Post[]; limit?: number }) {
  const { active } = useStore();
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const filtered = posts.filter(
    (p) =>
      (tab === "all" || p.status === tab) &&
      `${p.title} ${p.categoryId}`.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = limit ? filtered.slice(0, limit) : filtered;
  return (
    <div className="content-list">
      <div className="content-list-tools">
        <div className="segmented-tabs" aria-label="게시물 상태 필터">
          {[
            ["all", "전체"],
            ["draft", "초안"],
            ["published", "게시"],
            ["scheduled", "예약"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={tab === id ? "selected" : ""}
            >
              {label}
              <span>
                {posts.filter((p) => id === "all" || p.status === id).length}
              </span>
            </button>
          ))}
        </div>
        <label className="search-field">
          <Icon name="Search" size={15} />
          <input
            aria-label="글 제목 검색"
            placeholder="글 제목 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {visible.length ? (
        <div className="content-table-scroll">
          <table className="content-table">
            <thead>
              <tr>
                <th>콘텐츠</th>
                <th>언어</th>
                <th>상태</th>
                <th>등록일</th>
                <th>
                  <span className="sr-only">작업</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.title}</strong>
                    <small>{p.categoryId || "미분류"}</small>
                  </td>
                  <td>
                    <span className="language-tag">
                      {p.canonicalLang?.toUpperCase() ?? "EN"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`status-pill ${p.status === "published" ? "green" : p.status === "scheduled" ? "amber" : "neutral"}`}
                    >
                      {
                        {
                          published: "게시 완료",
                          draft: "초안",
                          scheduled: "예약",
                          archived: "보관",
                        }[p.status]
                      }
                    </span>
                  </td>
                  <td>
                    {p.createdAt
                      ? new Date(p.createdAt).toLocaleDateString("ko-KR", {
                          timeZone: "Asia/Seoul",
                          month: "short",
                          day: "numeric",
                        })
                      : "—"}
                  </td>
                  <td>
                    <a
                      href={p.url ?? active.admin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${p.title} 확인`}
                    >
                      <Icon name="External" size={15} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={search ? "검색 결과가 없습니다" : "아직 표시할 글이 없습니다"}
          note={
            search
              ? "다른 검색어나 상태를 선택해 보세요."
              : "새 글을 작성해 첫 콘텐츠를 준비해 보세요."
          }
        />
      )}
    </div>
  );
}
function ContentPage() {
  const { active, sites } = useStore();
  const data = sites.find((s) => s.site_id === active.site_id);
  return (
    <div className="studio-page animate-enter">
      <Heading
        eyebrow="CONTENT LIBRARY"
        title={`${active.name}의 콘텐츠`}
        note="초안부터 게시된 글까지, 상태별로 확인하세요."
        action={
          <Link to="/compose" className="button-primary">
            <Icon name="Plus" /> 새 글 작성
          </Link>
        }
      />
      {data?.error && <Notice>{data.error}</Notice>}
      <section className="studio-panel">
        <div className="panel-heading">
          <div>
            <h2>
              콘텐츠 목록{" "}
              <span className="subtle-pill">{data?.posts.length ?? 0}</span>
            </h2>
            <p>{data?.warning ?? "선택한 사이트의 실제 게시 현황"}</p>
          </div>
          <a
            href={active.admin_url}
            className="button-secondary"
            target="_blank"
            rel="noopener noreferrer"
          >
            관리자 열기 <Icon name="External" size={13} />
          </a>
        </div>
        <ContentTable key={active.site_id} posts={data?.posts ?? []} />
      </section>
    </div>
  );
}
function Workspaces() {
  const store = useStore();
  return <WorkspaceManager {...store} />;
}
const emptyArticle = (): Article => ({
  title: "",
  meta_description: "",
  tags: [],
  content_md: "",
  source_notes: "",
});
function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}
function Composer() {
  const { active, refresh } = useStore();
  const [topic, setTopic] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState(active.categories[0]);
  const [lang, setLang] = useState(active.languages[0]);
  const [articles, setArticles] = useState<Record<string, Article>>(() =>
    Object.fromEntries(active.languages.map((l) => [l, emptyArticle()])),
  );
  const [image, setImage] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState("");
  const [previewOn, setPreviewOn] = useState(false);
  const [saved, setSaved] = useState<{
    admin_url: string;
    message: string;
  } | null>(null);
  const requestId = useRef("");
  const [scores, setScores] = useState<Record<
    string,
    { score: number; issues: string[]; passed: boolean }
  > | null>(null);
  const [publishAt, setPublishAt] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const storageKey = `workboard:draft:${active.site_id}`;
  const editingJob = new URLSearchParams(location.search).get("job");
  useEffect(() => {
    try {
      const query = new URLSearchParams(location.search);
      const job = query.get("job");
      if (job) {
        void api<{
          jobs: { id: string; request_json: string; publish_at: string }[];
        }>(`automation?site_id=${active.site_id}`)
          .then((r) => {
            const row = r.jobs.find((j) => j.id === job);
            if (!row) throw Error("예약 초안을 찾지 못했습니다.");
            const d = JSON.parse(row.request_json) as DraftInput;
            setTopic(d.translations[active.languages[0]].title);
            setSlug(d.slug);
            setCategory(d.category);
            setArticles(d.translations);
            setImage(d.featured_image_url ?? "");
            setPublishAt(row.publish_at ?? "");
            setNotice("예약 초안을 불러왔습니다. 보완 후 다시 검토해 주세요.");
          })
          .catch((e) => setError(e.message));
        return;
      }
      const t = query.get("topic");
      if (t) {
        setTopic(t);
        setSlug(slugify(t));
        const c = query.get("category");
        if (c && active.categories.includes(c)) setCategory(c);
        return;
      }
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const d = JSON.parse(raw);
        setTopic(d.topic ?? "");
        setSlug(d.slug ?? "");
        setCategory(
          active.categories.includes(d.category)
            ? d.category
            : active.categories[0],
        );
        setArticles(
          Object.fromEntries(
            active.languages.map((l) => [
              l,
              { ...emptyArticle(), ...d.articles?.[l] },
            ]),
          ),
        );
        setImage(d.image ?? "");
        setNotice("이 작업 공간에 임시 저장한 글을 불러왔습니다.");
      }
    } catch {
      setNotice("임시 저장한 글을 불러오지 못했습니다.");
    }
  }, [active.site_id, storageKey, location.search]);
  function dirty() {
    requestId.current = "";
    setSaved(null);
    setReviewed(false);
    setNotice("");
  }
  function update(field: keyof Article, value: string | string[]) {
    dirty();
    setArticles((v) => ({ ...v, [lang]: { ...v[lang], [field]: value } }));
    setPreview("");
  }
  async function aiDraft() {
    setBusy("ai");
    setError("");
    setNotice("");
    try {
      const r = await api<{
        translations: Record<string, Article>;
        cost_usd: number;
      }>("content/generate", {
        method: "POST",
        body: JSON.stringify({
          site_id: active.site_id,
          slug,
          category,
          topic,
          research: Object.fromEntries(
            active.languages.map((l) => [l, articles[l].source_notes ?? ""]),
          ),
        }),
      });
      setArticles(r.translations);
      setScores(
        (r as unknown as { quality: NonNullable<typeof scores> }).quality,
      );
      setReviewed(false);
      requestId.current = "";
      setNotice(
        `AI 초안을 준비했습니다. 출처와 내용을 검토해 주세요. · $${r.cost_usd.toFixed(4)}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function localSave() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ topic, slug, category, articles, image }),
      );
      setNotice("이 브라우저에 임시 저장했습니다.");
    } catch {
      setError("브라우저 임시 저장 공간을 확인해 주세요.");
    }
  }
  async function showPreview() {
    setPreviewOn(true);
    setBusy("preview");
    setError("");
    try {
      const r = await api<{ html: string }>("content/preview", {
        method: "POST",
        body: JSON.stringify({ markdown: articles[lang].content_md }),
      });
      setPreview(r.html);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function submit() {
    setBusy("save");
    setError("");
    setNotice("");
    if (!requestId.current) requestId.current = crypto.randomUUID();
    const input: DraftInput = {
      request_id: requestId.current,
      site_id: active.site_id,
      slug,
      category,
      translations: articles,
      featured_image_url: image,
      reviewed,
    };
    try {
      const r = await api<{
        mode: string;
        bundle?: unknown;
        admin_url?: string;
        message?: string;
      }>("content/draft", { method: "POST", body: JSON.stringify(input) });
      if (r.mode === "export") {
        const blob = new Blob([JSON.stringify(r.bundle, null, 2)], {
          type: "application/json",
        });
        const u = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = u;
        a.download = `${active.site_id}-${slug}.json`;
        a.click();
        URL.revokeObjectURL(u);
        setNotice(
          "전달 파일을 만들었습니다. 기존 브릿지에서 이미지와 게시 일정을 완성하세요.",
        );
      } else {
        setSaved({
          admin_url: r.admin_url ?? active.admin_url,
          message: r.message ?? "초안을 저장했습니다.",
        });
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* The remote draft was saved even if browser storage is unavailable. */
        }
        void refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function currentDraft(): DraftInput {
    return {
      request_id: requestId.current || crypto.randomUUID(),
      site_id: active.site_id,
      slug,
      category,
      translations: articles,
      featured_image_url: image,
      reviewed,
    };
  }
  async function inspect() {
    setBusy("quality");
    setError("");
    try {
      const r = await api<{ quality: NonNullable<typeof scores> }>(
        "content/quality",
        { method: "POST", body: JSON.stringify(currentDraft()) },
      );
      setScores(r.quality);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function schedule() {
    setBusy("schedule");
    setError("");
    try {
      const input = currentDraft();
      const r = await api<{
        status: string;
        quality: NonNullable<typeof scores>;
      }>(editingJob ? "jobs/update" : "content/schedule", {
        method: "POST",
        body: JSON.stringify(
          editingJob
            ? {
                id: editingJob,
                input,
                publish_at:
                  publishAt || new Date(Date.now() + 3600000).toISOString(),
              }
            : { ...input, publish_at: publishAt || undefined },
        ),
      });
      setScores(r.quality);
      setNotice(
        r.status === "ready"
          ? "검증을 통과해 발행 큐에 등록했습니다."
          : "보완할 항목이 있어 검토 대기로 저장했습니다. 발행 흐름에서 이어서 수정하세요.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function collect() {
    setBusy("research");
    setError("");
    try {
      const r = await api<{ research: Record<string, string> }>(
        "strategy/research",
        {
          method: "POST",
          body: JSON.stringify({
            site_id: active.site_id,
            title: topic,
            category,
          }),
        },
      );
      setArticles((v) =>
        Object.fromEntries(
          active.languages.map((l) => [
            l,
            { ...v[l], source_notes: r.research[l] },
          ]),
        ),
      );
      setNotice(
        "공식 출처를 언어별로 독립 조사했습니다. AI 초안을 준비할 수 있습니다.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const ready =
    active.languages.every(
      (l) =>
        articles[l]?.title.trim() &&
        articles[l]?.content_md.trim().length >= 40,
    ) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
  return (
    <div className="studio-page animate-enter">
      <Heading
        eyebrow="WRITE SOMETHING WORTH READING"
        title="다음 이야기를 준비해요."
        note={`${active.name} · ${active.languages.map((l) => LANGUAGE_LABEL[l] ?? l).join(" + ")}로 작성합니다.`}
        action={
          <button className="button-secondary" onClick={localSave}>
            <Icon name="Doc" size={14} /> 임시 저장
          </button>
        }
      />
      {error && <Notice>{error}</Notice>}
      {notice && (
        <div className="success-notice" role="status">
          <Icon name="Check" /> {notice}
        </div>
      )}
      {saved && (
        <div className="saved-result" role="status">
          <span>
            <Icon name="Check" size={24} />
          </span>
          <div>
            <h2>{saved.message}</h2>
            <p>관리자 화면에서 이미지와 내용을 확인한 뒤 게시하세요.</p>
          </div>
          <a
            href={saved.admin_url}
            target="_blank"
            rel="noopener noreferrer"
            className="button-primary"
          >
            초안 확인 <Icon name="External" size={14} />
          </a>
        </div>
      )}
      <div className="composer-layout">
        <div className="composer-main">
          <section className="studio-panel">
            <div className="panel-heading">
              <div>
                <h2>
                  <span className="step-number">01</span> 주제와 독자
                </h2>
                <p>작성 방향과 확인한 자료를 먼저 정리하세요.</p>
              </div>
            </div>
            <div className="form-body">
              <label className="field-label">
                이번 글의 주제
                <input
                  placeholder="예: 서울에서 처음 장보는 여행자를 위한 가이드"
                  value={topic}
                  onChange={(e) => {
                    dirty();
                    setTopic(e.target.value);
                  }}
                  onBlur={() => {
                    if (!slug) setSlug(slugify(topic));
                  }}
                  maxLength={300}
                />
              </label>
              <div className="form-row">
                <label className="field-label">
                  카테고리
                  <select
                    value={category}
                    onChange={(e) => {
                      dirty();
                      setCategory(e.target.value);
                    }}
                  >
                    {active.categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  글 주소
                  <input
                    placeholder="seoul-shopping-guide"
                    value={slug}
                    onChange={(e) => {
                      dirty();
                      setSlug(e.target.value.toLowerCase());
                    }}
                    maxLength={100}
                  />
                  <small>영문 소문자·숫자·하이픈을 사용하세요.</small>
                </label>
              </div>
              {active.languages.map((l) => (
                <label className="field-label" key={l}>
                  {LANGUAGE_LABEL[l] ?? l} 독자를 위한 출처 메모
                  <textarea
                    rows={3}
                    placeholder={
                      l === "ja"
                        ? "일본어 독자에 맞춰 확인한 사실과 공식 출처 URL을 적어 주세요."
                        : "확인한 사실, 확인 날짜, 공식 출처 URL을 적어 주세요."
                    }
                    value={articles[l]?.source_notes ?? ""}
                    onChange={(e) => {
                      dirty();
                      setArticles((v) => ({
                        ...v,
                        [l]: { ...v[l], source_notes: e.target.value },
                      }));
                    }}
                    maxLength={10000}
                  />
                </label>
              ))}
              <div className="ai-action-row">
                <button
                  className="button-secondary"
                  disabled={!!busy || !topic.trim()}
                  onClick={() => void collect()}
                >
                  {busy === "research" ? "공식 자료 조사 중…" : "SEO 출처 조사"}
                </button>
                <button
                  className="button-primary"
                  onClick={() => void aiDraft()}
                  disabled={!!busy || !topic.trim() || !slug}
                >
                  <Icon name="Sparkle" size={16} />
                  {busy === "ai"
                    ? "AI가 초안을 작성하고 있어요…"
                    : "AI로 초안 준비"}
                </button>
                <small>
                  직접 작성해도 좋아요. AI 작성 후에는 반드시 검토하세요.
                </small>
              </div>
            </div>
          </section>
          <section className="studio-panel">
            <div className="panel-heading">
              <div>
                <h2>
                  <span className="step-number">02</span> 본문 작성
                </h2>
                <p>
                  {active.integration === "blogger"
                    ? "영어·일본어를 각각의 독자에게 맞춰 작성하세요."
                    : "읽기 쉽게 다듬고, 필요한 정보를 빠짐없이 담으세요."}
                </p>
              </div>
              <div className="segmented-tabs">
                {active.languages.map((l) => (
                  <button
                    key={l}
                    aria-pressed={lang === l}
                    className={lang === l ? "selected" : ""}
                    onClick={() => {
                      setLang(l);
                      setPreviewOn(false);
                    }}
                  >
                    {l.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-body">
              <label className="field-label">
                {LANGUAGE_LABEL[lang]} 제목
                <input
                  value={articles[lang].title}
                  onChange={(e) => update("title", e.target.value)}
                  placeholder={
                    lang === "ja"
                      ? "日本語の記事タイトル"
                      : "A clear, reader-focused title"
                  }
                  maxLength={200}
                />
              </label>
              <label className="field-label">
                검색 설명
                <textarea
                  rows={2}
                  value={articles[lang].meta_description}
                  onChange={(e) => update("meta_description", e.target.value)}
                  maxLength={300}
                  placeholder="독자가 이 글에서 얻을 정보를 짧게 적어 주세요."
                />
              </label>
              <div className="editor-toolbar">
                <span>
                  본문 <small>Markdown 지원</small>
                </span>
                <div>
                  <button
                    className={!previewOn ? "active" : ""}
                    onClick={() => setPreviewOn(false)}
                  >
                    작성
                  </button>
                  <button
                    className={previewOn ? "active" : ""}
                    onClick={() => void showPreview()}
                  >
                    미리보기
                  </button>
                </div>
              </div>
              {previewOn ? (
                <article
                  className="preview-prose"
                  lang={lang}
                  dangerouslySetInnerHTML={{
                    __html: preview || "<p>미리보기를 준비합니다.</p>",
                  }}
                />
              ) : (
                <textarea
                  className="article-editor"
                  aria-label={`${LANGUAGE_LABEL[lang]} 본문`}
                  rows={18}
                  value={articles[lang].content_md}
                  onChange={(e) => update("content_md", e.target.value)}
                  placeholder="## 소제목

본문을 작성하세요. 출처 링크와 FAQ를 함께 넣으면 좋아요."
                  maxLength={60000}
                />
              )}
              <div className="editor-count">
                {articles[lang].content_md.length.toLocaleString()}자 ·{" "}
                {articles[lang].content_md
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean)
                  .length.toLocaleString()}{" "}
                단어
              </div>
              <label className="field-label">
                태그
                <TagField
                  key={lang}
                  value={articles[lang].tags}
                  onChange={(v) => update("tags", v)}
                />
              </label>
            </div>
          </section>
        </div>
        <aside className="composer-aside">
          <section className="studio-panel">
            <div className="panel-heading">
              <div>
                <h2>게시 준비</h2>
                <p>현재 글의 완성도를 확인해요.</p>
              </div>
            </div>
            <div className="form-body">
              <button
                className="button-secondary"
                disabled={!!busy || !ready}
                onClick={() => void inspect()}
              >
                SEO·AEO·GEO 검증
              </button>
              {scores &&
                Object.entries(scores).map(([language, q]) => (
                  <div key={language} className="quality-card">
                    <strong>
                      {language.toUpperCase()} · {q.score}/100
                    </strong>
                    <ul>
                      {q.issues.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              <ul className="readiness-list">
                {active.languages.map((l) => (
                  <li key={l}>
                    <span
                      className={
                        articles[l].title.trim() &&
                        articles[l].content_md.trim().length >= 40
                          ? "done"
                          : ""
                      }
                    >
                      <Icon name="Check" size={11} />
                    </span>
                    {LANGUAGE_LABEL[l]} 제목·본문
                  </li>
                ))}
                <li>
                  <span className={slug ? "done" : ""}>
                    <Icon name="Check" size={11} />
                  </span>
                  글 주소와 카테고리
                </li>
                <li>
                  <span className={reviewed ? "done" : ""}>
                    <Icon name="Check" size={11} />
                  </span>
                  출처와 표현 검토
                </li>
              </ul>
              <label className="field-label">
                대표 이미지 주소
                <input
                  placeholder="https://…"
                  value={image}
                  onChange={(e) => {
                    dirty();
                    setImage(e.target.value);
                  }}
                />
                <small>이미지 사용 권한과 alt 설명을 확인하세요.</small>
              </label>
              <label className="review-checkbox">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                <span>내용과 출처를 검토했습니다.</span>
              </label>
              <button
                className="button-primary w-full"
                disabled={!!busy || !ready || !reviewed}
                onClick={() => void submit()}
              >
                <Icon
                  name={active.integration === "supabase" ? "Doc" : "Send"}
                />
                {busy === "save"
                  ? "준비하는 중…"
                  : active.integration === "supabase"
                    ? "사이트에 초안 저장"
                    : "전달 파일 만들기"}
              </button>
              <label className="field-label">
                예약 시간
                <input
                  type="datetime-local"
                  value={
                    publishAt
                      ? new Date(Date.parse(publishAt) + 9 * 3600000)
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                  onChange={(e) =>
                    setPublishAt(
                      e.target.value
                        ? new Date(e.target.value + "+09:00").toISOString()
                        : "",
                    )
                  }
                />
                <small>한국 시간. 비워 두면 사이트 다음 실행에 맞춥니다.</small>
              </label>
              <button
                className="button-primary w-full"
                disabled={!!busy || !ready || !reviewed}
                onClick={() => void schedule()}
              >
                {busy === "schedule"
                  ? "큐에 저장 중…"
                  : editingJob
                    ? "예약 초안 수정·검증"
                    : "Cloudflare 발행 큐에 등록"}
              </button>
              <p className="save-explanation">
                {active.integration === "supabase"
                  ? "초안으로 저장합니다. 실제 공개는 사이트 관리자에서 진행하세요."
                  : "다른 도구로 가져올 파일을 만듭니다. 이 버튼은 글을 공개하지 않습니다."}
              </p>
            </div>
          </section>
          <section className="writing-tip">
            <Icon name="Book" size={21} />
            <h3>독자의 다음 질문까지.</h3>
            <p>
              소제목은 명확하게, 문단은 짧게. 확인한 출처와 자기완결형 FAQ를
              더해 주세요.
            </p>
            <Link to="/topics">
              아이디어 노트 보기 <Icon name="Chevron" size={12} />
            </Link>
          </section>
          <button
            className="button-secondary w-full"
            onClick={() => navigate("/content")}
          >
            콘텐츠 현황으로
          </button>
        </aside>
      </div>
    </div>
  );
}
function Topics() {
  const { active } = useStore();
  return <StrategyTopics active={active} />;
}
function Flow() {
  const { active } = useStore();
  return <AutomationFlow active={active} />;
}
function Reports() {
  const [data, setData] = useState<{
    runs: {
      id: string;
      article_key: string;
      actual: number | null;
      reserved: number;
      status: string;
      created_at: string;
    }[];
    budget: { reserved: number; actual: number };
    month: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<NonNullable<typeof data>>("reports")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  const actual = data?.budget.actual ?? 0;
  const reserve = data?.budget.reserved ?? 0;
  return (
    <div className="studio-page">
      <Heading
        eyebrow="A CLEAR VIEW OF YOUR WORK"
        title="콘텐츠 운영의 기록."
        note="Workboard에서 실행한 AI 작성과 예산 사용량을 확인하세요."
      />
      {error && <Notice>{error}</Notice>}
      <div className="studio-metrics">
        {[
          {
            label: "이번 달 AI 비용",
            value: `$${actual.toFixed(4)}`,
            note: data?.month ?? "조회 중",
          },
          {
            label: "남은 월 예산",
            value: `$${Math.max(0, 10 - reserve).toFixed(2)}`,
            note: "월 $10 · 예약된 비용 포함",
          },
          {
            label: "최근 AI 실행",
            value: data?.runs.length ?? "—",
            note: "최근 최대 100건",
          },
          {
            label: "완료한 작성",
            value:
              data?.runs.filter((r) => r.status === "complete").length ?? "—",
            note: "Workboard API에서 작성한 초안",
          },
        ].map((m) => (
          <article className="studio-metric" key={m.label}>
            <div>{m.label}</div>
            <strong>{m.value}</strong>
            <small>{m.note}</small>
          </article>
        ))}
      </div>
      <section className="studio-panel">
        <div className="panel-heading">
          <div>
            <h2>AI 작성 이력</h2>
            <p>로컬 브릿지와 aside 자체 비용은 이 기록에 포함되지 않습니다.</p>
          </div>
        </div>
        {data?.runs.length ? (
          <div className="content-table-scroll">
            <table className="content-table">
              <thead>
                <tr>
                  <th>작업</th>
                  <th>상태</th>
                  <th>비용</th>
                  <th>작성일</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.article_key}</strong>
                    </td>
                    <td>
                      <span
                        className={`status-pill ${r.status === "complete" ? "green" : "amber"}`}
                      >
                        {{
                          complete: "완료",
                          running: "작성 중",
                          failed: "실패",
                        }[r.status] ?? r.status}
                      </span>
                    </td>
                    <td>${(r.actual ?? r.reserved).toFixed(4)}</td>
                    <td>
                      {new Date(r.created_at).toLocaleDateString("ko-KR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="아직 AI 작성 이력이 없습니다."
            note="첫 AI 초안을 작성하면 이곳에 비용과 실행 기록이 표시됩니다."
          />
        )}
      </section>
    </div>
  );
}
function Settings() {
  const { workspaces, active } = useStore();
  return <Connections workspaces={workspaces} active={active} />;
}
function TagField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    setText(value.join(", "));
  }, [value]);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onChange(
          text
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 10),
        )
      }
      placeholder="Seoul, Travel, Shopping"
    />
  );
}
