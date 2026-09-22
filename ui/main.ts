import { getToken, rest, setToken } from "./api.js";

type Page =
  | { name: "dashboard" }
  | { name: "adapters" }
  | { name: "adapter-new" }
  | { name: "adapter"; id: string }
  | { name: "tools"; layer: string }
  | { name: "tool"; tool: string }
  | { name: "settings" }
  | { name: "discovery" }
  | { name: "import" }
  | { name: "matrix" }
  | { name: "audit" }
  | { name: "plan" }
  | { name: "blacklist" }
  | { name: "security" }
  | { name: "capabilities" }
  | { name: "partner" };

const root = document.getElementById("app")!;
let health: Record<string, unknown> | undefined;
let flash: { kind: "ok" | "err"; text: string } | undefined;
let sidebarOpen = false;
type Toast = { id: number; kind: "ok" | "err"; text: string };
let toasts: Toast[] = [];
let toastSeq = 0;

function parseHash(): Page {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const parts = (path ?? "/").split("/").filter(Boolean);
  const query = new URLSearchParams(qs ?? "");
  if (parts[0] === "adapters" && parts[1] === "new") return { name: "adapter-new" };
  if (parts[0] === "adapters" && parts[1]) return { name: "adapter", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "adapters") return { name: "adapters" };
  if (parts[0] === "tools" && parts[1]) return { name: "tool", tool: decodeURIComponent(parts[1]) };
  if (parts[0] === "tools") return { name: "tools", layer: query.get("layer") || "business" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "discovery") return { name: "discovery" };
  if (parts[0] === "import") return { name: "import" };
  if (parts[0] === "matrix") return { name: "matrix" };
  if (parts[0] === "audit") return { name: "audit" };
  if (parts[0] === "plan") return { name: "plan" };
  if (parts[0] === "blacklist") return { name: "blacklist" };
  if (parts[0] === "security") return { name: "security" };
  if (parts[0] === "capabilities") return { name: "capabilities" };
  if (parts[0] === "partner") return { name: "partner" };
  return { name: "dashboard" };
}

function href(page: string): string {
  return `#${page}`;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function protoBadge(protocol: string): string {
  return `<span class="proto">${esc(protocol)}</span>`;
}

function ingressBadge(ingress: unknown): string {
  const v = String(ingress ?? "native");
  const label = v === "mcp_bridge" ? "mcp_bridge 兜底" : v;
  return `<span class="ingress ingress-${esc(v)}">${esc(label)}</span>`;
}

function statusDot(ok: boolean | undefined, failed?: boolean): string {
  const cls = failed || ok === false ? "bad" : ok === true ? "ok" : "warn";
  return `<span class="dot ${cls}"></span>`;
}

function navLink(page: Page, hrefPath: string, label: string, extra = ""): string {
  const current =
    (page.name === "dashboard" && hrefPath === "/") ||
    (page.name.startsWith("adapter") && hrefPath === "/adapters") ||
    ((page.name === "tools" || page.name === "tool") && hrefPath === "/tools") ||
    (page.name === hrefPath.slice(1) && hrefPath !== "/");
  return `<a href="${href(hrefPath)}" class="${current ? "active" : ""}">${label}${extra}</a>`;
}

function layout(page: Page, body: string): string {
  const adapters = Number((health as { adapterCount?: number } | undefined)?.adapterCount ?? 0);
  const tools = Number((health as { toolCount?: number } | undefined)?.toolCount ?? 0);
  const transport = (health as { transport?: { kind?: string } } | undefined)?.transport?.kind ?? "http";
  const tokenOn = Boolean(getToken());
  return `
    <aside class="sidebar${sidebarOpen ? " open" : ""}">
      <div class="brand">
        <div class="brand-mark"></div>
        <div>
          <h1>Everything2MCP</h1>
          <p>Control plane</p>
        </div>
      </div>
      <nav class="nav">
        ${navLink(page, "/", "仪表盘")}
        ${navLink(page, "/adapters", "适配器")}
        ${navLink(page, "/tools", "工具")}
        ${navLink(page, "/plan", "计划桥")}
        ${navLink(page, "/discovery", "发现")}
        ${navLink(page, "/capabilities", "热加载")}
        ${navLink(page, "/partner", "伙伴")}
        ${navLink(page, "/import", "导入")}
        ${navLink(page, "/audit", "审计")}
        ${navLink(page, "/blacklist", "黑名单")}
        ${navLink(page, "/security", "安全")}
        ${navLink(page, "/matrix", "协议矩阵")}
        ${navLink(page, "/settings", "设置")}
      </nav>
      <div class="side-foot">
        默认 <code>allowWrite=false</code><br/>
        禁止 CIDR / 网段扫描<br/>
        不破坏 stdio / HTTP / SSE
      </div>
    </aside>
    <section class="main">
      <header class="topbar">
        <button class="nav-toggle" id="nav-toggle" type="button" aria-label="菜单">☰</button>
        <div class="capsules">
          <span class="capsule">${statusDot(true)} ${esc(transport)} 监听</span>
          <span class="capsule">${statusDot(adapters >= 0)} 适配器 ${adapters}</span>
          <span class="capsule">${statusDot(true)} 业务 tools ${tools}</span>
          <span class="capsule">${statusDot(false, true)} WRITE-OFF</span>
          <span class="capsule">${statusDot(tokenOn, !tokenOn && Boolean((health as { transport?: unknown })?.transport))} AUTH ${tokenOn ? "token" : "open"}</span>
        </div>
        <form class="token-box" id="token-form">
          <input id="token-input" type="password" placeholder="HTTP token" value="${esc(getToken())}" autocomplete="off" />
          <button class="btn" type="submit">保存</button>
        </form>
      </header>
      <div class="content">
        ${flash ? `<div class="${flash.kind === "ok" ? "ok-box" : "err-box"}">${esc(flash.text)}</div>` : ""}
        ${body}
      </div>
      <div class="toast-host" id="toast-host">${toastHtml()}</div>
    </section>
  `;
}

function toastHtml(): string {
  return toasts.map((t) => `<div class="toast ${t.kind}">${esc(t.text)}</div>`).join("");
}

function paintToasts(): void {
  const host = document.getElementById("toast-host");
  if (host) host.innerHTML = toastHtml();
}

function showToast(kind: "ok" | "err", text: string): void {
  const id = ++toastSeq;
  toasts = [...toasts, { id, kind, text }].slice(-5);
  paintToasts();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    paintToasts();
  }, 4200);
}

async function refreshHealth(): Promise<void> {
  try {
    health = await rest.health();
  } catch (err) {
    health = { adapterCount: 0, toolCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function render(): Promise<void> {
  const page = parseHash();
  await refreshHealth();
  let inner = "";
  try {
    inner = await renderPage(page);
  } catch (err) {
    inner = `<div class="err-box">${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
  root.innerHTML = layout(page, inner);
  bindGlobal();
  bindPage(page);
  flash = undefined;
}

function bindGlobal(): void {
  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    sidebarOpen = !sidebarOpen;
    document.querySelector(".sidebar")?.classList.toggle("open", sidebarOpen);
  });
  document.getElementById("token-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = document.getElementById("token-input") as HTMLInputElement | null;
    setToken(input?.value ?? "");
    showToast("ok", "Token 已写入 sessionStorage，仅用于本页 /api 请求。");
  });
}

async function renderPage(page: Page): Promise<string> {
  switch (page.name) {
    case "dashboard":
      return renderDashboard();
    case "adapters":
      return renderAdapters();
    case "adapter-new":
      return renderAdapterForm();
    case "adapter":
      return renderAdapterDetail(page.id);
    case "tools":
      return renderTools(page.layer);
    case "tool":
      return renderTool(page.tool);
    case "settings":
      return renderSettings();
    case "discovery":
      return renderDiscovery();
    case "import":
      return renderImport();
    case "matrix":
      return renderMatrix();
    case "audit":
      return renderAudit();
    case "plan":
      return renderPlan();
    case "blacklist":
      return renderBlacklist();
    case "security":
      return renderSecurity();
    case "capabilities":
      return renderCapabilities();
    case "partner":
      return renderPartner();
  }
}

async function renderDashboard(): Promise<string> {
  const h = health ?? {};
  const adapters = Array.isArray(h.adapters) ? (h.adapters as Array<Record<string, unknown>>) : [];
  const hints = Array.isArray(h.hints) ? (h.hints as string[]) : [];
  const layers = (h.toolLayers as { management?: number; business?: number } | undefined) ?? {};
  const audit = (h.invokeAudit as { success?: number; fail?: number } | undefined) ?? {};
  const rows = adapters
    .map(
      (a) => `<tr>
        <td>${statusDot(a.status === "live" && (a.health as { ok?: boolean } | undefined)?.ok !== false, a.status !== "live")}</td>
        <td><a href="${href(`/adapters/${encodeURIComponent(String(a.id))}`)}">${esc(a.id)}</a></td>
        <td>${protoBadge(String(a.protocol))}</td>
        <td>${esc(a.toolCount ?? 0)}</td>
        <td>${esc((a.health as { detail?: string } | undefined)?.detail ?? a.error ?? a.status)}</td>
      </tr>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>仪表盘</h2>
        <p>同进程控制台 · REST <code>/api</code> 复用 control/catalog · 数据面默认只读</p>
      </div>
      <div class="row-actions">
        <a class="btn primary" href="${href("/adapters/new")}">注册适配器</a>
        <a class="btn" href="${href("/plan")}">计划桥</a>
        <a class="btn" href="${href("/audit")}">审计</a>
      </div>
    </div>
    <div class="grid">
      <div class="card"><h3>适配器</h3><div class="metric">${esc(h.adapterCount ?? 0)}</div></div>
      <div class="card"><h3>业务 tools</h3><div class="metric">${esc(layers.business ?? h.toolCount ?? 0)}</div></div>
      <div class="card"><h3>管理 tools</h3><div class="metric">${esc(layers.management ?? "—")}</div></div>
      <div class="card"><h3>invoke 审计</h3><div class="metric">${esc(audit.success ?? 0)}/${esc(audit.fail ?? 0)}</div></div>
    </div>
    ${hints.length ? `<div class="warn-box">${hints.map((x) => esc(x)).join("<br/>")}</div>` : ""}
    <div class="table-wrap">
      <table>
        <thead><tr><th></th><th>ID</th><th>协议</th><th>Tools</th><th>健康</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">还没有适配器。<a href="${href("/plan")}">计划桥</a> 或 <a href="${href("/adapters/new")}">手动注册</a>。</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

async function renderAdapters(): Promise<string> {
  const data = await rest.adapters();
  const adapters = (data.adapters as Array<Record<string, unknown>>) ?? [];
  const rows = adapters
    .map(
      (a) => `<tr>
        <td>${statusDot(a.status === "live", a.status !== "live")}</td>
        <td><a href="${href(`/adapters/${encodeURIComponent(String(a.id))}`)}">${esc(a.id)}</a></td>
        <td>${protoBadge(String(a.protocol))}</td>
        <td>${ingressBadge(a.ingress)}</td>
        <td>${esc(a.name)}</td>
        <td>${a.allowWrite === true ? "on" : "off"}</td>
        <td>${esc(a.toolCount ?? 0)}</td>
        <td>${a.blacklisted === true ? `<span class="proto blocked-tag">已拉黑</span>` : "—"}</td>
      </tr>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>适配器</h2>
        <p>热注册 CRUD。密钥在 REST 响应里已脱敏。命中黑名单的实例仍挂着，但 invoke 会被拒绝。</p>
      </div>
      <a class="btn primary" href="${href("/adapters/new")}">新建</a>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th></th><th>ID</th><th>协议</th><th>ingress</th><th>名称</th><th>allowWrite</th><th>Tools</th><th>黑名单</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="empty">空注册表。<a href="${href("/adapters/new")}">新建适配器</a> 或从 <a href="${href("/discovery")}">发现</a> 导入。</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

async function renderAdapterForm(existing?: Record<string, unknown>): Promise<string> {
  const settings = await rest.settings();
  const protocols = (settings.protocols as string[]) ?? [];
  const help = (settings.protocolHelp as Record<string, string>) ?? {};
  const proto = String(existing?.protocol ?? "sqlite");
  const name = String(existing?.name ?? "");
  const config = existing?.config && typeof existing.config === "object" ? existing.config : { filename: ":memory:", allowWrite: false };
  const options = protocols.map((p) => `<option value="${esc(p)}" ${p === proto ? "selected" : ""}>${esc(p)}</option>`).join("");
  return `
    <div class="page-head">
      <div>
        <h2>${existing ? `适配器 ${esc(existing.id)}` : "新建适配器"}</h2>
        <p>写入默认关闭。不要把 allowWrite 设成默认开。</p>
      </div>
    </div>
    <form class="card" id="adapter-form" data-id="${esc(existing?.id ?? "")}">
      <div class="field">
        <label>协议</label>
        <select name="protocol" ${existing ? "disabled" : ""}>${options}</select>
        <div class="hint" id="proto-help">${esc(help[proto] ?? "")}</div>
      </div>
      <div class="field">
        <label>名称</label>
        <input name="name" value="${esc(name)}" ${existing ? "disabled" : ""} required pattern="[A-Za-z0-9_-]{1,64}" />
      </div>
      <div class="field">
        <label>config JSON</label>
        <textarea name="config">${esc(pretty(config))}</textarea>
      </div>
      <div class="warn-box">allowWrite 必须显式 <code>true</code> 才会放开写路径。控制台不会替你打开。</div>
      <div class="row-actions" style="margin-top:14px">
        <button class="btn primary" type="submit">${existing ? "保存配置" : "注册"}</button>
        ${existing ? `<button class="btn" type="button" id="ping-btn">Ping</button><button class="btn danger" type="button" id="del-btn">删除</button>` : ""}
      </div>
    </form>
    <pre id="adapter-result" hidden></pre>
  `;
}

async function renderAdapterDetail(id: string): Promise<string> {
  const data = await rest.adapter(id);
  return renderAdapterForm(data.adapter as Record<string, unknown>);
}

async function renderTools(layer: string): Promise<string> {
  const data = await rest.tools(layer);
  const tools = (data.tools as Array<Record<string, unknown>>) ?? [];
  const rows = tools
    .map(
      (t) => `<tr>
        <td>${esc(t.layer ?? layer)}</td>
        <td><a href="${href(`/tools/${encodeURIComponent(String(t.name))}`)}">${esc(t.name)}</a></td>
        <td>${t.protocol ? protoBadge(String(t.protocol)) : "—"}</td>
        <td>${esc(t.description ?? "")}</td>
      </tr>`,
    )
    .join("");
  const tab = (id: string) => `<button data-layer="${id}" class="${layer === id ? "active" : ""}">${id}</button>`;
  return `
    <div class="page-head">
      <div>
        <h2>工具分层</h2>
        <p>business = 协议操作 · management = mcp_* / discovery_* · 默认不要把管理面冲进 Agent 上下文</p>
      </div>
      <div class="tabs" id="layer-tabs">${tab("business")}${tab("management")}${tab("all")}</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>层</th><th>名称</th><th>协议</th><th>说明</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">这一层没有 tools。先 <a href="${href("/adapters/new")}">注册适配器</a>。</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

async function renderTool(name: string): Promise<string> {
  const data = await rest.tool(name);
  const writeHint = data.kind === "management";
  return `
    <div class="page-head">
      <div>
        <h2>${esc(name)}</h2>
        <p>${esc(data.how ?? data.kind ?? "")}</p>
      </div>
      <a class="btn" href="${href("/tools")}">返回列表</a>
    </div>
    <div class="card">
      <h3>Schema</h3>
      <pre>${esc(pretty(data.schema ?? data))}</pre>
    </div>
    ${
      writeHint
        ? `<div class="warn-box">管理工具请走专用 REST / MCP，控制台不提供试调用。</div>`
        : `<form class="card" id="invoke-form" data-name="${esc(name)}">
            <div class="field">
              <label>arguments JSON（只读试调用）</label>
              <textarea name="args">{}</textarea>
            </div>
            <label class="hint"><input type="checkbox" name="confirm" /> 这是写操作，我确认二次提交（仍受 allowWrite 闸）</label>
            <div class="row-actions" style="margin-top:12px">
              <button class="btn primary" type="submit">试调用</button>
            </div>
          </form>
          <pre id="invoke-result" hidden></pre>`
    }
  `;
}

async function renderSettings(): Promise<string> {
  const s = await rest.settings();
  return `
    <div class="page-head">
      <div>
        <h2>设置（只读）</h2>
        <p>进程配置展示。Token 本身不会回显，只显示是否已配置。</p>
      </div>
    </div>
    <div class="grid">
      <div class="card"><h3>应用</h3><div>${esc(s.app)} ${esc(s.version)}</div></div>
      <div class="card"><h3>dataDir</h3><div class="metric" style="font-size:16px">${esc(s.dataDir)}</div></div>
      <div class="card"><h3>allowWrite 默认</h3><div class="metric">false</div></div>
      <div class="card"><h3>CIDR 扫描</h3><div class="metric">off</div></div>
    </div>
    <div class="card">
      <h3>TLS</h3>
      <p class="hint">gRPC <code>tlsWatch: true</code> 换 PEM 后进程内 remount ChannelCredentials，不必 mcp_update（打开的 bidi 会断）。其它适配器仍用保存配置重连。</p>
    </div>
    <div class="card">
      <h3>黑名单</h3>
      <p class="hint">匹配键是 canonical protocol + 规范化 host + port（或规范化 url）。阻止新建与发现一键添加；已挂载实例 invoke 也会被拒绝。</p>
      <div class="row-actions" style="margin-top:12px">
        <a class="btn" href="${href("/blacklist")}">打开黑名单</a>
      </div>
    </div>
    <pre>${esc(pretty(s))}</pre>
  `;
}

async function renderDiscovery(): Promise<string> {
  return `
    <div class="page-head">
      <div>
        <h2>发现向导</h2>
        <p>只扫<strong>单个</strong> hostname / IP。没有 CIDR 输入，服务端也会拒绝网段。单机指纹含 Solr 8983 / RabbitMQ management 15672 / Kubernetes 6443 / Cassandra 9042 / CouchDB 5984 / Whois 43 / Neo4j HTTP 7474 / DNS 53 / Prometheus 9090 / Influx 8086 / NATS 4222 / AMQP 5672 / IMAP 143 / POP3 110 / Consul 8500 / Azure Blob 10000 / SFTP 22 / Memcached 11211 / TFTP 69 / CalDAV·CardDAV 5232 / Beanstalkd 11300 / ZooKeeper 2181 / FTP 21 / SNMP 161 / etcd 2379 / WebDAV OPTIONS / <strong>SSDP 单播 1900</strong> / <strong>DNS-SD 单播 5353</strong>（不是 224.0.0.251 组播浏览）。草案默认 <code>allowWrite=false</code>。</p>
      </div>
    </div>
    <div class="wizard">
      <div class="steps">
        <span class="on">1 · 主机</span>
        <span>2 · 候选</span>
        <span>3 · 注册</span>
      </div>
      <form class="card" id="scan-form">
        <div class="field">
          <label>host</label>
          <input name="host" placeholder="127.0.0.1 或 broker.internal" required />
        </div>
        <div class="field">
          <label>port（可选）</label>
          <input name="port" type="number" min="1" max="65535" />
        </div>
        <label class="hint"><input type="checkbox" name="https" /> HTTPS 路径探测</label>
        <label class="hint"><input type="checkbox" name="onlyGivenPort" /> 只探给定端口</label>
        <div class="row-actions" style="margin-top:12px">
          <button class="btn primary" type="submit">扫描主机</button>
        </div>
      </form>
    </div>
    <div id="scan-out"></div>
  `;
}

async function renderCapabilities(): Promise<string> {
  const listed = await rest.adapters();
  const adapters = (listed.adapters as Array<Record<string, unknown>>) ?? [];
  const liveRows = adapters
    .map(
      (a) => `<tr>
        <td>${statusDot(a.status === "live", a.status !== "live")}</td>
        <td><a href="${href(`/adapters/${encodeURIComponent(String(a.id))}`)}">${esc(a.id)}</a></td>
        <td>${protoBadge(String(a.protocol))}</td>
        <td>${ingressBadge(a.ingress)}</td>
        <td>${esc(a.toolCount ?? 0)}</td>
        <td>${a.allowWrite === true ? "on" : "off"}</td>
        <td><button class="btn" type="button" data-hot-del="${esc(a.id)}">热卸载</button></td>
      </tr>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>热加载 / 热卸载</h2>
        <p>部署只带最小 MCP 核心。能力增长走共享管道：环境盘点 / Compat 扫描 / 发现建议 → 策略闸 → 确认（或 Safe+只读自动）。<strong>热卸载</strong>走同一 Policy Gateway。南向优先：Partner → native → mcp_bridge 兜底。扫描成功 ≠ 打开写/桌面/密钥。</p>
      </div>
    </div>
    <div class="table-wrap" style="margin-bottom:16px">
      <table>
        <thead><tr><th></th><th>ID</th><th>协议</th><th>ingress</th><th>Tools</th><th>写</th><th></th></tr></thead>
        <tbody>${liveRows || `<tr><td colspan="7" class="empty">还没有热加载的能力。下方盘点或手动配置后确认热加载。</td></tr>`}</tbody>
      </table>
    </div>
    <div class="row-actions" style="margin-bottom:12px">
      <button class="btn primary" type="button" id="inv-btn">本机环境盘点</button>
    </div>
    <div id="inv-out"></div>
    <form class="card" id="manual-hotadd">
      <h3>手动配置热加载</h3>
      <div class="field">
        <label>protocol</label>
        <input name="protocol" placeholder="os_info" required />
      </div>
      <div class="field">
        <label>name</label>
        <input name="name" placeholder="local" required />
      </div>
      <div class="field">
        <label>config JSON</label>
        <textarea name="config">{"allowWrite":false}</textarea>
      </div>
      <label class="hint"><input type="checkbox" name="auto" /> auto（仅 Safe + 只读 + 非黑名单）</label>
      <div class="row-actions">
        <button class="btn primary" type="submit">确认热加载</button>
      </div>
    </form>
    <pre id="hotadd-result" hidden></pre>
  `;
}

async function renderPartner(): Promise<string> {
  const [listed, token] = await Promise.all([rest.partnerConnections(), rest.partnerToken()]);
  const connections = ((listed as { connections?: Array<Record<string, unknown>> }).connections ?? []) as Array<
    Record<string, unknown>
  >;
  const rows = connections
    .map(
      (a) => `<tr>
        <td>${statusDot(a.status === "live", a.status !== "live")}</td>
        <td>${esc(a.id)}</td>
        <td>${ingressBadge(a.ingress ?? "partner")}</td>
        <td>${esc(a.toolCount ?? 0)}</td>
        <td><button class="btn" type="button" data-hot-del="${esc(a.id)}">确认卸载</button></td>
      </tr>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>Partner 连接</h2>
        <p>南向优先 Partner 协议。应用<strong>不实现 MCP</strong>。Agent 只配置一个 Everything2MCP。mcp_bridge 是兜底，不是主路径。</p>
      </div>
    </div>
    <div class="card">
      <h3>本地 Partner token</h3>
      <p class="hint">写在 <code>dataDir/partner-token</code>。和 HTTP_TOKEN 分开。循环回环 + Partner token 才能 register/heartbeat/unregister。</p>
      <pre>${esc((token as { token?: string }).token ?? "")}</pre>
      <button class="btn" type="button" id="rotate-partner-token">轮换 token（需确认）</button>
    </div>
    <div class="table-wrap" style="margin:16px 0">
      <table>
        <thead><tr><th></th><th>ID</th><th>ingress</th><th>Tools</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">还没有 Partner。把清单丢进 ~/.everything2mcp/drops 或跑 examples/partner-demo-chat。</td></tr>`}</tbody>
      </table>
    </div>
    <div class="row-actions">
      <button class="btn primary" type="button" id="compat-scan-btn">Compat 扫描</button>
    </div>
    <div id="compat-out"></div>
  `;
}

async function renderImport(): Promise<string> {
  return `
    <div class="page-head">
      <div>
        <h2>Schema 导入</h2>
        <p>OpenAPI / WSDL / proto / GraphQL SDL / AsyncAPI。OData / JSON:API / tRPC / Connect 为 import-first。</p>
      </div>
    </div>
    <form class="card" id="import-form">
      <div class="field">
        <label>source（文件路径或 http(s) URL）</label>
        <input name="source" placeholder="./examples/petstore.openapi.json" required />
      </div>
      <div class="field">
        <label>kind（可空，自动检测）</label>
        <select name="kind">
          <option value="">auto</option>
          <option>openapi</option><option>wsdl</option><option>proto</option>
          <option>graphql</option><option>asyncapi</option>
          <option>odata</option><option>jsonapi</option><option>trpc</option><option>connectrpc</option>
        </select>
      </div>
      <div class="field">
        <label>注册名（可选）</label>
        <input name="name" />
      </div>
      <label class="hint"><input type="checkbox" name="register" checked /> 导入后注册适配器</label>
      <div class="field">
        <label>额外 config JSON（可选）</label>
        <textarea name="config">{}</textarea>
      </div>
      <div class="row-actions">
        <button class="btn primary" type="submit">导入</button>
      </div>
    </form>
    <pre id="import-result" hidden></pre>
  `;
}

async function renderMatrix(): Promise<string> {
  const data = await rest.matrix();
  const protocols = (data.protocols as Array<Record<string, unknown>>) ?? [];
  const rows = protocols
    .map(
      (p) => `<tr>
        <td>${protoBadge(String(p.id))}</td>
        <td>${esc(p.canonical)}</td>
        <td>${esc(p.registered ?? 0)}</td>
        <td>${esc(p.help)}</td>
      </tr>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>协议矩阵</h2>
        <p>只读目录。不在这里打开新协议宇宙。Solr <code>update</code> / RabbitMQ management <code>publish</code> 仍受 <code>allowWrite=false</code>。Kubernetes 只读 list/get；<code>exec</code>/<code>apply</code> 为 <code>E_UNSUPPORTED</code>。RabbitMQ management 不是 AMQP 0-9-1（线协议仍走 <code>amqp</code>）。</p>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Canonical</th><th>已注册</th><th>config</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function renderAudit(): Promise<string> {
  const data = await rest.audit(80);
  const counts = (data.counts as { success?: number; fail?: number }) ?? {};
  const events = (data.events as Array<Record<string, unknown>>) ?? [];
  const rows = events
    .map(
      (e) => `<div class="tl-row">
        ${statusDot(e.ok === true, e.ok === false)}
        <div>
          <div class="tl-title">${esc(e.tool ?? "(invoke)")} ${e.protocol ? protoBadge(String(e.protocol)) : ""}</div>
          <div class="hint">${esc(e.detail ?? e.code ?? (e.ok ? "ok" : "fail"))}${e.adapterId ? ` · ${esc(e.adapterId)}` : ""}</div>
        </div>
        <div class="tl-meta">${esc(e.at)}</div>
      </div>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>审计时间线</h2>
        <p>持久化到 <code>dataDir/audit.jsonl</code>（启动重载尾部）。密钥字段已脱敏。</p>
      </div>
    </div>
    <div class="grid">
      <div class="card"><h3>成功</h3><div class="metric">${esc(counts.success ?? 0)}</div></div>
      <div class="card"><h3>失败</h3><div class="metric">${esc(counts.fail ?? 0)}</div></div>
    </div>
    <div class="card timeline">
      ${rows || `<div class="empty">还没有业务 invoke。去 <a href="${href("/tools")}">工具</a> 做一次只读试调用。</div>`}
    </div>
  `;
}

async function renderPlan(): Promise<string> {
  return `
    <div class="page-head">
      <div>
        <h2>计划桥</h2>
        <p>调用 <code>mcp_plan_bridge</code>。有 host 则下一步是发现；有 spec 则跳转导入。不扫描网段。</p>
      </div>
    </div>
    <form class="card" id="plan-form">
      <div class="field">
        <label>目标（自然语言）</label>
        <input name="goal" required placeholder="把 10.0.0.8 上的 REST 和 MQTT 接进来" />
      </div>
      <div class="field">
        <label>host（可选，单个 hostname / IP）</label>
        <input name="host" placeholder="127.0.0.1" />
      </div>
      <div class="row-actions">
        <button class="btn primary" type="submit">生成计划</button>
        <a class="btn" href="${href("/discovery")}">去发现</a>
        <a class="btn" href="${href("/import")}">去导入</a>
      </div>
    </form>
    <div id="plan-out"></div>
  `;
}

async function renderBlacklist(): Promise<string> {
  const data = await rest.blacklist();
  const entries = (data.entries as Array<Record<string, unknown>>) ?? [];
  const rows = entries
    .map(
      (e) => `<tr>
        <td><code>${esc(e.id)}</code></td>
        <td>${protoBadge(String(e.protocol))}</td>
        <td>${esc(e.host)}</td>
        <td>${esc(e.port)}</td>
        <td>${esc(e.reason ?? "—")}</td>
        <td>${esc(e.createdAt ?? "")}</td>
        <td><button class="btn danger" type="button" data-bl-id="${esc(e.id)}">解除拉黑</button></td>
      </tr>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>黑名单</h2>
        <p>匹配 <code>protocol + 规范化 host + port</code>（无 host 时退回规范化 url）。持久化在 dataDir 的 <code>blacklist.json</code>，与 registrations 同级。不扫描网段。</p>
      </div>
      <a class="btn" href="${href("/discovery")}">去发现</a>
    </div>
    <form class="card" id="blacklist-form">
      <div class="field">
        <label>协议</label>
        <input name="protocol" required placeholder="mqtt / openapi / redis" />
      </div>
      <div class="field">
        <label>host</label>
        <input name="host" placeholder="10.0.0.8 或 broker.internal" />
      </div>
      <div class="field">
        <label>port</label>
        <input name="port" type="number" min="1" max="65535" />
      </div>
      <div class="field">
        <label>url（可选；没有 host+port 时用）</label>
        <input name="url" placeholder="mqtt://10.0.0.8:1883" />
      </div>
      <div class="field">
        <label>原因（可选）</label>
        <input name="reason" placeholder="生产禁扫 / 误探到的邻居" />
      </div>
      <div class="row-actions">
        <button class="btn primary" type="submit">加入黑名单</button>
      </div>
    </form>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>协议</th><th>Host</th><th>Port</th><th>原因</th><th>时间</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7" class="empty">还没有拉黑目标。从 <a href="${href("/discovery")}">发现</a> 结果行加入，或用上面的表单。</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

async function renderSecurity(): Promise<string> {
  const data = await rest.security();
  const mode = String(data.mode ?? "safe");
  const modules = (data.modules as Array<Record<string, unknown>>) ?? [];
  const rows = modules
    .map(
      (m) => `<tr>
        <td><code>${esc(m.id)}</code></td>
        <td>${m.locked === true ? "锁定" : "—"}</td>
        <td>${m.bypassInFullControl === true ? "Full 可跳过" : "两模式都跑"}</td>
        <td>${esc(Array.isArray(m.hooks) ? (m.hooks as string[]).join(", ") : "")}</td>
      </tr>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>安全</h2>
        <p>Safe / Full 热切换。Full 仍执行黑名单与 CIDR 禁止，<strong>不会</strong>全局打开 allowWrite。模式不是 MCP tool。</p>
      </div>
      <span class="capsule">${statusDot(mode === "safe")}${esc(mode.toUpperCase())}</span>
    </div>
    <div class="card">
      <h3>控制模式</h3>
      <p class="hint">Full 仍要 Token、审计、完整性校验与黑名单，不会打开 CIDR，也不会让适配器跳过 assertCanWrite。切换需二次确认。</p>
      <div class="row-actions" style="margin-top:12px">
        <button class="btn ${mode === "safe" ? "primary" : ""}" type="button" data-mode="safe">Safe</button>
        <button class="btn ${mode === "full" ? "primary" : ""}" type="button" data-mode="full">Full Control</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>模块</th><th>锁定</th><th>Full</th><th>Hooks</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">没有模块。</td></tr>`}</tbody>
      </table>
    </div>
    <div class="card">
      <h3>限流</h3>
      <p class="hint">Safe 下默认 ${esc(String((data.rateLimit as { invokePerMinute?: number } | undefined)?.invokePerMinute ?? 60))} 次 invoke / 分钟、${esc(String((data.rateLimit as { discoverPerMinute?: number } | undefined)?.discoverPerMinute ?? 20))} 次 discover / 分钟。Full 跳过平面 <code>rate-limit</code>。</p>
    </div>
    <div class="card">
      <h3>写闸</h3>
      <p class="hint">平面模块 <code>allow-write</code> 在 Full 下可跳过，<strong>适配器 <code>assertCanWrite</code> 仍检查每条注册的 <code>allowWrite</code></strong>（默认 false）。切 Full 不会变成全局可写。</p>
    </div>
    <div class="card">
      <h3>完整性</h3>
      <p class="hint">SHA-256 账本覆盖 <code>security.json</code> / <code>blacklist.json</code> / <code>registrations.json</code>。配置了 <code>EVERYTHING2MCP_INTEGRITY_KEY</code> 或 <code>.integrity-key</code> 时升级为 HMAC-SHA256（改目标或账本都会失败）。</p>
      <pre class="hint" style="margin-top:8px">${esc(JSON.stringify((data.integrity as object) ?? {}, null, 2))}</pre>
    </div>
    <div class="card">
      <h3>黑名单</h3>
      <p class="hint">Agent 看不到已拉黑目标的 tools。控制台可管理。</p>
      <div class="row-actions" style="margin-top:12px">
        <a class="btn" href="${href("/blacklist")}">打开黑名单</a>
      </div>
    </div>
  `;
}

function blacklistPayloadFromRecord(record: Record<string, unknown>): Record<string, unknown> {
  const config =
    record.config && typeof record.config === "object" && !Array.isArray(record.config)
      ? (record.config as Record<string, unknown>)
      : {};
  const source =
    record.source && typeof record.source === "object" && !Array.isArray(record.source)
      ? (record.source as Record<string, unknown>)
      : {};
  const body: Record<string, unknown> = { protocol: String(record.protocol ?? "") };
  if (typeof config.host === "string" && config.host.trim()) body.host = config.host;
  if (typeof config.port === "number" && config.port > 0) body.port = config.port;
  const url =
    (typeof config.url === "string" && config.url) ||
    (typeof config.spec === "string" && config.spec) ||
    (typeof config.endpoint === "string" && config.endpoint) ||
    (typeof config.baseUrl === "string" && config.baseUrl) ||
    (typeof config.brokerUrl === "string" && config.brokerUrl) ||
    (typeof record.url === "string" && record.url) ||
    (typeof source.url === "string" && source.url) ||
    "";
  if (url) body.url = url;
  if (typeof record.reason === "string" && record.reason.trim()) body.reason = record.reason;
  return body;
}

function bindPage(page: Page): void {
  if (page.name === "tools") {
    document.getElementById("layer-tabs")?.addEventListener("click", (ev) => {
      const btn = (ev.target as HTMLElement).closest("button[data-layer]");
      const layer = btn?.getAttribute("data-layer");
      if (layer) location.hash = `/tools?layer=${layer}`;
    });
  }

  document.querySelectorAll("button[data-hot-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = (btn as HTMLElement).dataset.hotDel;
      if (!id) return;
      if (!window.confirm(`热卸载 ${id}？会断开适配器并从 Catalog / MCP tools/list 立刻拿掉。不要求 allowWrite。`)) return;
      try {
        await rest.hotRemove(id);
        showToast("ok", `已热卸载 ${id}`);
        void render();
      } catch (err) {
        showToast("err", err instanceof Error ? err.message : String(err));
      }
    });
  });

  document.getElementById("rotate-partner-token")?.addEventListener("click", async () => {
    if (!window.confirm("轮换本地 Partner token？已连接的 Partner 应用需要改用新 token。")) return;
    try {
      await rest.rotatePartnerToken();
      showToast("ok", "Partner token 已轮换");
      void render();
    } catch (err) {
      showToast("err", err instanceof Error ? err.message : String(err));
    }
  });

  document.getElementById("compat-scan-btn")?.addEventListener("click", async () => {
    const box = document.getElementById("compat-out");
    if (box) box.innerHTML = `<div class="hint">扫描 Compat…</div>`;
    try {
      const data = await rest.compatScan();
      const suggestions = ((data as { suggestions?: Array<Record<string, unknown>> }).suggestions ?? []) as Array<
        Record<string, unknown>
      >;
      const cards = suggestions
        .map(
          (s, i) => `<div class="card">
            <div>${protoBadge(String(s.protocol))} ${ingressBadge(s.ingress)} <strong>${esc(s.name)}</strong> · ${esc(s.priority ?? "")}</div>
            <div class="hint">${esc(s.reason ?? "")}</div>
            <pre>${esc(pretty(s.config))}</pre>
            <button class="btn primary" type="button" data-compat-sug="${i}">确认热加载</button>
          </div>`,
        )
        .join("");
      if (box) box.innerHTML = `<p class="hint">建议 ${suggestions.length} 条。扫描本身不注册、不打开写。</p>${cards}`;
      box?.querySelectorAll("button[data-compat-sug]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const i = Number((btn as HTMLElement).dataset.compatSug);
          const s = suggestions[i];
          if (!s) return;
          try {
            const r = await rest.hotAdd({ ...s, confirm: true });
            showToast("ok", `已热加载 ${String((r as { id?: string }).id ?? s.protocol)}`);
            void render();
          } catch (err) {
            showToast("err", err instanceof Error ? err.message : String(err));
          }
        });
      });
    } catch (err) {
      if (box) box.innerHTML = `<div class="warn-box">${esc(err instanceof Error ? err.message : String(err))}</div>`;
    }
  });

  document.getElementById("inv-btn")?.addEventListener("click", async () => {
    const box = document.getElementById("inv-out");
    if (box) box.innerHTML = `<div class="hint">盘点本机…</div>`;
    try {
      const data = await rest.inventory();
      const suggestions = (data.suggestions as Array<Record<string, unknown>>) ?? [];
      const cards = suggestions
        .map(
          (s, i) => `<div class="card">
            <div>${protoBadge(String(s.protocol))} <strong>${esc(s.name)}</strong> · ${esc(s.confidence ?? "")}</div>
            <div class="hint">${esc(s.reason ?? "")}</div>
            <pre>${esc(pretty(s.config))}</pre>
            <div class="row-actions">
              <button class="btn primary" type="button" data-hot-sug="${i}">确认热加载</button>
              <button class="btn" type="button" data-hot-auto="${i}">Safe 只读自动</button>
            </div>
          </div>`,
        )
        .join("");
      if (box) {
        box.innerHTML = `<p class="hint">建议 ${suggestions.length} 条。盘点本身不注册。</p>${cards}<pre>${esc(pretty((data as { inventory?: unknown }).inventory))}</pre>`;
      }
      const list = suggestions;
      box?.querySelectorAll("button[data-hot-sug]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const i = Number((btn as HTMLElement).dataset.hotSug);
          const suggestion = list[i];
          if (!suggestion) return;
          if (!window.confirm("确认热加载该只读能力？不会打开 allowWrite。")) return;
          try {
            await rest.hotAdd({ suggestion, confirm: true });
            showToast("ok", `已热加载 ${String(suggestion.protocol)}:${String(suggestion.name)}`);
            void render();
          } catch (err) {
            showToast("err", err instanceof Error ? err.message : String(err));
          }
        });
      });
      box?.querySelectorAll("button[data-hot-auto]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const i = Number((btn as HTMLElement).dataset.hotAuto);
          const suggestion = list[i];
          if (!suggestion) return;
          try {
            await rest.hotAdd({ suggestion, auto: true });
            showToast("ok", `auto 热加载 ${String(suggestion.protocol)}:${String(suggestion.name)}`);
            void render();
          } catch (err) {
            showToast("err", err instanceof Error ? err.message : String(err));
          }
        });
      });
    } catch (err) {
      showToast("err", err instanceof Error ? err.message : String(err));
    }
  });

  const manualHot = document.getElementById("manual-hotadd") as HTMLFormElement | null;
  if (manualHot) {
    manualHot.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(manualHot);
      let config: unknown = {};
      try {
        config = JSON.parse(String(fd.get("config") || "{}"));
      } catch {
        showToast("err", "config JSON 无效");
        return;
      }
      const body = {
        protocol: String(fd.get("protocol") || "").trim(),
        name: String(fd.get("name") || "").trim(),
        config,
        confirm: true,
        auto: Boolean(fd.get("auto")),
      };
      if (!window.confirm("确认热加载？默认 allowWrite=false。")) return;
      try {
        const r = await rest.hotAdd(body);
        const pre = document.getElementById("hotadd-result");
        if (pre) {
          pre.hidden = false;
          pre.textContent = pretty(r);
        }
        showToast("ok", `已热加载 ${body.protocol}:${body.name}`);
      } catch (err) {
        showToast("err", err instanceof Error ? err.message : String(err));
      }
    });
  }

  const adapterForm = document.getElementById("adapter-form") as HTMLFormElement | null;
  if (adapterForm) {
    const help = adapterForm.querySelector("#proto-help");
    adapterForm.querySelector("select[name=protocol]")?.addEventListener("change", async (ev) => {
      const proto = (ev.target as HTMLSelectElement).value;
      try {
        const settings = await rest.settings();
        const map = (settings.protocolHelp as Record<string, string>) ?? {};
        if (help) help.textContent = map[proto] ?? "";
      } catch {
        /* ignore */
      }
    });
    adapterForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(adapterForm);
      let config: unknown;
      try {
        config = JSON.parse(String(fd.get("config") || "{}"));
      } catch (err) {
        showToast("err", `config JSON 无效: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      try {
        const id = adapterForm.dataset.id;
        if (id) {
          await rest.updateAdapter(id, config);
          showToast("ok", `已更新 ${id}`);
          location.hash = `/adapters/${encodeURIComponent(id)}`;
        } else {
          const created = await rest.createAdapter({
            protocol: String(fd.get("protocol")),
            name: String(fd.get("name")),
            config,
          });
          showToast("ok", `已注册 ${String((created as { id?: string }).id)}`);
          location.hash = `/adapters/${encodeURIComponent(String((created as { id?: string }).id))}`;
        }
        void render();
      } catch (err) {
        showToast("err", err instanceof Error ? err.message : String(err));
      }
    });
    document.getElementById("ping-btn")?.addEventListener("click", async () => {
      const id = adapterForm.dataset.id;
      if (!id) return;
      const out = document.getElementById("adapter-result");
      try {
        const r = await rest.ping(id);
        if (out) {
          out.hidden = false;
          out.textContent = pretty(r);
        }
      } catch (err) {
        if (out) {
          out.hidden = false;
          out.textContent = err instanceof Error ? err.message : String(err);
        }
      }
    });
    document.getElementById("del-btn")?.addEventListener("click", async () => {
      const id = adapterForm.dataset.id;
      if (!id) return;
      if (!window.confirm(`删除适配器 ${id}？此操作会断开并卸载其 tools。`)) return;
      try {
        await rest.deleteAdapter(id);
        showToast("ok", `已删除 ${id}`);
        location.hash = "/adapters";
        void render();
      } catch (err) {
        showToast("err", err instanceof Error ? err.message : String(err));
      }
    });
  }

  const invokeForm = document.getElementById("invoke-form") as HTMLFormElement | null;
  if (invokeForm) {
    invokeForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = invokeForm.dataset.name ?? "";
      const fd = new FormData(invokeForm);
      const confirm = Boolean(fd.get("confirm"));
      let args: unknown = {};
      try {
        args = JSON.parse(String(fd.get("args") || "{}"));
      } catch (err) {
        showToast("err", `arguments JSON 无效: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const out = document.getElementById("invoke-result");
      try {
        const r = await rest.invoke(name, args, confirm);
        if (out) {
          out.hidden = false;
          out.textContent = pretty(r);
        }
      } catch (err) {
        if (out) {
          out.hidden = false;
          out.textContent = pretty((err as { body?: unknown }).body ?? (err instanceof Error ? err.message : String(err)));
        }
      }
    });
  }

  const scanForm = document.getElementById("scan-form") as HTMLFormElement | null;
  if (scanForm) {
    scanForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(scanForm);
      const host = String(fd.get("host") || "").trim();
      if (/[\/,]|-\s*\d|\*/.test(host) || host.includes("/")) {
        showToast("err", "只接受单个 host，不接受 CIDR / 范围 / 列表。");
        return;
      }
      const portRaw = String(fd.get("port") || "");
      const body: Record<string, unknown> = {
        host,
        https: Boolean(fd.get("https")),
        onlyGivenPort: Boolean(fd.get("onlyGivenPort")),
      };
      if (portRaw) body.port = Number(portRaw);
      const box = document.getElementById("scan-out");
      if (box) box.innerHTML = `<div class="hint">扫描 ${esc(host)}…</div>`;
      try {
        const scanned = await rest.scan(body);
        const suggestions = (scanned.suggestions as Array<Record<string, unknown>>) ?? [];
        const blocked = (scanned.blocked as Array<Record<string, unknown>>) ?? [];
        const hidden = Number(scanned.hiddenBlacklisted ?? blocked.length);
        const cards = suggestions
          .map(
            (s, i) => `<div class="card">
              <div>${protoBadge(String(s.protocol))} <strong>${esc(s.name)}</strong> · ${esc(s.confidence ?? "")}</div>
              <pre>${esc(pretty(s.config))}</pre>
              <div class="row-actions">
                <button class="btn primary" data-sug="${i}">注册此草案</button>
                <button class="btn danger" type="button" data-bl-sug="${i}">加入黑名单</button>
              </div>
            </div>`,
          )
          .join("");
        const blockedCards = blocked
          .map(
            (c) => `<div class="card blocked">
              <div>${protoBadge(String(c.protocol))} <strong>${esc(c.title ?? c.url)}</strong> <span class="proto blocked-tag">已拉黑</span></div>
              <p class="hint">${esc(c.url)} · ${esc(c.blacklistId ?? "")}。不可一键添加。</p>
            </div>`,
          )
          .join("");
        if (box) {
          box.innerHTML = `
            ${cards || `<div class="empty">没有可注册建议。${hidden ? `已过滤 ${hidden} 条黑名单候选。` : "原始候选见下方。"}</div>`}
            ${blockedCards ? `<div class="page-head"><div><h2>已拉黑</h2><p>这些候选被标记且不可一键注册。去 <a href="${href("/blacklist")}">黑名单</a> 解除。</p></div></div>${blockedCards}` : ""}
            <pre>${esc(pretty(scanned))}</pre>`;
          box.querySelectorAll("button[data-sug]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const i = Number((btn as HTMLElement).dataset.sug);
              const suggestion = suggestions[i];
              if (!suggestion) return;
              if (!window.confirm(`注册 ${suggestion.protocol}:${suggestion.name}？写入仍默认关闭。`)) return;
              try {
                const r = await rest.registerSuggestion({ suggestion });
                showToast("ok", `已注册 ${String((r as { id?: string }).id)}`);
                location.hash = `/adapters/${encodeURIComponent(String((r as { id?: string }).id))}`;
                void render();
              } catch (err) {
                showToast("err", err instanceof Error ? err.message : String(err));
              }
            });
          });
          box.querySelectorAll("button[data-bl-sug]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const i = Number((btn as HTMLElement).dataset.blSug);
              const suggestion = suggestions[i];
              if (!suggestion) return;
              try {
                const r = await rest.addBlacklist({
                  ...blacklistPayloadFromRecord(suggestion),
                  reason: "console discovery",
                });
                const id = String(((r as { entry?: { id?: string } }).entry?.id) ?? "entry");
                showToast("ok", `已拉黑 ${id}`);
                scanForm.requestSubmit();
              } catch (err) {
                showToast("err", err instanceof Error ? err.message : String(err));
              }
            });
          });
        }
      } catch (err) {
        if (box) box.innerHTML = `<div class="err-box">${esc(err instanceof Error ? err.message : String(err))}</div>`;
      }
    });
  }

  const importForm = document.getElementById("import-form") as HTMLFormElement | null;
  if (importForm) {
    importForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(importForm);
      let extra = {};
      try {
        extra = JSON.parse(String(fd.get("config") || "{}"));
      } catch (err) {
        showToast("err", `config JSON 无效: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const body: Record<string, unknown> = {
        source: String(fd.get("source")),
        register: Boolean(fd.get("register")),
        config: extra,
      };
      const kind = String(fd.get("kind") || "");
      const name = String(fd.get("name") || "");
      if (kind) body.kind = kind;
      if (name) body.name = name;
      const out = document.getElementById("import-result");
      try {
        const r = await rest.importSchema(body);
        if (out) {
          out.hidden = false;
          out.textContent = pretty(r);
        }
        const id = (r as { id?: string }).id;
        if (id) {
          showToast("ok", `已导入并注册 ${id}`);
        }
      } catch (err) {
        if (out) {
          out.hidden = false;
          out.textContent = pretty((err as { body?: unknown }).body ?? (err instanceof Error ? err.message : String(err)));
        }
      }
    });
  }

  const planForm = document.getElementById("plan-form") as HTMLFormElement | null;
  if (planForm) {
    planForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(planForm);
      const goal = String(fd.get("goal") || "").trim();
      const host = String(fd.get("host") || "").trim();
      if (host && (/[\/,]|\*/.test(host) || host.includes("/"))) {
        showToast("err", "host 只接受单个地址，不接受 CIDR。");
        return;
      }
      const box = document.getElementById("plan-out");
      try {
        const r = await rest.plan({ goal, ...(host ? { host } : {}) });
        const plan = (r.plan ?? r) as Record<string, unknown>;
        const recs = (plan.recommendations as Array<Record<string, unknown>>) ?? [];
        const steps = (plan.steps as Array<Record<string, unknown>>) ?? [];
        const recHtml = recs
          .map(
            (rec) => `<div class="card">
              ${protoBadge(String(rec.protocol))} <span class="hint">${esc(rec.reason)}</span>
              <pre>${esc(pretty(rec.exampleConfig))}</pre>
            </div>`,
          )
          .join("");
        const stepHtml = steps
          .map((s) => {
            const tool = String(s.tool ?? "");
            const jump =
              tool === "discovery_scan_host"
                ? href("/discovery")
                : tool === "schema_import"
                  ? href("/import")
                  : tool === "mcp_add" || tool === "mcp_add_from_discovery"
                    ? href("/adapters/new")
                    : tool === "mcp_health"
                      ? href("/")
                      : href("/tools");
            return `<div class="tl-row">
              ${statusDot(true)}
              <div>
                <div class="tl-title"><a href="${jump}">${esc(tool)}</a></div>
                <div class="hint">${esc(s.why)}</div>
                <pre>${esc(pretty(s.arguments))}</pre>
              </div>
            </div>`;
          })
          .join("");
        if (box) {
          box.innerHTML = `
            <div class="page-head"><div><h2>步骤</h2><p>点工具名跳到 Discovery / Import / 适配器。</p></div></div>
            <div class="card timeline">${stepHtml}</div>
            <div class="page-head"><div><h2>推荐协议</h2></div></div>
            ${recHtml}
            <pre>${esc(pretty(plan))}</pre>`;
        }
      } catch (err) {
        showToast("err", err instanceof Error ? err.message : String(err));
      }
    });
  }

  const blacklistForm = document.getElementById("blacklist-form") as HTMLFormElement | null;
  if (blacklistForm) {
    blacklistForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(blacklistForm);
      const protocol = String(fd.get("protocol") || "").trim();
      const host = String(fd.get("host") || "").trim();
      const url = String(fd.get("url") || "").trim();
      const reason = String(fd.get("reason") || "").trim();
      const portRaw = String(fd.get("port") || "").trim();
      if (host && (/[\/,]|\*/.test(host) || host.includes("/"))) {
        showToast("err", "host 只接受单个地址，不接受 CIDR。");
        return;
      }
      const body: Record<string, unknown> = { protocol };
      if (host) body.host = host;
      if (portRaw) body.port = Number(portRaw);
      if (url) body.url = url;
      if (reason) body.reason = reason;
      try {
        const r = await rest.addBlacklist(body);
        showToast("ok", `已拉黑 ${String((r as { entry?: { id?: string } }).entry?.id ?? protocol)}`);
        void render();
      } catch (err) {
        showToast("err", err instanceof Error ? err.message : String(err));
      }
    });
    document.querySelectorAll("button[data-bl-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = (btn as HTMLElement).dataset.blId;
        if (!id) return;
        if (!window.confirm(`解除拉黑 ${id}？之后发现与 mcp_add 可以再次添加该目标。`)) return;
        try {
          await rest.removeBlacklist(id);
          showToast("ok", `已解除 ${id}`);
          void render();
        } catch (err) {
          showToast("err", err instanceof Error ? err.message : String(err));
        }
      });
    });
  }

  document.querySelectorAll("button[data-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = (btn as HTMLElement).dataset.mode;
      if (mode !== "safe" && mode !== "full") return;
      if (!window.confirm(`切换到 ${mode.toUpperCase()}？Full 仍执行黑名单，不会打开 CIDR，也不会全局打开 allowWrite。`)) return;
      try {
        await rest.setMode(mode);
        showToast("ok", `模式已切换为 ${mode}`);
        void render();
      } catch (err) {
        showToast("err", err instanceof Error ? err.message : String(err));
      }
    });
  });
}

window.addEventListener("hashchange", () => {
  void render();
});
void render();
