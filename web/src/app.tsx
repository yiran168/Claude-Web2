import {
  type FormEvent,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  Check,
  ChevronRight,
  CircleGauge,
  Cloud,
  Code2,
  Command,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileClock,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Loader2,
  LogIn,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { ApiError, api, copyText, getCsrfToken, setCsrfToken } from "./api";
import type {
  AuditEvent,
  DashboardData,
  GatewayKey,
  ModelAlias,
  OidcConfig,
  OidcPublicConfig,
  RequestLog,
  Session,
  Upstream,
} from "./types";

type ToastKind = "success" | "error" | "info";
interface Toast { id: number; kind: ToastKind; message: string }
type Notify = (message: string, kind?: ToastKind) => void;
const ToastContext = createContext<Notify>(() => undefined);
const useNotify = () => useContext(ToastContext);

const navItems = [
  { to: "/dashboard", label: "总览", icon: LayoutDashboard, hint: "运行状态" },
  { to: "/playground", label: "Playground", icon: MessageSquare, hint: "协议调试" },
  { to: "/keys", label: "API 密钥", icon: KeyRound, hint: "访问控制" },
  { to: "/upstreams", label: "路由与上游", icon: RouteIcon, hint: "健康调度" },
  { to: "/models", label: "模型映射", icon: Layers3, hint: "公共别名" },
  { to: "/requests", label: "请求追踪", icon: Activity, hint: "元数据日志" },
  { to: "/security", label: "安全审计", icon: ShieldCheck, hint: "变更记录" },
  { to: "/settings", label: "系统设置", icon: Settings, hint: "策略与界面" },
];

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("zh-CN", { notation: value && Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value ?? 0);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatUsd(micros: number | null | undefined, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format((micros ?? 0) / 1_000_000);
}

function initials(value: string): string {
  return value.slice(0, 2).toUpperCase();
}

function Button({
  children,
  variant = "primary",
  size = "md",
  loading,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button className={cn("button", `button-${variant}`, `button-${size}`, className)} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 size={15} className="spin" />}
      {children}
    </button>
  );
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={cn("modal", wide && "modal-wide")} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = ["healthy", "completed", "active"].includes(status) ? "good"
    : ["degraded", "unknown", "cancelled"].includes(status) ? "warn"
      : ["cooldown", "error", "revoked"].includes(status) ? "bad" : "neutral";
  const labels: Record<string, string> = {
    healthy: "健康", degraded: "降级", unknown: "待检查", cooldown: "冷却中",
    completed: "完成", error: "失败", cancelled: "已取消", active: "有效", revoked: "已撤销",
  };
  return <span className={cn("status-badge", `status-${normalized}`)}><i />{labels[status] ?? status}</span>;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const oidc = useQuery({
    queryKey: ["oidc-public"],
    queryFn: () => api<OidcPublicConfig>("/api/admin/v1/oidc/public"),
    retry: false,
    staleTime: 60_000,
  });
  const oidcError = new URLSearchParams(window.location.search).get("oidc_error");
  const mutation = useMutation({
    mutationFn: () => api<Session>("/api/admin/v1/session", { method: "POST", body: JSON.stringify({ username, password }) }),
    onSuccess: onLogin,
    onError: (cause) => setError(cause instanceof Error ? cause.message : "登录失败"),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setError(""); mutation.mutate(); };
  return (
    <main className="login-page">
      <div className="login-orb login-orb-one" /><div className="login-orb login-orb-two" />
      <section className="login-brand-panel">
        <div className="brand-lockup brand-lockup-large"><div className="brand-mark"><Sparkles size={23} /></div><div><b>Claude Web2</b><span>Gateway control plane</span></div></div>
        <div className="login-copy">
          <span className="live-pill"><i /> AUTHORIZED UPSTREAMS ONLY</span>
          <h1>一个清晰、克制，<br />却足够强大的 AI 网关。</h1>
          <p>在同一控制面管理双协议、模型映射、凭据池、限流、流式请求与审计。所有上游密钥均加密保存。</p>
        </div>
        <div className="login-security-row"><ShieldCheck size={18} /><span>AES-256-GCM · Argon2id · HttpOnly Session</span></div>
      </section>
      <section className="login-form-panel">
        <form className="login-card" onSubmit={submit}>
          <div className="login-card-heading"><span className="eyebrow">CONTROL ROOM</span><h2>欢迎回来</h2><p>使用初始化时设置的管理员账户登录。</p></div>
          <label className="field"><span>用户名</span><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="field"><span>密码</span><div className="input-with-action"><input type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label="显示或隐藏密码">{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
          {(error || oidcError) && <div className="inline-alert"><TriangleAlert size={16} />{error || `单点登录未完成（${oidcError}）`}</div>}
          <Button type="submit" loading={mutation.isPending} className="login-submit">进入控制台 <ChevronRight size={17} /></Button>
          {oidc.data?.enabled && <>
            <div className="login-divider"><span>或</span></div>
            <a className="button button-secondary login-sso" href="/api/admin/v1/oidc/start"><LogIn size={16} />使用 {oidc.data.providerName} 登录</a>
          </>}
          <p className="login-footnote">会话 Cookie 为 HttpOnly、SameSite=Strict；写操作另需 CSRF 令牌。</p>
        </form>
      </section>
    </main>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQuery(""); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  if (!open) return null;
  const items = navItems.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="command-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="command-panel" role="dialog" aria-modal="true" aria-label="快速跳转">
        <div className="command-search"><Search size={18} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索页面或操作…" /><kbd>ESC</kbd></div>
        <div className="command-results"><span className="command-label">导航</span>{items.map((item) => <button key={item.to} onClick={() => { navigate(item.to); onClose(); }}><item.icon size={18} /><span><b>{item.label}</b><small>{item.hint}</small></span><ChevronRight size={16} /></button>)}</div>
      </div>
    </div>
  );
}

function Shell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("cw2.theme") ?? "dark");
  const location = useLocation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<{ values: Record<string, unknown> }>("/api/admin/v1/settings") });
  const productName = String(settings.data?.values["ui.product_name"] ?? "Claude Web2");
  const compactSidebar = Boolean(settings.data?.values["ui.compact_sidebar"] ?? false);
  const current = navItems.find((item) => location.pathname.startsWith(item.to)) ?? navItems[0]!;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cw2.theme", theme);
  }, [theme]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen((value) => !value); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  return (
    <div className={cn("app-shell", compactSidebar && "compact-sidebar")}>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" />}
      <aside className={cn("sidebar", sidebarOpen && "sidebar-open")}>
        <div className="brand-lockup"><div className="brand-mark"><Sparkles size={19} /></div><div><b>{productName}</b><span>Secure gateway</span></div></div>
        <nav className="sidebar-nav">{navItems.map((item) => <NavLink key={item.to} to={item.to} onClick={() => setSidebarOpen(false)} className={({ isActive }) => cn("nav-item", isActive && "active")}><item.icon size={18} /><span><b>{item.label}</b><small>{item.hint}</small></span></NavLink>)}</nav>
        <div className="sidebar-footer">
          <div className="secure-card"><div><ShieldCheck size={17} /><b>安全模式</b></div><p>仅连接官方或明确授权的上游。</p></div>
          <div className="user-chip"><div className="avatar">{initials(session.username)}</div><div><b>{session.username}</b><small>Administrator</small></div><button onClick={onLogout} aria-label="退出登录"><LogOut size={17} /></button></div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu size={20} /></button><div><span>Control plane</span><b>{current.label}</b></div></div>
          <div className="topbar-actions">
            <button className="command-trigger" aria-label="快速跳转" onClick={() => setCommandOpen(true)}><Search size={16} /><span>快速跳转</span><kbd><Command size={11} />K</kbd></button>
            <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="切换主题">{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
            <span className="topbar-health"><i /> 系统在线</span>
          </div>
        </header>
        <main className="content"><Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/keys" element={<KeysPage />} />
          <Route path="/upstreams" element={<UpstreamsPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes></main>
      </div>
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  );
}

function DashboardPage() {
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api<DashboardData>("/api/admin/v1/dashboard"), refetchInterval: 30_000 });
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<{ items: ModelAlias[] }>("/api/admin/v1/models") });
  const data = dashboard.data;
  const maxRequests = Math.max(1, ...(data?.series.map((point) => point.requests) ?? [1]));
  const healthy = data?.upstreams.filter((item) => item.healthStatus === "healthy").length ?? 0;
  const stats = [
    { label: "24 小时请求", value: formatNumber(data?.requests), meta: `${formatNumber(data?.failures)} 失败 · ${formatNumber(data?.averageLatencyMs)} ms 平均`, icon: Zap, tone: "coral" },
    { label: "Token 总量", value: formatNumber((data?.inputTokens ?? 0) + (data?.outputTokens ?? 0)), meta: `${formatNumber(data?.inputTokens)} 输入 · ${formatNumber(data?.outputTokens)} 输出`, icon: CircleGauge, tone: "amber" },
    { label: "估算成本", value: formatUsd(data?.costMicros, 2), meta: "按模型目录配置单价", icon: Activity, tone: "blue" },
    { label: "健康上游", value: `${healthy}/${data?.upstreams.length ?? 0}`, meta: `${models.data?.items.length ?? 0} 个公开模型`, icon: Cloud, tone: "green" },
  ];
  return (
    <div className="page-stack">
      <PageHeader eyebrow="OBSERVABILITY" title="早上好，网关一切清晰。" description="这里汇总最近 24 小时的流量、延迟、Token 与上游健康状态。" actions={<Button variant="secondary" onClick={() => dashboard.refetch()} loading={dashboard.isFetching}><RefreshCw size={15} /> 刷新</Button>} />
      <section className="stat-grid">{stats.map((stat) => <article className="stat-card" key={stat.label}><div className={cn("stat-icon", `tone-${stat.tone}`)}><stat.icon size={20} /></div><span>{stat.label}</span><strong>{stat.value}</strong><small>{stat.meta}</small></article>)}</section>
      <section className="dashboard-grid">
        <article className="panel traffic-panel">
          <div className="panel-heading"><div><span className="eyebrow">REQUEST VOLUME</span><h2>请求趋势</h2></div><span className="panel-chip">最近 24 小时</span></div>
          <div className="bar-chart" role="img" aria-label="每小时请求量图表">{data?.series.length ? data.series.map((point) => <div className="bar-slot" key={point.hour} title={`${formatDate(point.hour)} · ${point.requests} 请求`}><div className="bar-fill" style={{ height: `${Math.max(5, point.requests / maxRequests * 100)}%` }}><i style={{ height: `${point.requests ? point.failures / point.requests * 100 : 0}%` }} /></div></div>) : Array.from({ length: 24 }, (_, index) => <div className="bar-slot empty" key={index}><div className="bar-fill" style={{ height: `${8 + (index % 5) * 4}%` }} /></div>)}</div>
          <div className="chart-axis"><span>24h 前</span><span>12h 前</span><span>现在</span></div>
        </article>
        <article className="panel upstream-mini-panel">
          <div className="panel-heading"><div><span className="eyebrow">UPSTREAM PULSE</span><h2>上游状态</h2></div><NavLink className="text-link" to="/upstreams">管理 <ChevronRight size={14} /></NavLink></div>
          <div className="upstream-mini-list">{data?.upstreams.length ? data.upstreams.slice(0, 5).map((upstream) => <div className="upstream-mini" key={upstream.id}><div className="provider-logo">{upstream.kind === "anthropic" ? "A" : "C"}</div><div><b>{upstream.name}</b><small>P{upstream.priority} · W{upstream.weight} · {upstream.maxConcurrency} 并发</small></div><StatusBadge status={upstream.healthStatus} /></div>) : <EmptyState icon={<Cloud size={22} />} title="还没有上游" description="先添加一个官方 Anthropic API 凭据。" action={<NavLink to="/upstreams" className="button button-primary button-sm"><Plus size={14} />添加上游</NavLink>} />}</div>
        </article>
      </section>
      <section className="panel quickstart-panel">
        <div className="quickstart-copy"><span className="eyebrow">QUICK START</span><h2>用现有 SDK 直接接入</h2><p>OpenAI 与 Anthropic 客户端共享同一网关地址，选择对应格式的网关密钥即可。</p><div className="quick-links"><NavLink to="/keys">创建 API 密钥 <ChevronRight size={14} /></NavLink><NavLink to="/playground">打开 Playground <ChevronRight size={14} /></NavLink></div></div>
        <div className="code-card"><div className="code-title"><Code2 size={15} /> OpenAI Python</div><pre><code>{`from openai import OpenAI\n\nclient = OpenAI(\n  base_url="${location.origin}/v1",\n  api_key="gw-oai_••••"\n)`}</code></pre></div>
      </section>
    </div>
  );
}

function PlaygroundPage() {
  const notify = useNotify();
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<{ items: ModelAlias[] }>("/api/admin/v1/models") });
  const [protocol, setProtocol] = useState<"openai" | "anthropic">("openai");
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("You are a concise, thoughtful assistant.");
  const [prompt, setPrompt] = useState("解释一下流式响应为什么能改善用户体验。只用三点。 ");
  const [stream, setStream] = useState(true);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [rawEvents, setRawEvents] = useState<string[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => { if (!model && models.data?.items[0]) setModel(models.data.items[0].publicId); }, [model, models.data]);

  const run = async () => {
    if (!model) { notify("请先创建并选择一个模型映射", "error"); return; }
    setOutput(""); setRawEvents([]); setRunning(true);
    const controller = new AbortController(); controllerRef.current = controller;
    const inference = protocol === "openai"
      ? { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 1024, stream }
      : { model, system, messages: [{ role: "user", content: prompt }], max_tokens: 1024, stream };
    try {
      const response = await fetch("/api/admin/v1/playground", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-cw2-csrf": getCsrfToken() },
        body: JSON.stringify({ protocol, request: inference }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json() as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `请求失败 (${response.status})`);
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        const body = await response.json() as Record<string, unknown>;
        setRawEvents([JSON.stringify(body, null, 2)]);
        if (protocol === "openai") {
          const choices = body.choices as Array<{ message?: { content?: string } }> | undefined;
          setOutput(choices?.[0]?.message?.content ?? JSON.stringify(body, null, 2));
        } else {
          const content = body.content as Array<{ type?: string; text?: string }> | undefined;
          setOutput(content?.filter((item) => item.type === "text").map((item) => item.text).join("") ?? JSON.stringify(body, null, 2));
        }
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
        for (const event of events) {
          const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const data = dataLine.slice(5).trim();
          if (data === "[DONE]") continue;
          setRawEvents((current) => [...current.slice(-99), data]);
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (protocol === "openai") {
              const choices = parsed.choices as Array<{ delta?: { content?: string; reasoning_content?: string } }> | undefined;
              const delta = choices?.[0]?.delta;
              if (delta?.content) setOutput((current) => current + delta.content);
              if (delta?.reasoning_content) setOutput((current) => current + delta.reasoning_content);
            } else if (parsed.type === "content_block_delta") {
              const delta = parsed.delta as { text?: string; thinking?: string };
              setOutput((current) => current + (delta.text ?? delta.thinking ?? ""));
            }
          } catch { /* Ignore non-JSON SSE fields. */ }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") notify(error instanceof Error ? error.message : "请求失败", "error");
    } finally { setRunning(false); controllerRef.current = null; }
  };
  return (
    <div className="page-stack playground-page">
      <PageHeader eyebrow="PROTOCOL LAB" title="Playground" description="在浏览器内验证模型映射、流式事件与两种兼容协议。请求通过管理员会话发起，不暴露网关密钥。" actions={<div className="segmented"><button className={protocol === "openai" ? "active" : ""} onClick={() => setProtocol("openai")}>OpenAI</button><button className={protocol === "anthropic" ? "active" : ""} onClick={() => setProtocol("anthropic")}>Anthropic</button></div>} />
      <section className="playground-grid">
        <div className="panel composer-panel">
          <div className="composer-toolbar"><label><span>模型</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">选择模型</option>{models.data?.items.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.publicId}>{item.displayName} · {item.publicId}</option>)}</select></label><label className="switch-row compact"><input type="checkbox" checked={stream} onChange={(event) => setStream(event.target.checked)} /><i /><span>Stream</span></label></div>
          <label className="field editor-field"><span>System prompt</span><textarea value={system} onChange={(event) => setSystem(event.target.value)} rows={4} /></label>
          <label className="field editor-field grow"><span>User message</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          <div className="composer-footer"><span>{prompt.length} chars · max 1024 tokens</span>{running ? <Button variant="danger" onClick={() => controllerRef.current?.abort()}><X size={15} />停止</Button> : <Button onClick={run}><Send size={15} />发送请求</Button>}</div>
        </div>
        <div className="panel response-panel">
          <div className="response-toolbar"><div><span className={cn("response-dot", running && "pulse")} /><b>{running ? "正在流式接收" : output ? "响应完成" : "等待请求"}</b></div><button className="icon-button" aria-label="复制响应" onClick={() => output && copyText(output).then(() => notify("响应已复制"))} disabled={!output}><Copy size={16} /></button></div>
          <div className={cn("response-content", !output && "response-empty")}>{output ? <div className="response-prose">{output}</div> : <><div className="empty-spark"><Sparkles size={24} /></div><h3>响应会出现在这里</h3><p>选择模型并发送消息，流式文本将逐字呈现。</p></>}</div>
          <details className="event-inspector"><summary><Code2 size={15} /> 原始事件 <span>{rawEvents.length}</span></summary><pre>{rawEvents.join("\n\n") || "No events yet."}</pre></details>
        </div>
      </section>
    </div>
  );
}

type KeyForm = { name: string; mode: "openai" | "anthropic" | "dual"; rpm: string; tpm: string; maxConcurrency: string; dailyBudgetUsd: string; allowedModels: string[]; allowedIps: string; expiresAt: string };
const emptyKeyForm: KeyForm = { name: "", mode: "dual", rpm: "60", tpm: "100000", maxConcurrency: "4", dailyBudgetUsd: "", allowedModels: [], allowedIps: "", expiresAt: "" };

function keyPolicyPayload(form: KeyForm) {
  return {
    name: form.name,
    mode: form.mode,
    rpm: Number(form.rpm),
    tpm: Number(form.tpm),
    maxConcurrency: Number(form.maxConcurrency),
    allowedModels: form.allowedModels,
    allowedIps: form.allowedIps.split(",").map((item) => item.trim()).filter(Boolean),
    expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    dailyBudgetMicros: form.dailyBudgetUsd ? Math.round(Number(form.dailyBudgetUsd) * 1_000_000) : null,
  };
}

function KeysPage() {
  const notify = useNotify();
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => api<{ items: GatewayKey[] }>("/api/admin/v1/keys") });
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<{ items: ModelAlias[] }>("/api/admin/v1/models") });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<GatewayKey | null>(null);
  const [revealed, setRevealed] = useState("");
  const [form, setForm] = useState<KeyForm>(emptyKeyForm);
  const create = useMutation({
    mutationFn: () => api<{ id: string; apiKey: string }>("/api/admin/v1/keys", {
      method: "POST",
      body: JSON.stringify(keyPolicyPayload(form)),
    }),
    onSuccess: (result) => {
      setCreating(false); setRevealed(result.apiKey);
      setForm(emptyKeyForm);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "创建失败", "error"),
  });
  const update = useMutation({
    mutationFn: () => {
      const { mode: _fixedMode, ...policy } = keyPolicyPayload(form);
      return api(`/api/admin/v1/keys/${editing!.id}`, { method: "PATCH", body: JSON.stringify(policy) });
    },
    onSuccess: () => {
      setEditing(null); setForm(emptyKeyForm); notify("密钥策略已更新");
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "更新失败", "error"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/admin/v1/keys/${id}/revoke`, { method: "POST" }),
    onSuccess: () => { notify("密钥已撤销"); void queryClient.invalidateQueries({ queryKey: ["keys"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "撤销失败", "error"),
  });
  const openCreate = () => { setForm(emptyKeyForm); setCreating(true); };
  const openEdit = (key: GatewayKey) => {
    setForm({
      name: key.name,
      mode: key.mode,
      rpm: String(key.rpm),
      tpm: String(key.tpm),
      maxConcurrency: String(key.maxConcurrency),
      dailyBudgetUsd: key.dailyBudgetMicros === null ? "" : String(key.dailyBudgetMicros / 1_000_000),
      allowedModels: key.allowedModels,
      allowedIps: key.allowedIps.join(", "),
      expiresAt: key.expiresAt ? new Date(key.expiresAt).toISOString().slice(0, 16) : "",
    });
    setEditing(key);
  };
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/admin/v1/keys/${id}`, { method: "DELETE" }),
    onSuccess: () => { notify("密钥记录已删除"); void queryClient.invalidateQueries({ queryKey: ["keys"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "删除失败", "error"),
  });
  const toggleModel = (id: string) => setForm((current) => ({ ...current, allowedModels: current.allowedModels.includes(id) ? current.allowedModels.filter((item) => item !== id) : [...current.allowedModels, id] }));
  return (
    <div className="page-stack">
      <PageHeader eyebrow="ACCESS CONTROL" title="API 密钥" description="为调用方签发独立密钥，限制协议、模型、来源 IP、速率、预算与并发。密钥正文仅显示一次。" actions={<Button onClick={openCreate}><Plus size={16} />创建密钥</Button>} />
      <section className="security-strip"><ShieldCheck size={19} /><div><b>密钥采用单向 HMAC 保存</b><span>数据库中没有可恢复的网关密钥正文；撤销即时生效。</span></div><span className="security-strip-chip">Reveal once</span></section>
      <section className="panel table-panel">
        <div className="table-toolbar"><div><h2>已签发密钥</h2><span>{keys.data?.items.length ?? 0} 个</span></div><Button variant="ghost" size="sm" onClick={() => keys.refetch()}><RefreshCw size={14} />刷新</Button></div>
        {keys.data?.items.length ? <div className="data-table-wrap" role="region" aria-label="API 密钥表格，可水平滚动" tabIndex={0}><table className="data-table"><thead><tr><th>名称 / 密钥</th><th>协议</th><th>限制</th><th>模型</th><th>最近使用</th><th>状态</th><th /></tr></thead><tbody>{keys.data.items.map((key) => <tr key={key.id}><td><div className="primary-cell"><div className="row-icon"><KeyRound size={16} /></div><div><b>{key.name}</b><code>{key.prefix}••••{key.suffix}</code></div></div></td><td><span className="protocol-pill">{key.mode}</span></td><td><b>{key.rpm} RPM</b><small>{formatNumber(key.tpm)} TPM · {key.maxConcurrency} 并发</small><small>{key.dailyBudgetMicros === null ? "无每日成本上限" : `${formatUsd(key.dailyBudgetMicros, 2)} / UTC 日`}</small></td><td><span>{key.allowedModels.length ? `${key.allowedModels.length} 个模型` : "全部模型"}</span><small>{key.allowedIps.length ? `${key.allowedIps.length} 个 IP` : "全部来源"}</small></td><td>{formatDate(key.lastUsedAt)}</td><td><StatusBadge status={key.revokedAt ? "revoked" : "active"} /></td><td><div className="row-actions">{!key.revokedAt && <button title="编辑策略" onClick={() => openEdit(key)}><Pencil size={14} /></button>}{!key.revokedAt && <button title="撤销" onClick={() => window.confirm(`撤销 ${key.name}？`) && revoke.mutate(key.id)}><X size={15} /></button>}<button title="删除" onClick={() => window.confirm(`永久删除 ${key.name} 的记录？`) && remove.mutate(key.id)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <EmptyState icon={<KeyRound size={22} />} title="还没有 API 密钥" description="创建一把协议受限的密钥开始接入。" action={<Button size="sm" onClick={openCreate}><Plus size={14} />创建第一把密钥</Button>} />}
      </section>
      {(creating || editing) && <Modal title={editing ? "编辑密钥策略" : "创建 API 密钥"} description={editing ? "更新限制不会改变现有密钥正文；协议格式固定不变。" : "正文生成后只显示一次，请立即保存。"} onClose={() => { setCreating(false); setEditing(null); }}>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); editing ? update.mutate() : create.mutate(); }}>
          <label className="field"><span>名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：生产环境 / 数据团队" /></label>
          <div className="field"><span>认证格式 {editing && <small>创建后固定</small>}</span><div className="choice-grid three">{(["openai", "anthropic", "dual"] as const).map((mode) => <button type="button" disabled={Boolean(editing)} key={mode} className={form.mode === mode ? "selected" : ""} onClick={() => setForm({ ...form, mode })}><b>{mode === "openai" ? "OpenAI" : mode === "anthropic" ? "Anthropic" : "双协议"}</b><small>{mode === "openai" ? "Bearer header" : mode === "anthropic" ? "x-api-key" : "两者均可"}</small></button>)}</div></div>
          <div className="form-grid three"><label className="field"><span>RPM</span><input type="number" min="1" value={form.rpm} onChange={(event) => setForm({ ...form, rpm: event.target.value })} /></label><label className="field"><span>TPM</span><input type="number" min="1" value={form.tpm} onChange={(event) => setForm({ ...form, tpm: event.target.value })} /></label><label className="field"><span>最大并发</span><input type="number" min="1" value={form.maxConcurrency} onChange={(event) => setForm({ ...form, maxConcurrency: event.target.value })} /></label></div>
          <label className="field"><span>每日成本上限（USD） <small>可选；按 UTC 日重置</small></span><input type="number" min="0.01" step="0.01" value={form.dailyBudgetUsd} onChange={(event) => setForm({ ...form, dailyBudgetUsd: event.target.value })} placeholder="例如 10.00" /><small>依据模型映射中配置的输入/输出单价，在请求进入上游前预留预算。</small></label>
          <div className="field"><span>允许模型 <small>不选代表全部</small></span><div className="check-grid">{models.data?.items.map((model) => <label key={model.id}><input type="checkbox" checked={form.allowedModels.includes(model.publicId)} onChange={() => toggleModel(model.publicId)} /><span><Check size={12} /></span>{model.publicId}</label>) || <small>尚无模型映射</small>}</div></div>
          <label className="field"><span>允许的 IP <small>逗号分隔；留空为全部</small></span><input value={form.allowedIps} onChange={(event) => setForm({ ...form, allowedIps: event.target.value })} placeholder="203.0.113.10, 198.51.100.8" /></label>
          <label className="field"><span>过期时间 <small>可选</small></span><input type="datetime-local" value={form.expiresAt} onChange={(event) => setForm({ ...form, expiresAt: event.target.value })} /></label>
          <div className="modal-actions"><Button type="button" variant="ghost" onClick={() => { setCreating(false); setEditing(null); }}>取消</Button><Button type="submit" loading={create.isPending || update.isPending}>{editing ? "保存策略" : "生成密钥"}</Button></div>
        </form>
      </Modal>}
      {revealed && <Modal title="立即保存这把密钥" description="关闭后将无法再次查看完整正文。" onClose={() => setRevealed("")}>
        <div className="reveal-box"><code>{revealed}</code><Button size="sm" onClick={() => copyText(revealed).then(() => notify("密钥已复制"))}><Copy size={14} />复制</Button></div>
        <div className="warning-box"><TriangleAlert size={17} /><p><b>只显示这一次</b><span>请保存到密码管理器或 Secret Manager，不要写入源码和日志。</span></p></div>
        <div className="modal-actions"><Button onClick={() => setRevealed("")}>我已安全保存</Button></div>
      </Modal>}
    </div>
  );
}

type UpstreamForm = { name: string; kind: "anthropic" | "compatible"; baseUrl: string; apiKey: string; authScheme: "x-api-key" | "bearer"; priority: string; weight: string; maxConcurrency: string; enabled: boolean; modelPrefix: string; timeoutMs: string };
const emptyUpstream: UpstreamForm = { name: "", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "", authScheme: "x-api-key", priority: "100", weight: "1", maxConcurrency: "4", enabled: true, modelPrefix: "", timeoutMs: "120000" };

function UpstreamsPage() {
  const notify = useNotify();
  const queryClient = useQueryClient();
  const upstreams = useQuery({ queryKey: ["upstreams"], queryFn: () => api<{ items: Upstream[] }>("/api/admin/v1/upstreams"), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Upstream | "new" | null>(null);
  const [form, setForm] = useState<UpstreamForm>(emptyUpstream);
  const openCreate = () => { setForm(emptyUpstream); setEditing("new"); };
  const openEdit = (item: Upstream) => { setForm({ name: item.name, kind: item.kind, baseUrl: item.baseUrl, apiKey: "", authScheme: item.authScheme, priority: String(item.priority), weight: String(item.weight), maxConcurrency: String(item.maxConcurrency), enabled: item.enabled, modelPrefix: item.modelPrefix, timeoutMs: String(item.timeoutMs) }); setEditing(item); };
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: form.name, kind: form.kind, baseUrl: form.baseUrl, authScheme: form.authScheme, priority: Number(form.priority), weight: Number(form.weight), maxConcurrency: Number(form.maxConcurrency), enabled: form.enabled, modelPrefix: form.modelPrefix, timeoutMs: Number(form.timeoutMs) };
      if (form.apiKey) body.apiKey = form.apiKey;
      return api(editing === "new" ? "/api/admin/v1/upstreams" : `/api/admin/v1/upstreams/${(editing as Upstream).id}`, { method: editing === "new" ? "POST" : "PATCH", body: JSON.stringify(body) });
    },
    onSuccess: () => { setEditing(null); notify("上游配置已保存"); void queryClient.invalidateQueries({ queryKey: ["upstreams"] }); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "保存失败", "error"),
  });
  const check = useMutation({
    mutationFn: (id: string) => api<{ status: string; detail: string }>(`/api/admin/v1/upstreams/${id}/check`, { method: "POST" }),
    onSuccess: (result) => { notify(`健康检查：${result.detail}`, result.status === "healthy" ? "success" : "error"); void queryClient.invalidateQueries({ queryKey: ["upstreams"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "检查失败", "error"),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/api/admin/v1/upstreams/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["upstreams"] }),
    onError: (error) => notify(error instanceof Error ? error.message : "更新失败", "error"),
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/admin/v1/upstreams/${id}`, { method: "DELETE" }), onSuccess: () => { notify("上游已删除"); void queryClient.invalidateQueries({ queryKey: ["upstreams"] }); }, onError: (error) => notify(error instanceof Error ? error.message : "删除失败", "error") });
  return (
    <div className="page-stack">
      <PageHeader eyebrow="ROUTING FABRIC" title="路由与上游" description="在最低优先级层内按权重与实时负载调度；失败自动降级，连续错误进入冷却。" actions={<Button onClick={openCreate}><Plus size={16} />添加上游</Button>} />
      <section className="routing-explainer"><div className="route-node"><span>01</span><b>Priority tier</b><small>先选择最小优先级</small></div><ChevronRight size={18} /><div className="route-node"><span>02</span><b>Weighted load</b><small>权重 × 当前并发</small></div><ChevronRight size={18} /><div className="route-node"><span>03</span><b>Circuit breaker</b><small>退避、冷却与恢复</small></div></section>
      <section className="upstream-card-grid">{upstreams.data?.items.length ? upstreams.data.items.map((item) => <article className={cn("upstream-card", !item.enabled && "disabled")} key={item.id}>
        <div className="upstream-card-top"><div className="provider-logo large">{item.kind === "anthropic" ? "A" : "C"}</div><div className="upstream-title"><div><h2>{item.name}</h2><span>{item.kind === "anthropic" ? "Anthropic Official" : "Authorized Compatible"}</span></div><StatusBadge status={!item.enabled ? "revoked" : item.healthStatus} /></div></div>
        <div className="endpoint-line"><Cloud size={14} /><code>{item.baseUrl}</code></div>
        <div className="upstream-metrics"><div><span>Priority</span><b>{item.priority}</b></div><div><span>Weight</span><b>{item.weight}</b></div><div><span>Concurrency</span><b>{item.maxConcurrency}</b></div><div><span>Timeout</span><b>{Math.round(item.timeoutMs / 1000)}s</b></div></div>
        {item.lastError && <div className="upstream-error"><TriangleAlert size={14} /><span>{item.lastError}</span></div>}
        <div className="upstream-card-footer"><label className="switch-row"><input type="checkbox" checked={item.enabled} onChange={(event) => patch.mutate({ id: item.id, body: { enabled: event.target.checked } })} /><i /><span>{item.enabled ? "已启用" : "已停用"}</span></label><div><Button variant="ghost" size="sm" onClick={() => check.mutate(item.id)} loading={check.isPending}><Activity size={14} />检查</Button><Button variant="secondary" size="sm" onClick={() => openEdit(item)}>编辑</Button><button className="icon-button danger-icon" aria-label={`删除上游 ${item.name}`} title="删除上游" onClick={() => window.confirm(`删除上游 ${item.name}？`) && remove.mutate(item.id)}><Trash2 size={15} /></button></div></div>
      </article>) : <div className="panel full-span"><EmptyState icon={<Cloud size={23} />} title="还没有上游凭据" description="添加官方 Anthropic API 或你明确获权使用的兼容端点。" action={<Button size="sm" onClick={openCreate}><Plus size={14} />添加上游</Button>} /></div>}</section>
      {editing && <Modal title={editing === "new" ? "添加上游" : "编辑上游"} description="凭据使用 AES-256-GCM 加密，界面不会回显。" onClose={() => setEditing(null)} wide>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          <div className="form-grid"><label className="field"><span>显示名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Anthropic Production" /></label><label className="field"><span>类型</span><select value={form.kind} onChange={(event) => { const kind = event.target.value as UpstreamForm["kind"]; setForm({ ...form, kind, baseUrl: kind === "anthropic" ? "https://api.anthropic.com" : form.baseUrl }); }}><option value="anthropic">Anthropic 官方 API</option><option value="compatible">授权的 Anthropic 兼容 API</option></select></label></div>
          <label className="field"><span>Base URL</span><input required type="url" value={form.baseUrl} disabled={form.kind === "anthropic"} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /><small>必须为公开 HTTPS 地址；私网、环回、元数据地址与重定向会被拒绝。</small></label>
          <div className="form-grid"><label className="field"><span>API Key {editing !== "new" && <small>留空保持现有凭据</small>}</span><div className="input-with-icon"><KeyRound size={16} /><input required={editing === "new"} type="password" autoComplete="off" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={editing === "new" ? "sk-ant-api03-…" : "••••••••••••••••"} /></div></label><label className="field"><span>上游认证头</span><select value={form.kind === "anthropic" ? "x-api-key" : form.authScheme} disabled={form.kind === "anthropic"} onChange={(event) => setForm({ ...form, authScheme: event.target.value as UpstreamForm["authScheme"] })}><option value="x-api-key">x-api-key</option><option value="bearer">Authorization: Bearer</option></select></label></div>
          <div className="form-grid four"><label className="field"><span>优先级</span><input type="number" min="0" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} /></label><label className="field"><span>权重</span><input type="number" min="1" value={form.weight} onChange={(event) => setForm({ ...form, weight: event.target.value })} /></label><label className="field"><span>最大并发</span><input type="number" min="1" value={form.maxConcurrency} onChange={(event) => setForm({ ...form, maxConcurrency: event.target.value })} /></label><label className="field"><span>超时 ms</span><input type="number" min="1000" value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} /></label></div>
          <div className="form-grid"><label className="field"><span>模型前缀 <small>可选</small></span><input value={form.modelPrefix} onChange={(event) => setForm({ ...form, modelPrefix: event.target.value })} placeholder="例如 provider/" /></label><label className="switch-card"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><b>立即启用</b><small>加入健康调度候选池</small></span><i /></label></div>
          <div className="modal-actions"><Button type="button" variant="ghost" onClick={() => setEditing(null)}>取消</Button><Button type="submit" loading={save.isPending}>保存上游</Button></div>
        </form>
      </Modal>}
    </div>
  );
}

type ModelForm = { publicId: string; upstreamModel: string; upstreamId: string; displayName: string; capabilities: string[]; inputPriceUsdPerMillion: string; outputPriceUsdPerMillion: string; enabled: boolean };
const emptyModel: ModelForm = { publicId: "", upstreamModel: "", upstreamId: "", displayName: "", capabilities: ["text", "streaming"], inputPriceUsdPerMillion: "0", outputPriceUsdPerMillion: "0", enabled: true };
const capabilityOptions = ["text", "vision", "documents", "tools", "thinking", "streaming"];

function ModelsPage() {
  const notify = useNotify();
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<{ items: ModelAlias[] }>("/api/admin/v1/models") });
  const upstreams = useQuery({ queryKey: ["upstreams"], queryFn: () => api<{ items: Upstream[] }>("/api/admin/v1/upstreams") });
  const [editing, setEditing] = useState<ModelAlias | "new" | null>(null);
  const [form, setForm] = useState<ModelForm>(emptyModel);
  const openNew = () => { setForm(emptyModel); setEditing("new"); };
  const openEdit = (model: ModelAlias) => { setForm({ publicId: model.publicId, upstreamModel: model.upstreamModel, upstreamId: model.upstreamId ?? "", displayName: model.displayName, capabilities: model.capabilities, inputPriceUsdPerMillion: String(model.inputPriceMicrosPerMillion / 1_000_000), outputPriceUsdPerMillion: String(model.outputPriceMicrosPerMillion / 1_000_000), enabled: model.enabled }); setEditing(model); };
  const save = useMutation({
    mutationFn: () => api(editing === "new" ? "/api/admin/v1/models" : `/api/admin/v1/models/${(editing as ModelAlias).id}`, { method: editing === "new" ? "POST" : "PATCH", body: JSON.stringify({ ...form, upstreamId: form.upstreamId || null, inputPriceMicrosPerMillion: Math.round(Number(form.inputPriceUsdPerMillion) * 1_000_000), outputPriceMicrosPerMillion: Math.round(Number(form.outputPriceUsdPerMillion) * 1_000_000), inputPriceUsdPerMillion: undefined, outputPriceUsdPerMillion: undefined }) }),
    onSuccess: () => { setEditing(null); notify("模型映射已保存"); void queryClient.invalidateQueries({ queryKey: ["models"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "保存失败", "error"),
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/admin/v1/models/${id}`, { method: "DELETE" }), onSuccess: () => { notify("模型映射已删除"); void queryClient.invalidateQueries({ queryKey: ["models"] }); }, onError: (error) => notify(error instanceof Error ? error.message : "删除失败", "error") });
  const toggleCapability = (name: string) => setForm((current) => ({ ...current, capabilities: current.capabilities.includes(name) ? current.capabilities.filter((item) => item !== name) : [...current.capabilities, name] }));
  return (
    <div className="page-stack">
      <PageHeader eyebrow="MODEL CATALOG" title="模型映射" description="向客户端暴露稳定的公共模型 ID，并将它们映射到真实上游模型；供应商变更无需改客户端。" actions={<Button onClick={openNew}><Plus size={16} />新建映射</Button>} />
      <section className="model-card-grid">{models.data?.items.length ? models.data.items.map((model) => {
        const bound = upstreams.data?.items.find((item) => item.id === model.upstreamId);
        return <article className={cn("model-card", !model.enabled && "disabled")} key={model.id}><div className="model-card-heading"><div className="model-glyph"><Sparkles size={18} /></div><StatusBadge status={model.enabled ? "active" : "revoked"} /></div><h2>{model.displayName}</h2><code>{model.publicId}</code><div className="mapping-line"><span>{model.publicId}</span><ChevronRight size={14} /><span>{model.upstreamModel}</span></div><div className="capability-row">{model.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div><div className="model-price">每百万 Token：输入 {formatUsd(model.inputPriceMicrosPerMillion, 2)} · 输出 {formatUsd(model.outputPriceMicrosPerMillion, 2)}</div><div className="model-card-footer"><span><Cloud size={14} />{bound?.name ?? "任意合格上游"}</span><div><Button variant="ghost" size="sm" onClick={() => openEdit(model)}>编辑</Button><button className="icon-button danger-icon" aria-label={`删除模型 ${model.publicId}`} title="删除模型" onClick={() => window.confirm(`删除模型映射 ${model.publicId}？`) && remove.mutate(model.id)}><Trash2 size={15} /></button></div></div></article>;
      }) : <div className="panel full-span"><EmptyState icon={<Layers3 size={23} />} title="还没有公共模型" description="创建映射后，客户端才能通过 /v1/models 发现并调用模型。" action={<Button size="sm" onClick={openNew}><Plus size={14} />创建模型映射</Button>} /></div>}</section>
      {editing && <Modal title={editing === "new" ? "新建模型映射" : "编辑模型映射"} description="公共 ID 面向客户端，真实模型名仅发往上游。" onClose={() => setEditing(null)}>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          <label className="field"><span>显示名称</span><input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Claude Sonnet" /></label>
          <div className="form-grid"><label className="field"><span>公共模型 ID</span><input required pattern="[A-Za-z0-9._:-]+" value={form.publicId} onChange={(event) => setForm({ ...form, publicId: event.target.value })} placeholder="claude-sonnet" /></label><label className="field"><span>上游模型 ID</span><input required value={form.upstreamModel} onChange={(event) => setForm({ ...form, upstreamModel: event.target.value })} placeholder="claude-sonnet-4-5" /></label></div>
          <label className="field"><span>绑定上游 <small>可选</small></span><select value={form.upstreamId} onChange={(event) => setForm({ ...form, upstreamId: event.target.value })}><option value="">由路由器选择任意合格上游</option>{upstreams.data?.items.map((upstream) => <option key={upstream.id} value={upstream.id}>{upstream.name}</option>)}</select></label>
          <div className="form-grid"><label className="field"><span>输入价格（USD / 百万 Token）</span><input required type="number" min="0" step="0.000001" value={form.inputPriceUsdPerMillion} onChange={(event) => setForm({ ...form, inputPriceUsdPerMillion: event.target.value })} /></label><label className="field"><span>输出价格（USD / 百万 Token）</span><input required type="number" min="0" step="0.000001" value={form.outputPriceUsdPerMillion} onChange={(event) => setForm({ ...form, outputPriceUsdPerMillion: event.target.value })} /></label></div>
          <div className="field"><span>能力声明</span><div className="check-grid capabilities">{capabilityOptions.map((capability) => <label key={capability}><input type="checkbox" checked={form.capabilities.includes(capability)} onChange={() => toggleCapability(capability)} /><span><Check size={12} /></span>{capability}</label>)}</div></div>
          <label className="switch-card"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><b>公开此模型</b><small>关闭后 API 立即停止发现与调用</small></span><i /></label>
          <div className="modal-actions"><Button type="button" variant="ghost" onClick={() => setEditing(null)}>取消</Button><Button type="submit" loading={save.isPending}>保存映射</Button></div>
        </form>
      </Modal>}
    </div>
  );
}

function RequestsPage() {
  const [filter, setFilter] = useState("");
  const requests = useQuery({ queryKey: ["requests"], queryFn: () => api<{ items: RequestLog[] }>("/api/admin/v1/requests?limit=250"), refetchInterval: 15_000 });
  const items = requests.data?.items.filter((item) => `${item.request_id} ${item.model} ${item.protocol} ${item.status}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return (
    <div className="page-stack">
      <PageHeader eyebrow="REQUEST TRACES" title="请求追踪" description="仅记录协议、模型、状态、Token 与耗时等元数据；提示词、响应正文和凭据不会进入日志。" actions={<Button variant="secondary" onClick={() => requests.refetch()} loading={requests.isFetching}><RefreshCw size={15} />刷新</Button>} />
      <section className="security-strip subtle"><EyeOff size={19} /><div><b>Content-free logging</b><span>这里没有消息正文、工具参数、附件内容或完整 API Key。</span></div></section>
      <section className="panel table-panel">
        <div className="table-toolbar"><div className="filter-input"><Search size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索 Request ID、模型或状态" /></div><span>{items.length} 条记录</span></div>
        {items.length ? <div className="data-table-wrap" role="region" aria-label="请求追踪表格，可水平滚动" tabIndex={0}><table className="data-table request-table"><thead><tr><th>Request ID</th><th>协议 / 模型</th><th>状态</th><th>Token / 成本</th><th>TTFT</th><th>总耗时</th><th>时间</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><code>{item.request_id.slice(0, 18)}</code></td><td><span className="protocol-pill">{item.protocol}</span><small>{item.model}</small></td><td><StatusBadge status={item.status} />{item.error_code && <small className="error-code">{item.error_code}</small>}</td><td><b>{formatNumber((item.input_tokens ?? 0) + (item.output_tokens ?? 0))}</b><small>{formatNumber(item.input_tokens)} in · {formatNumber(item.output_tokens)} out</small><small>{item.cost_micros === null ? "—" : formatUsd(item.cost_micros)}</small></td><td>{item.ttft_ms === null ? "—" : `${item.ttft_ms} ms`}</td><td><b>{item.latency_ms} ms</b><small>HTTP {item.http_status}</small></td><td>{formatDate(item.created_at)}</td></tr>)}</tbody></table></div> : <EmptyState icon={<Activity size={22} />} title={filter ? "没有匹配记录" : "等待首个请求"} description={filter ? "尝试更换搜索关键词。" : "调用双协议端点后，元数据轨迹会显示在这里。"} />}
      </section>
    </div>
  );
}

function SecurityPage() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api<{ items: AuditEvent[] }>("/api/admin/v1/audit?limit=250"), refetchInterval: 30_000 });
  const safeguards = [
    { icon: KeyRound, title: "凭据加密", text: "上游密钥使用 AES-256-GCM 与记录级 AAD 加密；主密钥只来自环境。" },
    { icon: ShieldCheck, title: "会话隔离", text: "Argon2id 密码哈希、HttpOnly SameSite Cookie 与独立 CSRF 令牌。" },
    { icon: Cloud, title: "SSRF 防护", text: "兼容上游必须为公开 HTTPS，拒绝私网、保留地址、嵌入凭据与重定向。" },
    { icon: EyeOff, title: "最小化日志", text: "不保存对话正文、附件内容、工具参数、管理员密码与原始 API Key。" },
  ];
  return (
    <div className="page-stack">
      <PageHeader eyebrow="SECURITY LEDGER" title="安全审计" description="查看管理平面的敏感变更，并核对系统当前采用的安全控制。" actions={<Button variant="secondary" onClick={() => audit.refetch()}><RefreshCw size={15} />刷新</Button>} />
      <section className="safeguard-grid">{safeguards.map((item) => <article className="safeguard-card" key={item.title}><div><item.icon size={19} /></div><h3>{item.title}</h3><p>{item.text}</p><span><Check size={13} /> 已启用</span></article>)}</section>
      <section className="panel audit-panel"><div className="panel-heading"><div><span className="eyebrow">IMMUTABLE TRAIL</span><h2>最近管理事件</h2></div><span className="panel-chip">{audit.data?.items.length ?? 0} events</span></div>
        <div className="audit-timeline">{audit.data?.items.length ? audit.data.items.map((event) => <div className="audit-entry" key={event.id}><div className="audit-dot"><FileClock size={15} /></div><div><div className="audit-entry-title"><b>{event.action}</b><span>{formatDate(event.created_at)}</span></div><p><strong>{event.actor}</strong> · {event.target_type}{event.target_id ? ` / ${event.target_id.slice(0, 16)}` : ""}</p>{Object.keys(event.metadata ?? {}).length > 0 && <code>{JSON.stringify(event.metadata)}</code>}</div></div>) : <EmptyState icon={<FileClock size={22} />} title="没有审计事件" description="管理变更会按时间顺序显示在这里。" />}</div>
      </section>
    </div>
  );
}

interface OidcFormValues {
  enabled: boolean;
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  clearClientSecret: boolean;
  tokenAuthMethod: OidcConfig["tokenAuthMethod"];
  scopes: string;
  usernameClaim: string;
  groupsClaim: string;
  allowedGroups: string;
  autoProvision: boolean;
}

function PasswordSettingsCard() {
  const notify = useNotify();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({
    mutationFn: () => {
      if (newPassword !== confirmation) throw new Error("两次输入的新密码不一致");
      return api<{ ok: true }>("/api/admin/v1/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      notify("管理员密码已更新，其他会话已失效");
    },
    onError: (cause) => notify(cause instanceof Error ? cause.message : "密码更新失败", "error"),
  });
  return (
    <article className="panel settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><KeyRound size={18} /></div><div><h2>管理员密码</h2><p>轮换本地密码；当前浏览器会话保持登录，其他会话立即失效。</p></div></div>
      <div className="settings-fields">
        <div className="form-grid">
          <label className="field full-span"><span>当前密码</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label className="field"><span>新密码</span><input type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><small>至少 12 位，建议使用密码管理器生成。</small></label>
          <label className="field"><span>确认新密码</span><input type="password" minLength={12} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        </div>
        <div className="oidc-actions"><Button variant="secondary" onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!currentPassword || newPassword.length < 12 || !confirmation}><KeyRound size={15} />更新密码</Button></div>
      </div>
    </article>
  );
}

const oidcDefaults: OidcFormValues = {
  enabled: false,
  providerName: "Single sign-on",
  issuer: "",
  clientId: "",
  clientSecret: "",
  clearClientSecret: false,
  tokenAuthMethod: "client_secret_basic",
  scopes: "openid profile email",
  usernameClaim: "preferred_username",
  groupsClaim: "groups",
  allowedGroups: "",
  autoProvision: false,
};

function OidcSettingsCard() {
  const notify = useNotify();
  const queryClient = useQueryClient();
  const oidc = useQuery({ queryKey: ["oidc-config"], queryFn: () => api<OidcConfig>("/api/admin/v1/oidc") });
  const [form, setForm] = useState<OidcFormValues>(oidcDefaults);
  useEffect(() => {
    if (!oidc.data) return;
    setForm({
      enabled: oidc.data.enabled,
      providerName: oidc.data.providerName,
      issuer: oidc.data.issuer,
      clientId: oidc.data.clientId,
      clientSecret: "",
      clearClientSecret: false,
      tokenAuthMethod: oidc.data.tokenAuthMethod,
      scopes: oidc.data.scopes.join(" "),
      usernameClaim: oidc.data.usernameClaim,
      groupsClaim: oidc.data.groupsClaim,
      allowedGroups: oidc.data.allowedGroups.join("\n"),
      autoProvision: oidc.data.autoProvision,
    });
  }, [oidc.data]);
  const save = useMutation({
    mutationFn: () => api<OidcConfig>("/api/admin/v1/oidc", {
      method: "PUT",
      body: JSON.stringify({
        enabled: form.enabled,
        providerName: form.providerName,
        issuer: form.issuer,
        clientId: form.clientId,
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        clearClientSecret: form.clearClientSecret,
        tokenAuthMethod: form.tokenAuthMethod,
        scopes: form.scopes.split(/[\s,]+/).filter(Boolean),
        usernameClaim: form.usernameClaim,
        groupsClaim: form.groupsClaim,
        allowedGroups: form.allowedGroups.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
        autoProvision: form.autoProvision,
      }),
    }),
    onSuccess: (value) => {
      queryClient.setQueryData(["oidc-config"], value);
      void queryClient.invalidateQueries({ queryKey: ["oidc-public"] });
      notify("OIDC 设置已保存");
    },
    onError: (cause) => notify(cause instanceof Error ? cause.message : "OIDC 保存失败", "error"),
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: true }>("/api/admin/v1/oidc/test", { method: "POST" }),
    onSuccess: () => notify("OIDC Discovery 校验成功"),
    onError: (cause) => notify(cause instanceof Error ? cause.message : "OIDC Discovery 校验失败", "error"),
  });
  const link = useMutation({
    mutationFn: () => api<{ authorizationUrl: string }>("/api/admin/v1/oidc/link/start", { method: "POST" }),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
    onError: (cause) => notify(cause instanceof Error ? cause.message : "无法开始绑定", "error"),
  });
  return (
    <article className="panel settings-section oidc-section">
      <div className="settings-section-heading"><div className="settings-icon"><LogIn size={18} /></div><div><h2>OIDC 单点登录</h2><p>标准 Authorization Code + PKCE；仅用于管理控制台身份认证。</p></div></div>
      <div className="settings-fields">
        {!oidc.data?.callbackUrl && <div className="warning-box"><TriangleAlert size={17} /><p><b>还不能启用 OIDC</b><span>先设置启动变量 CW2_PUBLIC_URL，并确保生产环境使用 HTTPS。</span></p></div>}
        <div className="form-grid">
          <label className="field"><span>提供商显示名称</span><input value={form.providerName} onChange={(event) => setForm({ ...form, providerName: event.target.value })} /></label>
          <label className="field"><span>Issuer</span><input type="url" placeholder="https://id.example.com" value={form.issuer} onChange={(event) => setForm({ ...form, issuer: event.target.value })} /></label>
          <label className="field"><span>Client ID</span><input autoComplete="off" value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} /></label>
          <label className="field"><span>Token endpoint 鉴权</span><select value={form.tokenAuthMethod} onChange={(event) => setForm({ ...form, tokenAuthMethod: event.target.value as OidcConfig["tokenAuthMethod"] })}><option value="client_secret_basic">client_secret_basic（推荐）</option><option value="client_secret_post">client_secret_post</option><option value="none">公开客户端（none）</option></select></label>
          <label className="field"><span>Client Secret</span><input type="password" autoComplete="new-password" disabled={form.tokenAuthMethod === "none"} placeholder={oidc.data?.hasClientSecret ? "已加密保存；留空保持不变" : "输入提供商签发的密钥"} value={form.clientSecret} onChange={(event) => setForm({ ...form, clientSecret: event.target.value, clearClientSecret: false })} /></label>
          <label className="field"><span>Scopes</span><input value={form.scopes} onChange={(event) => setForm({ ...form, scopes: event.target.value })} /><small>必须包含 openid；以空格或逗号分隔。</small></label>
          <label className="field"><span>用户名 Claim</span><input value={form.usernameClaim} onChange={(event) => setForm({ ...form, usernameClaim: event.target.value })} /></label>
          <label className="field"><span>组 Claim</span><input value={form.groupsClaim} onChange={(event) => setForm({ ...form, groupsClaim: event.target.value })} /></label>
          <label className="field full-span"><span>允许的组</span><textarea rows={3} placeholder="留空表示不限制；每行一个精确组名" value={form.allowedGroups} onChange={(event) => setForm({ ...form, allowedGroups: event.target.value })} /></label>
          <label className="field full-span"><span>固定回调地址</span><input disabled value={oidc.data?.callbackUrl ?? "由 CW2_PUBLIC_URL 生成"} /></label>
        </div>
        <div className="oidc-switches">
          <label className="switch-card"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><b>启用 OIDC 登录</b><small>启用时保存操作会先验证 Discovery 元数据。</small></span><i /></label>
          <label className="switch-card"><input type="checkbox" checked={form.autoProvision} onChange={(event) => setForm({ ...form, autoProvision: event.target.checked })} /><span><b>自动创建管理员</b><small>建议同时配置允许组；关闭时需先显式绑定。</small></span><i /></label>
          {oidc.data?.hasClientSecret && form.tokenAuthMethod !== "none" && <label className="switch-card"><input type="checkbox" checked={form.clearClientSecret} onChange={(event) => setForm({ ...form, clearClientSecret: event.target.checked, clientSecret: "" })} /><span><b>清除已保存密钥</b><small>选择密钥鉴权时清除后无法启用。</small></span><i /></label>}
        </div>
        <div className="oidc-actions">
          <Button onClick={() => save.mutate()} loading={save.isPending}><Check size={15} />保存 OIDC</Button>
          <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending} disabled={!oidc.data?.issuer}><RefreshCw size={15} />测试 Discovery</Button>
          <Button variant="ghost" onClick={() => link.mutate()} loading={link.isPending} disabled={!oidc.data?.enabled}><LogIn size={15} />绑定当前管理员</Button>
        </div>
        <p className="oidc-note"><ShieldCheck size={14} />ID Token 强制校验签名、issuer、audience/azp、时效与 nonce；state 一次性使用并绑定发起登录的浏览器。</p>
      </div>
    </article>
  );
}

interface SettingsValues { productName: string; routingStrategy: string; maxAttempts: string; requestRetention: string; auditRetention: string; compactSidebar: boolean }

function SettingsPage() {
  const notify = useNotify();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<{ values: Record<string, unknown> }>("/api/admin/v1/settings") });
  const [form, setForm] = useState<SettingsValues>({ productName: "Claude Web2", routingStrategy: "weighted_least_loaded", maxAttempts: "2", requestRetention: "30", auditRetention: "180", compactSidebar: false });
  useEffect(() => {
    const values = settings.data?.values;
    if (!values) return;
    setForm({
      productName: String(values["ui.product_name"] ?? "Claude Web2"),
      routingStrategy: String(values["routing.strategy"] ?? "weighted_least_loaded"),
      maxAttempts: String(values["routing.max_attempts"] ?? "2"),
      requestRetention: String(values["logging.request_retention_days"] ?? "30"),
      auditRetention: String(values["logging.audit_retention_days"] ?? "180"),
      compactSidebar: Boolean(values["ui.compact_sidebar"] ?? false),
    });
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api("/api/admin/v1/settings", { method: "PUT", body: JSON.stringify({ values: { "ui.product_name": form.productName, "routing.strategy": form.routingStrategy, "routing.max_attempts": Number(form.maxAttempts), "logging.request_retention_days": Number(form.requestRetention), "logging.audit_retention_days": Number(form.auditRetention), "ui.compact_sidebar": form.compactSidebar } }) }),
    onSuccess: () => { notify("设置已保存"); void queryClient.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "保存失败", "error"),
  });
  return (
    <div className="page-stack">
      <PageHeader eyebrow="CONTROL SURFACE" title="系统设置" description="调整路由策略、保留周期和控制台偏好。环境级安全项仍由启动变量管理。" actions={<Button onClick={() => save.mutate()} loading={save.isPending}><Check size={16} />保存更改</Button>} />
      <section className="settings-layout">
        <div className="settings-main">
          <article className="panel settings-section"><div className="settings-section-heading"><div className="settings-icon"><RouteIcon size={18} /></div><div><h2>路由策略</h2><p>决定同一优先级层内如何选择健康上游。</p></div></div><div className="settings-fields"><label className="field"><span>调度算法</span><select value={form.routingStrategy} onChange={(event) => setForm({ ...form, routingStrategy: event.target.value })}><option value="weighted_least_loaded">加权最小负载（推荐）</option><option value="round_robin">加权轮询</option><option value="priority_only">仅按优先级</option></select></label><label className="field"><span>流开始前最大尝试次数</span><input type="number" min="1" max="5" value={form.maxAttempts} onChange={(event) => setForm({ ...form, maxAttempts: event.target.value })} /><small>流式响应一旦向客户端发送字节，绝不切换上游重试。</small></label></div></article>
          <article className="panel settings-section"><div className="settings-section-heading"><div className="settings-icon"><Database size={18} /></div><div><h2>数据保留</h2><p>只影响元数据和审计事件，不涉及对话正文。</p></div></div><div className="settings-fields form-grid"><label className="field"><span>请求日志保留天数</span><input type="number" min="1" max="3650" value={form.requestRetention} onChange={(event) => setForm({ ...form, requestRetention: event.target.value })} /></label><label className="field"><span>审计日志保留天数</span><input type="number" min="30" max="3650" value={form.auditRetention} onChange={(event) => setForm({ ...form, auditRetention: event.target.value })} /></label></div></article>
          <article className="panel settings-section"><div className="settings-section-heading"><div className="settings-icon"><Sparkles size={18} /></div><div><h2>控制台</h2><p>自定义本地管理界面的显示偏好。</p></div></div><div className="settings-fields"><label className="field"><span>产品名称</span><input value={form.productName} onChange={(event) => setForm({ ...form, productName: event.target.value })} /></label><label className="switch-card"><input type="checkbox" checked={form.compactSidebar} onChange={(event) => setForm({ ...form, compactSidebar: event.target.checked })} /><span><b>紧凑侧栏</b><small>为小屏幕保留更多内容空间</small></span><i /></label></div></article>
          <PasswordSettingsCard />
          <OidcSettingsCard />
        </div>
        <aside className="settings-aside">
          <article className="panel endpoint-card"><span className="eyebrow">PUBLIC ENDPOINTS</span><h3>兼容端点</h3><div><span>OpenAI</span><code>{location.origin}/v1/chat/completions</code></div><div><span>Anthropic</span><code>{location.origin}/v1/messages</code></div><div><span>Models</span><code>{location.origin}/v1/models</code></div></article>
          <article className="panel boundary-card"><ShieldCheck size={21} /><h3>明确的安全边界</h3><p>本项目不抓取或注入第三方网页 Cookie/sessionKey，不仿冒 OAuth 身份，不绕过 CAPTCHA、Cloudflare 或 TLS 指纹，也不利用账号轮换规避额度。</p><a href="https://docs.anthropic.com/en/api/getting-started" target="_blank" rel="noreferrer">Anthropic API 文档 <ChevronRight size={14} /></a></article>
          <article className="panel system-card"><span><i /> Backend ready</span><div><b>Node.js</b><small>Fastify · SQLite WAL</small></div><div><b>Encryption</b><small>AES-256-GCM</small></div><div><b>Protocols</b><small>OpenAI · Anthropic</small></div></article>
        </aside>
      </section>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<Session>("/api/admin/v1/session"),
    retry: false,
    staleTime: 60_000,
  });
  const notify: Notify = (message, kind = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3600);
  };
  const logout = async () => {
    try { await api("/api/admin/v1/session", { method: "DELETE" }); } finally {
      setCsrfToken("");
      queryClient.clear();
      void session.refetch();
    }
  };
  if (session.isLoading) return <div className="boot-screen"><div className="brand-mark"><Sparkles size={22} /></div><Loader2 className="spin" size={20} /><span>正在打开控制台…</span></div>;
  const unauthorized = session.error instanceof ApiError && session.error.status === 401;
  if (!session.data || unauthorized) return <LoginScreen onLogin={(value) => { queryClient.setQueryData(["session"], value); void session.refetch(); }} />;
  return (
    <ToastContext.Provider value={notify}>
      <Shell session={session.data} onLogout={() => void logout()} />
      <div className="toast-viewport" aria-live="polite">{toasts.map((toast) => <div className={cn("toast", `toast-${toast.kind}`)} key={toast.id}>{toast.kind === "error" ? <TriangleAlert size={16} /> : <Check size={16} />}<span>{toast.message}</span><button aria-label="关闭通知" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}><X size={14} /></button></div>)}</div>
    </ToastContext.Provider>
  );
}
