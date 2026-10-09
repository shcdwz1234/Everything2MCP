import { getToken, rest, setToken } from "./api.js";

type CapTab = "current" | "supported" | "blacklist";

type Page =
  | { name: "caps"; tab: CapTab }
  | { name: "add"; type?: string; source?: string; edit?: string }
  | { name: "activity" }
  | { name: "settings" }
  | { name: "tools"; layer: string }
  | { name: "tool"; tool: string }
  | { name: "discovery" }
  | { name: "import" }
  | { name: "matrix" }
  | { name: "audit" }
  | { name: "plan" }
  | { name: "security" }
  | { name: "hotload" }
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
  const tabOf = (v: string | null): CapTab => (v === "supported" || v === "blacklist" ? v : "current");
  // New IA: 能力 / 活动 / 设置. Old hashes redirect into the new locations.
  if (parts.length === 0 || parts[0] === "caps") return { name: "caps", tab: tabOf(query.get("tab")) };
  if (parts[0] === "adapters" && parts[1] === "new") return { name: "add", type: query.get("type") ?? undefined };
  if (parts[0] === "adapters" && parts[1]) return { name: "add", edit: decodeURIComponent(parts[1]) };
  if (parts[0] === "adapters" || parts[0] === "capabilities") return { name: "caps", tab: "current" };
  if (parts[0] === "blacklist") return { name: "caps", tab: "blacklist" };
  if (parts[0] === "add") {
    return {
      name: "add",
      type: query.get("type") ?? undefined,
      source: query.get("source") ?? undefined,
      edit: query.get("edit") ?? undefined,
    };
  }
  if (parts[0] === "activity") return { name: "activity" };
  if (parts[0] === "tools" && parts[1]) return { name: "tool", tool: decodeURIComponent(parts[1]) };
  if (parts[0] === "tools") return { name: "tools", layer: query.get("layer") || "business" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "discovery") return { name: "discovery" };
  if (parts[0] === "import") return { name: "import" };
  if (parts[0] === "matrix") return { name: "matrix" };
  if (parts[0] === "audit") return { name: "audit" };
  if (parts[0] === "plan") return { name: "plan" };
  if (parts[0] === "security") return { name: "security" };
  if (parts[0] === "hotload") return { name: "hotload" };
  if (parts[0] === "partner") return { name: "partner" };
  return { name: "caps", tab: "current" };
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

const ADVANCED_PAGES = new Set(["tools", "tool", "discovery", "import", "matrix", "audit", "plan", "security", "hotload", "partner"]);

function navLink(page: Page, hrefPath: string, label: string, extra = ""): string {
  const target = hrefPath.replace(/^\//, "").split("?")[0] || "caps";
  const current =
    (target === "caps" && (page.name === "caps" || page.name === "add")) ||
    (target === "tools" && (page.name === "tools" || page.name === "tool")) ||
    page.name === target;
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
        ${navLink(page, "/caps", "能力")}
        ${navLink(page, "/activity", "活动")}
        ${navLink(page, "/settings", "设置")}
        <details class="nav-adv" ${ADVANCED_PAGES.has(page.name) ? "open" : ""}>
          <summary>高级</summary>
          ${navLink(page, "/tools", "工具分层")}
          ${navLink(page, "/discovery", "单主机扫描")}
          ${navLink(page, "/import", "导入 Schema")}
          ${navLink(page, "/hotload", "环境盘点")}
          ${navLink(page, "/partner", "Partner")}
          ${navLink(page, "/plan", "计划桥")}
          ${navLink(page, "/security", "安全模块")}
          ${navLink(page, "/audit", "原始审计")}
          ${navLink(page, "/matrix", "协议矩阵")}
        </details>
      </nav>
      <div class="side-foot">
        默认 <code>allowWrite=false</code><br/>
        自动发现只扫私网，元数据地址永不扫描<br/>
        黑名单在 Full 模式下仍生效
      </div>
    </aside>
    <section class="main">
      <header class="topbar">
        <button class="nav-toggle" id="nav-toggle" type="button" aria-label="菜单">☰</button>
        <div class="capsules">
          <span class="capsule">${statusDot(true)} ${esc(transport)} 监听</span>
          <span class="capsule">${statusDot(adapters >= 0)} 能力 ${adapters}</span>
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
    case "caps":
      return renderCaps(page.tab);
    case "add":
      return renderAdd(page);
    case "activity":
      return renderActivity();
    case "settings":
      return renderSettingsPage();
    case "tools":
      return renderTools(page.layer);
    case "tool":
      return renderTool(page.tool);
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
    case "security":
      return renderSecurity();
    case "hotload":
      return renderCapabilities();
    case "partner":
      return renderPartner();
  }
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
        <tbody>${rows || `<tr><td colspan="4" class="empty">这一层没有 tools。先 <a href="${href("/add")}">注册适配器</a>。</td></tr>`}</tbody>
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
  const [listed, token, bl] = await Promise.all([rest.partnerConnections(), rest.partnerToken(), rest.blacklist()]);
  const connections = ((listed as { connections?: Array<Record<string, unknown>> }).connections ?? []) as Array<
    Record<string, unknown>
  >;
  const blocked = new Map<string, string>();
  for (const e of (((bl as J).entries ?? []) as J[])) {
    if (e.kind === "tool" && typeof e.pattern === "string") blocked.set(e.pattern, String(e.id));
    if (e.kind === "tool" && typeof e.id === "string" && String(e.id).startsWith("tool|")) {
      blocked.set(String(e.id).slice(5), String(e.id));
    }
  }
  const cards = connections
    .map((a) => {
      const ops = (Array.isArray(a.operations) ? a.operations : []) as J[];
      const opRows = ops
        .map((op) => {
          const tool = String(op.tool ?? "");
          const hit = tool && blocked.has(tool) ? blocked.get(tool) : undefined;
          return `<div class="tool-row ${hit ? "blocked" : ""}">
            <div>
              <div class="mono">${esc(op.name)}</div>
              <div class="hint">${esc(op.description ?? "")}${tool ? ` · <span class="mono">${esc(tool)}</span>` : ""}</div>
            </div>
            <div class="row-actions">
              ${op.risk === "write" || op.risk === "desktop" ? tag(String(op.risk), "warn") : tag("只读")}
              ${
                hit
                  ? `${tag("已拉黑", "bad")} <button class="btn sm" type="button" data-unblock="${esc(hit)}">解除</button>`
                  : tool
                    ? `<button class="btn sm danger" type="button" data-tool-bl="${esc(tool)}">拉黑此接口</button>`
                    : ""
              }
            </div>
          </div>`;
        })
        .join("");
      return `<div class="card partner-card" data-partner="${esc(a.id)}">
        <div class="row-actions" style="justify-content:space-between;align-items:flex-start">
          <div>
            <strong>${esc(a.displayName ?? a.name ?? a.id)}</strong>
            ${ingressBadge(a.ingress ?? "partner")}
            ${a.version ? tag(`v${a.version}`) : ""}
            <div class="hint mono">${esc(a.id)}</div>
            ${a.invokeUrl ? `<div class="hint">回调 <span class="mono">${esc(a.invokeUrl)}</span></div>` : `<div class="hint">无 invoke URL</div>`}
          </div>
          <div class="row-actions">
            <a class="btn sm" href="${href(`/caps?tab=current`)}">在当前能力中查看</a>
            <button class="btn sm danger" type="button" data-hot-del="${esc(a.id)}">确认卸载</button>
          </div>
        </div>
        <h4>接口 <span class="hint">${ops.length}</span></h4>
        <p class="hint">每个 Partner operation 对应一个 MCP tool；可单独拉黑（不影响同应用其它接口）。</p>
        ${opRows || `<div class="empty">没有接口</div>`}
      </div>`;
    })
    .join("");
  return `
    <div class="page-head">
      <div>
        <h2>Partner 连接</h2>
        <p>南向优先 Partner 协议。应用<strong>不实现 MCP</strong>。Agent 只配置一个 Everything2MCP。下方列出每个伙伴的<strong>接口</strong>（operations），可单独拉黑。</p>
      </div>
    </div>
    <div class="card">
      <h3>本地 Partner token</h3>
      <p class="hint">写在 <code>dataDir/partner-token</code>。和 HTTP_TOKEN 分开。伙伴应用（如 OmniSearchTools）需设置 <code>E2M_BASE_URL</code> + <code>E2M_PARTNER_TOKEN</code> 才会自动注册到此。</p>
      <pre>${esc((token as { token?: string }).token ?? "")}</pre>
      <button class="btn" type="button" id="rotate-partner-token">轮换 token（需确认）</button>
    </div>
    <div style="margin:16px 0;display:grid;gap:12px">
      ${cards || `<div class="card empty">还没有 Partner。把清单丢进 drops，或启动 OmniSearchTools（配置 E2M_PARTNER_TOKEN 后会自动连接）。</div>`}
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
        <a class="btn" href="${href("/caps?tab=blacklist")}">打开黑名单</a>
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
  if (page.name === "caps") bindCaps(page.tab);
  if (page.name === "add") bindAdd();
  if (page.name === "settings") bindSettingsPage();
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

  
  if (page.name === "partner") {
    document.querySelectorAll("button[data-tool-bl]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = (btn as HTMLElement).dataset.toolBl;
        if (!name) return;
        if (!window.confirm(`拉黑接口工具 ${name}？Agent 将看不到也调不了它；同 Partner 其它接口不受影响。`)) return;
        try {
          await rest.addBlacklist({ kind: "tool", pattern: name, reason: "console partner interface" });
          showToast("ok", `已拉黑 ${name}`);
          void render();
        } catch (err) {
          showToast("err", err instanceof Error ? err.message : String(err));
        }
      });
    });
    document.querySelectorAll("button[data-unblock]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = (btn as HTMLElement).dataset.unblock;
        if (!id) return;
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
            ${blockedCards ? `<div class="page-head"><div><h2>已拉黑</h2><p>这些候选被标记且不可一键注册。去 <a href="${href("/caps?tab=blacklist")}">黑名单</a> 解除。</p></div></div>${blockedCards}` : ""}
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
                location.hash = "/caps";
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
                    ? href("/add")
                    : tool === "mcp_health"
                      ? href("/caps")
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


// ───────────────────────── S2: 能力 / 添加 / 活动 / 设置 ─────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

const PACK_LABEL: Record<string, string> = {
  http: "HTTP / Web API",
  rpc: "RPC",
  messaging: "消息 / 流",
  industrial: "工业 / IoT",
  data: "数据 / 存储 / 基础设施",
  collab: "协作 / SaaS",
  platform: "本机 / 平台",
  other: "其他",
};
const PACK_ORDER = ["http", "rpc", "data", "messaging", "industrial", "platform", "collab", "other"];

const SOURCE_LABEL: Record<string, string> = {
  localhost: "本机",
  interface: "局域网",
  manual: "手动范围",
  mdns: "mDNS",
  ssdp: "SSDP",
};

let protocolCache: J[] | undefined;
async function loadProtocols(): Promise<J[]> {
  if (!protocolCache) protocolCache = ((await rest.protocols()) as J).protocols ?? [];
  return protocolCache!;
}

function tag(text: string, kind = ""): string {
  return `<span class="tag ${kind}">${esc(text)}</span>`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtTime(iso: unknown): string {
  if (!iso) return "—";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-CN", { hour12: false });
}

function capState(a: J): { label: string; kind: string } {
  if (a.blacklisted) return { label: a.blacklistKind === "capability" ? "已拉黑（实例）" : "已拉黑（目标）", kind: "bad" };
  if (a.status === "disabled") return { label: "已停用", kind: "muted" };
  if (a.status === "restore_failed") return { label: "连接失败", kind: "bad" };
  return { label: "运行中", kind: "ok" };
}

function strip(ov: J, tab: CapTab): string {
  const c = ov.current ?? {};
  const s = ov.supported ?? {};
  const b = ov.blacklist ?? {};
  const d = ov.discovery ?? {};
  const modeLabel = d.mode === "auto" ? "自动" : d.mode === "manual" ? "手动" : "关闭";
  const last = d.lastRun;
  return `
    <div class="strip">
      <a class="strip-item ${tab === "current" ? "on" : ""}" href="${href("/caps?tab=current")}">
        <span class="strip-k">当前能力</span>
        <span class="strip-v">${esc(c.total ?? 0)}</span>
        <span class="strip-s">启用 ${esc(c.enabled ?? 0)} · 拉黑 ${esc(c.blacklisted ?? 0)}${c.disabled ? ` · 停用 ${esc(c.disabled)}` : ""}${c.failing ? ` · 异常 ${esc(c.failing)}` : ""}</span>
      </a>
      <a class="strip-item ${tab === "supported" ? "on" : ""}" href="${href("/caps?tab=supported")}">
        <span class="strip-k">可支持能力</span>
        <span class="strip-v">${esc(s.discovered ?? 0)}<small> 已发现</small></span>
        <span class="strip-s">可一键启用 ${esc(s.ready ?? 0)} · 需要配置 ${esc(s.needsConfig ?? 0)}${s.failed ? ` · 启用失败 ${esc(s.failed)}` : ""} · 类型 ${esc(s.types ?? 0)}</span>
      </a>
      <a class="strip-item ${tab === "blacklist" ? "on" : ""}" href="${href("/caps?tab=blacklist")}">
        <span class="strip-k">黑名单</span>
        <span class="strip-v">${esc(b.total ?? 0)}</span>
        <span class="strip-s">目标 ${esc(b.target ?? 0)} · 能力 ${esc(b.capability ?? 0)} · 工具 ${esc(b.tool ?? 0)}</span>
      </a>
      <div class="strip-item">
        <span class="strip-k">自动发现 · ${esc(modeLabel)}</span>
        <span class="strip-s">${d.running ? "扫描中…" : last ? `上次 ${esc(fmtTime(last.finishedAt ?? last.startedAt))} · ${esc(last.hostsScanned)} 台主机 · 新 ${esc(last.newCount)}` : "尚未运行"}</span>
        <span class="strip-s">${d.nextRunAt ? `下次 ${esc(fmtTime(d.nextRunAt))}` : d.mode === "off" ? `<a href="${href("/settings")}">去设置打开</a>` : "仅手动触发"}</span>
        <button class="btn sm" type="button" data-run-discovery ${d.mode === "off" || d.running ? "disabled" : ""}>立即扫描</button>
      </div>
    </div>`;
}

async function renderCaps(tab: CapTab): Promise<string> {
  const ov = (await rest.overview()) as J;
  const c = ov.current ?? {};
  const s = ov.supported ?? {};
  const b = ov.blacklist ?? {};
  let body = "";
  if (tab === "current") body = await renderCurrentTab();
  else if (tab === "supported") body = await renderSupportedTab(ov);
  else body = await renderBlacklistTab();
  const t = (id: CapTab, label: string, count: string) =>
    `<a class="${tab === id ? "active" : ""}" href="${href(`/caps?tab=${id}`)}">${label}<span class="count">${count}</span></a>`;
  return `
    <div class="page-head">
      <div>
        <h2>能力</h2>
        <p>Agent 通过 MCP 看到的全部能力。写操作默认关闭；黑名单在 Full 模式下同样生效。</p>
      </div>
      <a class="btn primary" href="${href("/add")}">+ 添加</a>
    </div>
    ${strip(ov, tab)}
    <nav class="cap-tabs">
      ${t("current", "当前能力", String(c.total ?? 0))}
      ${t("supported", "可支持能力", `${s.discovered ?? 0} · ${s.types ?? 0}`)}
      ${t("blacklist", "黑名单", String(b.total ?? 0))}
    </nav>
    ${body}
    <aside class="drawer" id="drawer" hidden></aside>`;
}

const SOURCE_COL: Record<string, string> = { discovery: "自动发现", partner: "伙伴", manual: "手动" };

async function renderCurrentTab(): Promise<string> {
  const data = (await rest.adapters()) as J;
  const adapters: J[] = data.adapters ?? [];
  if (!adapters.length) {
    return `<div class="card empty">还没有能力。去 <a href="${href("/caps?tab=supported")}">可支持能力</a> 一键启用已发现的服务，或 <a href="${href("/add")}">+ 添加</a>。</div>`;
  }
  const rows = adapters
    .map((a) => {
      const st = capState(a);
      const enabled = a.status !== "disabled";
      const id = String(a.id);
      return `<tr class="cap-row" data-row="${esc(id)}">
        <td>${statusDot(st.kind === "ok", st.kind === "bad")}</td>
        <td><div class="cap-name">${esc(a.displayName ?? a.name)}</div><div class="hint mono">${esc(id)}</div></td>
        <td>${protoBadge(String(a.protocol))} ${a.ingress && a.ingress !== "native" ? ingressBadge(a.ingress) : ""}</td>
        <td>${tag(SOURCE_COL[String(a.source)] ?? "手动")}${a.address ? `<div class="hint mono">${esc(a.address)}</div>` : ""}</td>
        <td>${esc(a.toolCount ?? 0)}</td>
        <td>${a.allowWrite === true ? tag("可写", "warn") : tag("只读")}</td>
        <td>${tag(st.label, st.kind)}</td>
        <td class="no-row">
          <label class="switch" title="${enabled ? "停用（保留配置）" : "启用"}">
            <input type="checkbox" data-toggle="${esc(id)}" ${enabled ? "checked" : ""} />
            <span></span>
          </label>
        </td>
        <td class="no-row actions">
          ${
            a.blacklisted && a.blacklistId
              ? `<button class="btn sm" type="button" data-unblock="${esc(a.blacklistId)}">解除</button>`
              : `<button class="btn sm danger" type="button" data-cap-bl="${esc(id)}">加入黑名单</button>`
          }
          <details class="menu">
            <summary class="btn sm" aria-label="更多">…</summary>
            <div class="menu-pop">
              <a href="${href(`/add?edit=${encodeURIComponent(id)}`)}">配置</a>
              <button type="button" data-ping="${esc(id)}">测试</button>
              <button type="button" class="danger" data-del="${esc(id)}">删除</button>
            </div>
          </details>
        </td>
      </tr>`;
    })
    .join("");
  return `
    <div class="table-wrap">
      <table class="caps">
        <thead><tr><th></th><th>名称</th><th>类型</th><th>来源 / 地址</th><th>Tools</th><th>写</th><th>状态</th><th>启用</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">点一行查看它暴露给 Agent 的 tools，可按工具单独屏蔽。</p>`;
}

function catalogCards(protocols: J[], registered: Record<string, number>): string {
  const groups = new Map<string, J[]>();
  for (const p of protocols) {
    const k = p.pack && PACK_LABEL[p.pack] ? p.pack : "other";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  const special = `
    <div class="type-group" data-group="entry">
      <h4>其他接入方式</h4>
      <div class="type-grid">
        <a class="type-card" href="${href("/import")}" data-search="import schema openapi wsdl proto graphql asyncapi 导入">
          <strong>导入 Schema</strong><span>OpenAPI / WSDL / proto / GraphQL SDL / AsyncAPI 文件或 URL</span></a>
        <a class="type-card" href="${href("/discovery")}" data-search="scan host 扫描 单主机">
          <strong>扫描单个主机</strong><span>对一个 host 做指纹识别，再逐条确认</span></a>
        <a class="type-card" href="${href("/add?type=mcp_bridge")}" data-search="mcp server bridge 兜底">
          <strong>MCP Server（兜底）</strong><span>导入 mcpServers JSON，作为最后手段</span></a>
        <a class="type-card" href="${href("/partner")}" data-search="partner 伙伴 应用">
          <strong>Partner 应用</strong><span>应用通过 Partner 协议自注册，不需要实现 MCP</span></a>
      </div>
    </div>`;
  const body = PACK_ORDER.filter((k) => groups.has(k))
    .map((k) => {
      const cards = groups
        .get(k)!
        .map((p) => {
          const n = registered[p.protocol] ?? 0;
          return `<a class="type-card" href="${href(`/add?type=${encodeURIComponent(p.protocol)}`)}" data-search="${esc(`${p.protocol} ${p.title} ${p.summary}`.toLowerCase())}">
            <strong>${esc(p.title)}</strong>
            <span>${esc(p.summary)}</span>
            <em>${protoBadge(p.protocol)}${n ? ` ${tag(`已添加 ${n}`, "ok")}` : ""}</em>
          </a>`;
        })
        .join("");
      return `<div class="type-group" data-group="${esc(k)}"><h4>${esc(PACK_LABEL[k] ?? k)} <span class="hint">${groups.get(k)!.length}</span></h4><div class="type-grid">${cards}</div></div>`;
    })
    .join("");
  return special + body;
}

function candidateCard(c: J, i: number): string {
  const needs = c.needsConfig === true;
  const fields: string[] = [];
  for (const k of c.missing ?? []) {
    fields.push(`<div class="field"><label>${esc(k)}</label><input name="cfg:${esc(k)}" required /></div>`);
  }
  for (const f of c.credentials ?? []) {
    fields.push(
      `<div class="field"><label>${esc(f.label)}</label><input name="cred:${esc(f.key)}" type="${f.secret ? "password" : "text"}" autocomplete="off" /></div>`,
    );
  }
  return `<div class="cand-card ${c.online ? "" : "offline"}">
    <div class="cand-head">
      ${statusDot(c.online === true, c.online === false)}
      ${protoBadge(String(c.protocol))}
      <strong>${esc(c.title || c.host)}</strong>
      ${c.lastError ? tag("启用失败", "bad") : needs ? tag("需要配置", "warn") : tag("可一键启用", "ok")}
    </div>
    <div class="hint mono">${esc(c.url)}</div>
    <div class="hint">${esc(SOURCE_LABEL[c.source] ?? c.source)} · 首次 ${esc(fmtTime(c.firstSeen))}${c.online ? "" : " · 当前离线"}</div>
    ${c.lastError ? `<div class="hint err-text">上次启用失败（${esc(c.lastError.code)}）：${esc(c.lastError.message)}</div>` : ""}
    <form class="cand-form" data-cand="${i}">
      ${needs && fields.length ? `<div class="cand-fields">${fields.join("")}</div>` : ""}
      <div class="row-actions">
        <button class="btn primary sm" type="submit">${needs ? "填写并启用" : "一键启用"}</button>
        <button class="btn sm" type="button" data-dismiss="${i}">忽略</button>
        <button class="btn sm danger" type="button" data-cand-bl="${i}">加入黑名单</button>
      </div>
    </form>
  </div>`;
}

let candidateList: J[] = [];

async function renderSupportedTab(ov: J): Promise<string> {
  const [protocols, cands, adapters] = await Promise.all([loadProtocols(), rest.discoveryCandidates("new"), rest.adapters()]);
  candidateList = ((cands as J).candidates ?? []) as J[];
  candidateList.sort((a, b) => Number(a.needsConfig) - Number(b.needsConfig) || Number(b.online) - Number(a.online));
  const registered: Record<string, number> = {};
  for (const a of ((adapters as J).adapters ?? []) as J[]) registered[a.protocol] = (registered[a.protocol] ?? 0) + 1;
  const d = ov.discovery ?? {};
  const discovered = candidateList.length
    ? `<div class="cand-grid">${candidateList.map((c, i) => candidateCard(c, i)).join("")}</div>`
    : `<div class="card empty">${
        d.mode === "off"
          ? `自动发现已关闭。去 <a href="${href("/settings")}">设置</a> 打开，或下方选择类型手动添加。`
          : d.lastRun
            ? "上次扫描没有发现新的服务。"
            : "还没扫描过。点「立即扫描」或等待自动扫描。"
      }</div>`;
  return `
    <section class="sec">
      <div class="sec-head">
        <h3>已发现，可一键启用 <span class="hint">${candidateList.length}</span></h3>
        <span class="hint">只扫私网（本机、网卡所在 /24、mDNS/SSDP 应答者、手动范围）。启用后默认只读，不会打开写。</span>
      </div>
      ${discovered}
    </section>
    <section class="sec">
      <div class="sec-head">
        <h3>全部支持的类型 <span class="hint">${protocols.length}</span></h3>
        <input class="search" id="type-search" placeholder="搜索类型：redis、kafka、opc…" />
      </div>
      <div id="type-catalog">${catalogCards(protocols, registered)}</div>
    </section>`;
}

async function renderBlacklistTab(): Promise<string> {
  const [bl, adapters] = await Promise.all([rest.blacklist(), rest.adapters()]);
  const entries: J[] = (bl as J).entries ?? [];
  const kindLabel = (k: string) => (k === "capability" ? tag("能力实例", "warn") : k === "tool" ? tag("工具", "warn") : tag("目标", "bad"));
  const matcher = (e: J) => {
    const k = e.kind ?? "target";
    if (k === "capability") return `<code>${esc(e.adapterId)}</code>`;
    if (k === "tool") return `<code>${esc(e.pattern)}</code>`;
    return e.host ? `<code>${esc(e.host)}:${esc(e.port)}</code>` : `<code>${esc(e.url ?? e.id)}</code>`;
  };
  const rows = entries
    .map(
      (e) => `<tr>
        <td>${kindLabel(e.kind ?? "target")}</td>
        <td>${matcher(e)}</td>
        <td>${e.protocol && e.protocol !== "*" ? protoBadge(String(e.protocol)) : "—"}</td>
        <td>${esc(e.reason ?? "—")}</td>
        <td class="hint">${esc(fmtTime(e.createdAt))}</td>
        <td><button class="btn sm" type="button" data-unblock="${esc(e.id)}">解除</button></td>
      </tr>`,
    )
    .join("");
  const adapterOpts = (((adapters as J).adapters ?? []) as J[]).map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>范围</th><th>匹配</th><th>协议</th><th>原因</th><th>时间</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="empty">黑名单是空的。可以在当前能力行、工具抽屉或已发现卡片上一键加入。</td></tr>`}</tbody>
      </table>
    </div>
    <details class="card">
      <summary>手动添加</summary>
      <form id="bl-add" class="bl-form">
        <div class="field"><label>范围</label>
          <select name="kind">
            <option value="target">目标（协议 + 主机 + 端口）</option>
            <option value="capability">能力实例</option>
            <option value="tool">工具（名称或通配）</option>
          </select>
        </div>
        <div class="bl-k" data-k="target">
          <div class="field"><label>协议</label><input name="protocol" placeholder="redis / mqtt / openapi" /></div>
          <div class="field"><label>主机</label><input name="host" placeholder="10.0.0.8" /></div>
          <div class="field"><label>端口</label><input name="port" type="number" min="1" max="65535" /></div>
          <div class="field"><label>或 URL</label><input name="url" placeholder="mqtt://10.0.0.8:1883" /></div>
        </div>
        <div class="bl-k" data-k="capability" hidden>
          <div class="field"><label>能力</label><select name="adapterId">${adapterOpts || `<option value="">（没有已添加的能力）</option>`}</select></div>
        </div>
        <div class="bl-k" data-k="tool" hidden>
          <div class="field"><label>工具</label><input name="pattern" placeholder="redis.*.flushall 或 openapi.shop.deleteOrder" />
          <div class="hint">* 匹配一段，** 匹配任意多段；不接受单独的 *</div></div>
        </div>
        <div class="field"><label>原因（可选）</label><input name="reason" /></div>
        <button class="btn primary" type="submit">加入黑名单</button>
      </form>
    </details>`;
}

async function openDrawer(id: string): Promise<void> {
  const drawer = document.getElementById("drawer");
  if (!drawer) return;
  drawer.hidden = false;
  drawer.innerHTML = `<div class="drawer-head"><strong>${esc(id)}</strong><button class="btn sm" type="button" data-close-drawer>✕</button></div><div class="hint">加载 tools…</div>`;
  try {
    const [tools, one] = await Promise.all([rest.tools("business"), rest.adapter(id)]);
    const a = (one as J).adapter ?? {};
    const list = (((tools as J).tools ?? []) as J[]).filter((t) => t.adapterId === id);
    const rows = list
      .map((t) => {
        const ro = t.annotations?.readOnlyHint === true;
        const wr = t.annotations?.destructiveHint === true;
        return `<div class="tool-row ${t.blocked ? "blocked" : ""}">
          <div>
            <div class="mono">${esc(t.name)}</div>
            <div class="hint">${esc(t.description ?? "")}</div>
          </div>
          <div class="row-actions">
            ${ro ? tag("只读") : wr ? tag("写", "warn") : ""}
            ${
              t.blocked
                ? `${tag("已屏蔽", "bad")} <button class="btn sm" type="button" data-unblock="${esc(t.blacklistId)}">解除</button>`
                : `<button class="btn sm danger" type="button" data-tool-bl="${esc(t.name)}">屏蔽</button>`
            }
            <a class="btn sm" href="${href(`/tools/${encodeURIComponent(String(t.name))}`)}">试调用</a>
          </div>
        </div>`;
      })
      .join("");
    const st = capState(a);
    drawer.innerHTML = `
      <div class="drawer-head">
        <div><strong>${esc(a.name ?? id)}</strong> ${protoBadge(String(a.protocol ?? ""))} ${tag(st.label, st.kind)}</div>
        <button class="btn sm" type="button" data-close-drawer>✕</button>
      </div>
      <div class="hint mono">${esc(id)}</div>
      ${a.error ? `<div class="err-box">${esc(a.error)}</div>` : ""}
      <div class="row-actions">
        <a class="btn sm" href="${href(`/add?edit=${encodeURIComponent(id)}`)}">配置</a>
        <button class="btn sm" type="button" data-ping="${esc(id)}">测试</button>
      </div>
      ${Array.isArray(a.operations) && a.operations.length ? `<h4>接口 <span class="hint">${a.operations.length}</span></h4><p class="hint">${a.invokeUrl ? `回调 ${esc(String(a.invokeUrl))} · ` : ""}每个 operation 对应一个 tool，可单独屏蔽。</p>` : ""}
      <h4>Tools <span class="hint">${list.length}</span></h4>
      ${rows || `<div class="empty">${a.status === "disabled" ? "已停用，没有暴露 tools。" : "没有 tools。"}</div>`}
      <details><summary class="hint">配置（已脱敏）</summary><pre>${esc(pretty(a.config ?? {}))}</pre></details>`;
  } catch (err) {
    drawer.innerHTML += `<div class="err-box">${esc(errText(err))}</div>`;
  }
}

async function act(fn: () => Promise<unknown>, ok: string, rerender = true): Promise<void> {
  try {
    await fn();
    showToast("ok", ok);
    if (rerender) await render();
  } catch (err) {
    showToast("err", errText(err));
  }
}

function bindCaps(tab: CapTab): void {
  const content = document.querySelector(".content");
  content?.addEventListener("click", async (ev) => {
    const el = ev.target as HTMLElement;
    const btn = el.closest("button") as HTMLButtonElement | null;
    if (btn?.dataset.closeDrawer !== undefined && btn?.hasAttribute("data-close-drawer")) {
      const d = document.getElementById("drawer");
      if (d) d.hidden = true;
      return;
    }
    if (btn?.hasAttribute("data-run-discovery")) {
      btn.disabled = true;
      btn.textContent = "扫描中…";
      await act(async () => {
        const r = (await rest.runDiscovery(true)) as J;
        showToast("ok", `扫描完成：${r.run?.hostsScanned ?? 0} 台主机，发现 ${r.run?.found ?? 0}，新 ${r.run?.newCount ?? 0}`);
      }, "已刷新");
      return;
    }
    if (btn?.dataset.capBl) {
      const id = btn.dataset.capBl;
      if (!window.confirm(`把能力 ${id} 加入黑名单？它的 tools 会从 Agent 列表消失，调用会被拒绝。`)) return;
      await act(() => rest.addBlacklist({ kind: "capability", adapterId: id, reason: "console" }), `已拉黑 ${id}`);
      return;
    }
    if (btn?.dataset.toolBl) {
      const name = btn.dataset.toolBl;
      await act(() => rest.addBlacklist({ kind: "tool", pattern: name, reason: "console" }), `已屏蔽 ${name}`, false);
      const row = document.querySelector("tr.cap-row[data-open]") as HTMLElement | null;
      const id = row?.dataset.row;
      if (id) await openDrawer(id);
      return;
    }
    if (btn?.dataset.unblock) {
      const id = btn.dataset.unblock;
      const inDrawer = Boolean(btn.closest("#drawer"));
      await act(() => rest.removeBlacklist(id), `已解除 ${id}`, !inDrawer);
      if (inDrawer) {
        const row = document.querySelector("tr.cap-row[data-open]") as HTMLElement | null;
        if (row?.dataset.row) await openDrawer(row.dataset.row);
      }
      return;
    }
    if (btn?.dataset.ping) {
      const id = btn.dataset.ping;
      try {
        const r = (await rest.ping(id)) as J;
        showToast(r.ok ? "ok" : "err", r.ok ? `${id} 连接正常` : `${id}：${r.health?.detail ?? r.status}`);
      } catch (err) {
        showToast("err", errText(err));
      }
      return;
    }
    if (btn?.dataset.del) {
      const id = btn.dataset.del;
      if (!window.confirm(`删除能力 ${id}？会断开并移除它的所有 tools 和配置。`)) return;
      await act(() => rest.deleteAdapter(id), `已删除 ${id}`);
      return;
    }
    if (btn?.dataset.dismiss) {
      const c = candidateList[Number(btn.dataset.dismiss)];
      if (c) await act(() => rest.dismissCandidate(c.id), `已忽略 ${c.title || c.host}`);
      return;
    }
    if (btn?.dataset.candBl) {
      const c = candidateList[Number(btn.dataset.candBl)];
      if (!c) return;
      const body: Record<string, unknown> = { ...blacklistPayloadFromRecord(c), reason: "console discovery" };
      await act(() => rest.addBlacklist(body), `已拉黑 ${c.id}`);
      return;
    }
    const row = el.closest("tr.cap-row") as HTMLElement | null;
    if (row && !el.closest(".no-row")) {
      document.querySelectorAll("tr.cap-row[data-open]").forEach((r) => r.removeAttribute("data-open"));
      row.setAttribute("data-open", "1");
      await openDrawer(row.dataset.row ?? "");
    }
  });
  content?.addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    if (input.dataset.toggle) {
      const id = input.dataset.toggle;
      await act(() => rest.setEnabled(id, input.checked), input.checked ? `已启用 ${id}` : `已停用 ${id}（配置保留）`);
    }
  });
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "Escape") {
        const d = document.getElementById("drawer");
        if (d) d.hidden = true;
      }
    },
    { once: true },
  );
  document.querySelectorAll("form.cand-form").forEach((f) => {
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const form = f as HTMLFormElement;
      const c = candidateList[Number(form.dataset.cand)];
      if (!c) return;
      const fd = new FormData(form);
      const config: Record<string, string> = {};
      const credentials: Record<string, string> = {};
      for (const [k, v] of fd.entries()) {
        const val = String(v);
        if (!val) continue;
        if (k.startsWith("cfg:")) config[k.slice(4)] = val;
        if (k.startsWith("cred:")) credentials[k.slice(5)] = val;
      }
      await act(async () => {
        const r = (await rest.enableCandidate(c.id, { config, credentials })) as J;
        showToast("ok", `已启用 ${r.registered?.id ?? c.id}（只读）`);
      }, "已加入当前能力");
    });
  });
  const search = document.getElementById("type-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>("#type-catalog .type-card").forEach((card) => {
      card.hidden = Boolean(q) && !(card.dataset.search ?? "").includes(q);
    });
    document.querySelectorAll<HTMLElement>("#type-catalog .type-group").forEach((g) => {
      g.hidden = !g.querySelector(".type-card:not([hidden])");
    });
  });
  const blForm = document.getElementById("bl-add") as HTMLFormElement | null;
  if (blForm) {
    const sync = () => {
      const kind = (blForm.elements.namedItem("kind") as HTMLSelectElement).value;
      blForm.querySelectorAll<HTMLElement>(".bl-k").forEach((b) => (b.hidden = b.dataset.k !== kind));
    };
    blForm.querySelector("select[name=kind]")?.addEventListener("change", sync);
    blForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(blForm);
      const kind = String(fd.get("kind"));
      const body: Record<string, unknown> = { kind };
      const reason = String(fd.get("reason") ?? "").trim();
      if (reason) body.reason = reason;
      if (kind === "target") {
        for (const k of ["protocol", "host", "url"]) {
          const v = String(fd.get(k) ?? "").trim();
          if (v) body[k] = v;
        }
        const port = String(fd.get("port") ?? "").trim();
        if (port) body.port = Number(port);
      } else if (kind === "capability") body.adapterId = String(fd.get("adapterId") ?? "");
      else body.pattern = String(fd.get("pattern") ?? "").trim();
      await act(() => rest.addBlacklist(body), "已加入黑名单");
    });
  }
  void tab;
}

// ─── 添加 / 配置 向导 ───

function fieldInput(f: J, value: unknown): string {
  const name = `f:${f.key}`;
  const req = f.required ? "required" : "";
  const ph = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : "";
  if (f.type === "boolean") {
    const on = value === undefined ? f.default === true : value === true;
    return `<label class="check"><input type="checkbox" name="${esc(name)}" ${on ? "checked" : ""} /> ${esc(f.label ?? f.key)}</label>`;
  }
  let control: string;
  if (f.enum) {
    control = `<select name="${esc(name)}" ${req}><option value=""></option>${(f.enum as unknown[])
      .map((o) => `<option ${String(o) === String(value ?? f.default ?? "") ? "selected" : ""}>${esc(o)}</option>`)
      .join("")}</select>`;
  } else if (f.type === "object") {
    control = `<textarea name="${esc(name)}" class="short" ${ph} spellcheck="false">${value === undefined ? "" : esc(pretty(value))}</textarea>`;
  } else if (f.type === "array") {
    const v = Array.isArray(value) ? value.join("\n") : "";
    control = `<textarea name="${esc(name)}" class="short" ${ph} ${req}>${esc(v)}</textarea><div class="hint">每行一个</div>`;
  } else if (f.secret) {
    control = `<div class="secret"><input name="${esc(name)}" type="password" autocomplete="new-password" value="${esc(value ?? "")}" ${req} /><button class="btn sm" type="button" data-reveal>显示</button></div>`;
  } else {
    const type = f.type === "number" ? "number" : "text";
    control = `<input name="${esc(name)}" type="${type}" value="${esc(value ?? "")}" ${ph} ${req} />`;
  }
  const oneOf = Array.isArray(f.oneOf) ? `<div class="hint">与 ${esc((f.oneOf as string[]).filter((k) => k !== f.key).join(" / "))} 任填其一</div>` : "";
  return `<div class="field"><label>${esc(f.label ?? f.key)}${f.required ? ' <span class="req">*</span>' : f.oneOf ? ' <span class="req">*任一</span>' : ""}</label>${control}${f.description ? `<div class="hint">${esc(f.description)}</div>` : ""}${oneOf}</div>`;
}

let wizardSchema: J | undefined;
let wizardEdit: string | undefined;
let wizardBase: Record<string, unknown> = {};

async function renderAdd(page: { type?: string; edit?: string; source?: string }): Promise<string> {
  wizardSchema = undefined;
  wizardEdit = page.edit;
  wizardBase = {};
  let existing: J | undefined;
  let type = page.type;
  if (page.edit) {
    existing = ((await rest.adapter(page.edit)) as J).adapter;
    type = existing?.protocol;
    wizardBase = { ...(existing?.config ?? {}) };
  }
  const steps = (n: number) =>
    `<div class="steps-h">${["选择类型", "配置", "测试并保存"].map((s, i) => `<span class="${i + 1 === n ? "on" : i + 1 < n ? "done" : ""}">${i + 1} · ${s}</span>`).join("")}</div>`;
  if (!type) {
    const [protocols, adapters] = await Promise.all([loadProtocols(), rest.adapters()]);
    const registered: Record<string, number> = {};
    for (const a of ((adapters as J).adapters ?? []) as J[]) registered[a.protocol] = (registered[a.protocol] ?? 0) + 1;
    return `
      <div class="page-head"><div><h2>添加能力</h2><p>选一种类型。自动发现到的服务在 <a href="${href("/caps?tab=supported")}">可支持能力</a> 里可以直接一键启用。</p></div>
      <a class="btn" href="${href("/caps")}">返回</a></div>
      ${steps(1)}
      <input class="search" id="type-search" placeholder="搜索类型：redis、kafka、opc…" />
      <div id="type-catalog">${catalogCards(protocols, registered)}</div>`;
  }
  const schema = ((await rest.protocol(type)) as J).schema;
  wizardSchema = schema;
  const cfg: Record<string, unknown> = existing?.config ?? {};
  const fields: J[] = schema.fields ?? [];
  const primary = fields.filter((f) => !f.advanced && f.key !== "allowWrite");
  const advanced = fields.filter((f) => f.advanced);
  const known = new Set(fields.map((f) => f.key));
  const extras = Object.fromEntries(Object.entries(cfg).filter(([k]) => !known.has(k)));
  const allowWrite = fields.find((f) => f.key === "allowWrite");
  return `
    <div class="page-head">
      <div><h2>${existing ? `配置 ${esc(existing.id)}` : `添加 ${esc(schema.title)}`}</h2><p>${esc(schema.summary)}</p></div>
      <a class="btn" href="${href(existing ? "/caps" : "/add")}">${existing ? "返回" : "换一种类型"}</a>
    </div>
    ${steps(existing ? 2 : 2)}
    <form class="card wizard-form" id="wizard-form">
      <div class="field"><label>名称 <span class="req">*</span></label>
        <input name="name" value="${esc(existing?.name ?? `${schema.protocol.replace(/_/g, "-")}-1`)}" ${existing ? "disabled" : ""} required pattern="[\\w\\-]{1,64}" />
        <div class="hint">tools 会以 <code>${esc(schema.protocol)}.&lt;名称&gt;.&lt;操作&gt;</code> 暴露给 Agent</div>
      </div>
      <div id="form-fields">
        ${primary.map((f) => fieldInput(f, cfg[f.key])).join("")}
        ${advanced.length ? `<details class="adv"><summary>高级选项（${advanced.length}）</summary>${advanced.map((f) => fieldInput(f, cfg[f.key])).join("")}</details>` : ""}
        ${allowWrite ? `<div class="warn-box">${fieldInput(allowWrite, cfg.allowWrite)}<div>写路径默认关闭。只在确实需要时打开，Full 模式也不会替你打开。</div></div>` : ""}
        ${Object.keys(extras).length ? `<div class="field"><label>其他键（表单未覆盖）</label><textarea name="extras" class="short" spellcheck="false">${esc(pretty(extras))}</textarea></div>` : `<input type="hidden" name="extras" value="{}" />`}
      </div>
      <label class="check"><input type="checkbox" id="raw-toggle" /> 使用原始 JSON</label>
      <textarea id="raw-json" name="raw" hidden spellcheck="false"></textarea>
      ${existing ? `<div class="hint">密钥显示为 ••••，保持不动即沿用原值。</div>` : ""}
      <div class="row-actions">
        <button class="btn" type="button" id="test-btn">测试连接</button>
        <button class="btn primary" type="submit">${existing ? "保存配置" : "保存并启用"}</button>
      </div>
      <div id="wizard-out"></div>
    </form>`;
}

function collectConfig(form: HTMLFormElement): Record<string, unknown> {
  const raw = document.getElementById("raw-toggle") as HTMLInputElement | null;
  if (raw?.checked) {
    return JSON.parse((document.getElementById("raw-json") as HTMLTextAreaElement).value || "{}");
  }
  const fields: J[] = wizardSchema?.fields ?? [];
  const cfg: Record<string, unknown> = {};
  const extrasEl = form.elements.namedItem("extras") as HTMLTextAreaElement | HTMLInputElement | null;
  if (extrasEl?.value.trim()) Object.assign(cfg, JSON.parse(extrasEl.value));
  for (const f of fields) {
    const el = form.elements.namedItem(`f:${f.key}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (!el) continue;
    if (f.type === "boolean") {
      const on = (el as HTMLInputElement).checked;
      if (on || f.key === "allowWrite" || wizardBase[f.key] !== undefined) cfg[f.key] = on;
      continue;
    }
    const v = el.value.trim();
    if (!v) continue;
    if (f.type === "number") cfg[f.key] = Number(v);
    else if (f.type === "array") cfg[f.key] = v.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
    else if (f.type === "object") cfg[f.key] = JSON.parse(v);
    else cfg[f.key] = v;
  }
  return cfg;
}

function missingGroups(cfg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const g of (wizardSchema?.requiredAny ?? []) as string[][]) {
    const ok = g.some((k) => {
      const v = cfg[k];
      return typeof v === "string" ? v.trim() !== "" : Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false;
    });
    if (!ok) out.push(g.join(" / "));
  }
  return out;
}

function bindAdd(): void {
  const search = document.getElementById("type-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>("#type-catalog .type-card").forEach((card) => {
      card.hidden = Boolean(q) && !(card.dataset.search ?? "").includes(q);
    });
    document.querySelectorAll<HTMLElement>("#type-catalog .type-group").forEach((g) => {
      g.hidden = !g.querySelector(".type-card:not([hidden])");
    });
  });
  const form = document.getElementById("wizard-form") as HTMLFormElement | null;
  if (!form || !wizardSchema) return;
  const out = document.getElementById("wizard-out")!;
  form.querySelectorAll("button[data-reveal]").forEach((b) =>
    b.addEventListener("click", () => {
      const input = b.previousElementSibling as HTMLInputElement;
      input.type = input.type === "password" ? "text" : "password";
      b.textContent = input.type === "password" ? "显示" : "隐藏";
    }),
  );
  const rawToggle = document.getElementById("raw-toggle") as HTMLInputElement;
  const rawBox = document.getElementById("raw-json") as HTMLTextAreaElement;
  const fieldsBox = document.getElementById("form-fields") as HTMLElement;
  rawToggle.addEventListener("change", () => {
    if (rawToggle.checked) {
      try {
        rawToggle.checked = false;
        rawBox.value = pretty(collectConfig(form));
        rawToggle.checked = true;
      } catch (err) {
        rawToggle.checked = false;
        showToast("err", `表单里有无效 JSON：${errText(err)}`);
        return;
      }
    }
    rawBox.hidden = !rawToggle.checked;
    fieldsBox.hidden = rawToggle.checked;
    fieldsBox.querySelectorAll<HTMLInputElement>("[required]").forEach((i) => (i.disabled = rawToggle.checked));
  });
  const gather = (): { protocol: string; name: string; config: Record<string, unknown> } | undefined => {
    let config: Record<string, unknown>;
    try {
      config = collectConfig(form);
    } catch (err) {
      out.innerHTML = `<div class="err-box">JSON 无效：${esc(errText(err))}</div>`;
      return undefined;
    }
    const miss = missingGroups(config);
    if (miss.length && !wizardEdit) {
      out.innerHTML = `<div class="err-box">还缺必填项：${esc(miss.join("；"))}</div>`;
      return undefined;
    }
    const name = String((form.elements.namedItem("name") as HTMLInputElement).value || "").trim();
    return { protocol: String(wizardSchema.protocol), name, config };
  };
  document.getElementById("test-btn")?.addEventListener("click", async () => {
    const g = gather();
    if (!g) return;
    if (wizardEdit) {
      out.innerHTML = `<div class="hint">测试已保存的连接…</div>`;
      try {
        const r = (await rest.ping(wizardEdit)) as J;
        out.innerHTML = r.ok ? `<div class="ok-box">连接正常</div>` : `<div class="err-box">${esc(r.health?.detail ?? r.status)}</div>`;
      } catch (err) {
        out.innerHTML = `<div class="err-box">${esc(errText(err))}</div>`;
      }
      return;
    }
    out.innerHTML = `<div class="hint">连接中…（不会保存，也不会暴露给 Agent）</div>`;
    try {
      const r = (await rest.testAdapter(g)) as J;
      out.innerHTML = r.ok
        ? `<div class="ok-box">连接成功 · ${esc(r.latencyMs)} ms · ${esc(r.toolCount)} 个 tools<br/><span class="hint mono">${esc((r.tools ?? []).slice(0, 12).join("  "))}</span></div>`
        : `<div class="err-box">${esc(r.error?.code ?? "")} ${esc(r.error?.error ?? r.health?.detail ?? "连接失败")}</div>`;
    } catch (err) {
      out.innerHTML = `<div class="err-box">${esc(errText(err))}</div>`;
    }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const g = gather();
    if (!g) return;
    if (g.config.allowWrite === true && !window.confirm("你打开了 allowWrite，Agent 将能执行写操作。确认？")) return;
    try {
      if (wizardEdit) {
        await rest.updateAdapter(wizardEdit, g.config);
        showToast("ok", `已保存 ${wizardEdit}`);
      } else {
        const r = (await rest.createAdapter(g)) as J;
        showToast("ok", `已添加 ${r.id}（${(r.tools ?? []).length} 个 tools）`);
      }
      location.hash = "/caps";
    } catch (err) {
      const body = (err as { body?: J }).body;
      out.innerHTML = `<div class="err-box">${esc(body?.code ?? "")} ${esc(errText(err))}</div>`;
    }
  });
}

// ─── 活动 ───

const ACT_LABEL: Record<string, string> = {
  invoke: "调用",
  policy: "策略",
  mode_change: "模式",
  unregister: "卸载",
  discovery: "发现",
  discovery_run: "发现",
};

async function renderActivity(): Promise<string> {
  const data = (await rest.activity(150)) as J;
  const items: J[] = data.items ?? [];
  const counts = data.counts ?? {};
  const onlyErr = new URLSearchParams(location.hash.split("?")[1] ?? "").get("filter") === "errors";
  const list = onlyErr ? items.filter((i) => i.ok === false) : items;
  const rows = list
    .map(
      (e) => `<div class="tl-row">
        ${statusDot(e.ok === true, e.ok === false)}
        <div>
          <div class="tl-title">${tag(ACT_LABEL[e.type] ?? e.type)} ${esc(e.tool ?? "")} ${e.protocol ? protoBadge(String(e.protocol)) : ""}</div>
          <div class="hint">${esc(e.detail ?? e.code ?? (e.ok ? "ok" : "fail"))}${e.adapterId ? ` · ${esc(e.adapterId)}` : ""}${e.code && e.detail ? ` · ${esc(e.code)}` : ""}</div>
        </div>
        <div class="tl-meta">${esc(fmtTime(e.at))}</div>
      </div>`,
    )
    .join("");
  return `
    <div class="page-head">
      <div><h2>活动</h2><p>调用、策略拒绝、启停、黑名单与自动发现运行，按时间倒序。密钥已脱敏。</p></div>
      <nav class="cap-tabs small">
        <a class="${onlyErr ? "" : "active"}" href="${href("/activity")}">全部</a>
        <a class="${onlyErr ? "active" : ""}" href="${href("/activity?filter=errors")}">只看失败<span class="count">${esc(counts.errors ?? 0)}</span></a>
      </nav>
    </div>
    <div class="grid">
      <div class="card"><h3>成功</h3><div class="metric">${esc(counts.success ?? 0)}</div></div>
      <div class="card"><h3>失败</h3><div class="metric">${esc(counts.fail ?? 0)}</div></div>
      <div class="card"><h3>发现运行</h3><div class="metric">${esc(counts.discoveryRuns ?? 0)}</div></div>
      <div class="card"><h3>最近</h3><div class="metric" style="font-size:14px">${esc(fmtTime(items[0]?.at))}</div></div>
    </div>
    <div class="card timeline">${rows || `<div class="empty">还没有活动。</div>`}</div>`;
}

// ─── 设置 ───

async function renderSettingsPage(): Promise<string> {
  const [s, disc] = await Promise.all([rest.settings(), rest.discoverySettings().catch(() => undefined)]);
  const st = s as J;
  const d = (disc as J)?.settings;
  const scope = (disc as J)?.scope ?? {};
  const status = (disc as J)?.status ?? {};
  const runs: J[] = d ? (((await rest.discoveryRuns(10)) as J).runs ?? []) : [];
  const mode = st.security?.mode ?? "safe";
  const radio = (v: string, label: string, hint: string) =>
    `<label class="radio"><input type="radio" name="mode" value="${v}" ${d?.mode === v ? "checked" : ""}/> <strong>${label}</strong> <span class="hint">${hint}</span></label>`;
  const runRows = runs
    .map(
      (r) => `<tr><td>${esc(fmtTime(r.startedAt))}</td><td>${esc(r.trigger)}</td><td>${esc(r.hostsScanned)}/${esc(r.hostsPlanned)}${r.truncated ? " (上限)" : ""}</td><td>${esc(r.found)}</td><td>${esc(r.newCount)}</td><td>${esc(r.durationMs ?? "—")} ms</td><td class="hint">${esc((r.errors ?? []).slice(0, 2).join("; "))}</td></tr>`,
    )
    .join("");
  return `
    <div class="page-head"><div><h2>设置</h2><p>自动发现、安全模式与运行信息。更细的页面在左侧「高级」里。</p></div></div>
    ${
      d
        ? `<form class="card" id="disc-form">
      <h3>自动发现</h3>
      <div class="radios">
        ${radio("auto", "自动", `每 ${d.intervalMinutes} 分钟扫描一次私网并列出候选`)}
        ${radio("manual", "手动", "只在点「立即扫描」时运行")}
        ${radio("off", "关闭", "不做任何网络发现")}
      </div>
      <div class="form-grid">
        <div class="field"><label>间隔（分钟）</label><input name="intervalMinutes" type="number" min="5" max="1440" value="${esc(d.intervalMinutes)}" /></div>
        <div class="field"><label>单次主机上限</label><input name="hostCap" type="number" min="1" max="1024" value="${esc(d.hostCap)}" /></div>
        <div class="field"><label>并发</label><input name="concurrency" type="number" min="1" max="64" value="${esc(d.concurrency)}" /></div>
        <div class="field"><label>单端口超时（ms）</label><input name="timeoutMs" type="number" min="100" max="10000" value="${esc(d.timeoutMs)}" /></div>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" name="includeLocalhost" ${d.includeLocalhost ? "checked" : ""}/> 本机 127.0.0.1</label>
        <label class="check"><input type="checkbox" name="includeInterfaces" ${d.includeInterfaces ? "checked" : ""}/> 网卡所在私网（每块网卡最多 /24）</label>
        <label class="check"><input type="checkbox" name="multicast" ${d.multicast ? "checked" : ""}/> mDNS / SSDP 组播应答者</label>
        <label class="check"><input type="checkbox" name="autoEnable" ${d.autoEnable ? "checked" : ""}/> 自动启用新发现（非黑名单、无需凭据；默认开）</label>
      </div>
      <div class="form-grid two">
        <div class="field"><label>手动范围（每行一个：主机 / 域名 / CIDR，最大 /16）</label><textarea name="scopes" class="short" placeholder="10.20.0.0/24&#10;nas.lan">${esc((d.scopes ?? []).join("\n"))}</textarea></div>
        <div class="field"><label>排除（主机或 CIDR）</label><textarea name="exclude" class="short" placeholder="192.168.1.1">${esc((d.exclude ?? []).join("\n"))}</textarea></div>
      </div>
      <label class="check danger-check"><input type="checkbox" name="allowPublic" ${d.allowPublic ? "checked" : ""}/> 允许手动范围包含公网地址（仅对你有权扫描的网络打开）</label>
      <details><summary class="hint">探测的协议（${(d.protocols ?? []).length}）</summary>
        <textarea name="protocols" class="short">${esc((d.protocols ?? []).join(", "))}</textarea>
      </details>
      <p class="hint">私网：${esc((scope.privateRanges ?? []).join("、"))}。永不扫描：${esc((scope.neverScan ?? []).join("、"))}。</p>
      <div class="row-actions">
        <button class="btn primary" type="submit">保存</button>
        <button class="btn" type="button" data-run-discovery ${d.mode === "off" ? "disabled" : ""}>立即扫描</button>
        <span class="hint">${status.nextRunAt ? `下次自动扫描 ${esc(fmtTime(status.nextRunAt))}` : ""}</span>
      </div>
    </form>
    <div class="table-wrap">
      <table><thead><tr><th>开始</th><th>触发</th><th>主机</th><th>发现</th><th>新</th><th>耗时</th><th>错误</th></tr></thead>
      <tbody>${runRows || `<tr><td colspan="7" class="empty">还没有运行记录。</td></tr>`}</tbody></table>
    </div>`
        : `<div class="warn-box">自动发现未运行（EVERYTHING2MCP_DISCOVERY_ENABLED=false）。</div>`
    }
    <div class="card">
      <h3>安全模式</h3>
      <p class="hint">当前 <strong>${esc(String(mode).toUpperCase())}</strong>。Full 跳过写闸和限流，但黑名单、元数据拒绝、审计仍生效，适配器的 allowWrite 也不会被打开。</p>
      <div class="row-actions">
        <button class="btn ${mode === "safe" ? "primary" : ""}" type="button" data-mode="safe">Safe</button>
        <button class="btn ${mode === "full" ? "primary" : ""}" type="button" data-mode="full">Full Control</button>
        <a class="btn" href="${href("/security")}">安全模块详情</a>
      </div>
    </div>
    <div class="grid">
      <div class="card"><h3>版本</h3><div>${esc(st.app)} ${esc(st.version)}</div></div>
      <div class="card"><h3>数据目录</h3><div class="mono small">${esc(st.dataDir)}</div></div>
      <div class="card"><h3>传输</h3><div class="mono small">${esc(st.transport?.kind)} ${esc(st.transport?.host)}:${esc(st.transport?.port)}${esc(st.transport?.mcpPath)}</div></div>
      <div class="card"><h3>HTTP token</h3><div>${st.transport?.tokenConfigured ? "已配置" : "未配置"}</div></div>
    </div>
    <details class="card"><summary class="hint">原始设置 JSON</summary><pre>${esc(pretty(st))}</pre></details>`;
}

function bindSettingsPage(): void {
  const form = document.getElementById("disc-form") as HTMLFormElement | null;
  document.querySelector("[data-run-discovery]")?.addEventListener("click", async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    b.disabled = true;
    b.textContent = "扫描中…";
    await act(async () => {
      const r = (await rest.runDiscovery(true)) as J;
      showToast("ok", `扫描完成：${r.run?.hostsScanned ?? 0} 台主机，发现 ${r.run?.found ?? 0}`);
    }, "已刷新");
  });
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const lines = (k: string) =>
      String(fd.get(k) ?? "")
        .split(/[\n,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    const body = {
      mode: String(fd.get("mode") ?? "manual"),
      intervalMinutes: Number(fd.get("intervalMinutes")),
      hostCap: Number(fd.get("hostCap")),
      concurrency: Number(fd.get("concurrency")),
      timeoutMs: Number(fd.get("timeoutMs")),
      includeLocalhost: fd.get("includeLocalhost") !== null,
      includeInterfaces: fd.get("includeInterfaces") !== null,
      multicast: fd.get("multicast") !== null,
      autoEnable: fd.get("autoEnable") !== null,
      allowPublic: fd.get("allowPublic") !== null,
      scopes: lines("scopes"),
      exclude: lines("exclude"),
      protocols: lines("protocols"),
    };
    if (body.allowPublic && !window.confirm("允许扫描公网范围？请确认你对这些地址有授权。")) return;
    await act(() => rest.saveDiscoverySettings(body), "自动发现设置已保存");
  });
}

window.addEventListener("hashchange", () => {
  void render();
});
void render();
