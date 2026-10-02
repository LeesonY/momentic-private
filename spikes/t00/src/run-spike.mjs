import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { containedKinds, deepRedact, redactText, redactUrl, scanForSentinels, SENTINELS } from "./redact.mjs";
import {
  assembleSnapshot,
  captureAria,
  captureCdp,
  collectNodes,
  fingerprint,
  validateBrowserSnapshot,
} from "./snapshot.mjs";

const root = path.resolve(import.meta.dirname, "..");
const evidenceDir = path.join(root, "evidence");
const schemaPath = path.resolve(root, "../../docs/contracts/tools.schema.json");
const REDACTION_POLICY = [
  "隐藏 input 与 password 的 value 不进入契约节点。节点 name/text 不读取 input.value。",
  "CDP DOMSnapshot 的 inputValue、属性 value，以及 AXNode.value 只在内存中判断是否出现，样例里省略。",
  "cookie 只留名称、httpOnly、SameSite。value 不写盘。HttpOnly cookie 不进入 document.cookie。",
  "localStorage / sessionStorage 只在页面内做 SHA-256 比对。证据留 key 和 valueOmitted，不留 value。",
  "displayUrl 与 network url 将 auth/token/key/secret/password/session 的参数值替换为 [redacted]。",
  "console 文本落盘前替换哨兵。不保存 page.content()、原始 CDP 字符串表或 Playwright trace。",
  "script/style 不进入 CDP 样例。截图前清空 password 与隐藏 input 的值。",
  "证据写盘后按哨兵字节扫描，命中则删除该文件并判失败。",
];

const bag = {
  startedAt: new Date().toISOString(),
  actions: [],
  checks: [],
  error: null,
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function dockerStatus() {
  if (!hasBin("docker")) return { cli: false, server: "unavailable" };
  const version = (format) => {
    try {
      return execFileSync("docker", ["version", "--format", format], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const clientVersion = version("{{.Client.Version}}");
  const serverVersion = version("{{.Server.Version}}");
  return {
    cli: true,
    clientVersion: clientVersion || null,
    serverVersion: serverVersion || null,
  };
}

function hasBin(name) {
  try {
    execFileSync("/usr/bin/which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function capture(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    return `unavailable:${error.code || "error"}`;
  }
}

function readPackage(rel) {
  try {
    return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
  } catch {
    return null;
  }
}

function browserCatalog() {
  for (const rel of ["node_modules/playwright-core/browsers.json", "node_modules/playwright/browsers.json"]) {
    try {
      const json = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
      return {
        source: rel,
        browsers: (json.browsers || []).map((item) => ({
          name: item.name,
          revision: item.revision ?? null,
          browserVersion: item.browserVersion ?? null,
          installByDefault: item.installByDefault ?? null,
        })),
      };
    } catch {
      // try the next package layout
    }
  }
  return null;
}

function descendantProcs(rootPid) {
  const out = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 8_000_000 });
  const procs = [];
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) continue;
    procs.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  const children = new Map();
  for (const proc of procs) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  const desc = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    for (const child of children.get(id) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      desc.push(child);
      stack.push(child.pid);
    }
  }
  const interesting = desc.filter((proc) => /(chrome|chromium|headless_shell)/i.test(proc.command));
  const flags = new Set();
  for (const proc of interesting) {
    for (const token of proc.command.split(/\s+/)) {
      if (token.startsWith("--")) flags.add(token.split("=")[0]);
    }
  }
  return {
    browserProcessCount: interesting.length,
    noSandbox: flags.has("--no-sandbox"),
    disableSetuidSandbox: flags.has("--disable-setuid-sandbox"),
    flags: [...flags].sort(),
    pids: interesting.map((proc) => proc.pid),
  };
}

async function classify(locator) {
  const matchCount = await locator.count();
  let visibleCount = 0;
  let enabledCount = 0;
  for (let i = 0; i < matchCount; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible()) {
      visibleCount += 1;
      if (await item.isEnabled()) enabledCount += 1;
    }
  }
  let reason = "unique";
  if (visibleCount === 0) reason = "not_visible";
  else if (visibleCount > 1) reason = "not_unique";
  else if (enabledCount !== 1) reason = "not_enabled";
  return { matchCount, visibleCount, enabledCount, reason, actionable: reason === "unique" };
}

async function clickFlags(page) {
  return page.evaluate(() => ({
    hidden: window.__hiddenClicked === true,
    save: window.__saveClicks || 0,
    apply: window.__applyClicks || 0,
  }));
}

function copyEntries(list) {
  return list.map((entry) => ({ ...entry }));
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

async function writeJson(name, value) {
  await writeFile(path.join(evidenceDir, name), `${JSON.stringify(deepRedact(value), null, 2)}\n`);
}

function addCheck(id, status, detail, required, scope) {
  bag.checks.push({ id, status, detail, required, scope });
}

function buildChecks() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  addCheck("runtime.node-observed", "passed", `本次 macOS 浏览器验证运行在 Node ${process.version}。`, false, "runtime");
  addCheck(
    "runtime.node24-lts",
    nodeMajor === 24 ? "passed" : "unverified",
    nodeMajor === 24 ? "实际运行时是 Node 24。" : `设计基线是 Node 24 LTS。本次是 Node ${process.version}，未用 Node 24 复跑。`,
    false,
    "runtime",
  );
  addCheck(
    "macos.playwright.package",
    bag.playwrightVersion === "1.63.0" ? "passed" : "not_passed",
    `安装版本 ${bag.playwrightVersion || "missing"}，基线 1.63.0。`,
    true,
    "macos",
  );
  addCheck(
    "macos.chromium.launch",
    bag.launchOk ? "passed" : "not_passed",
    bag.launchOk ? `Chromium 已启动，browser.version=${bag.browserVersion}` : "Chromium 未启动。",
    true,
    "macos",
  );
  addCheck(
    "macos.chromium.build-recorded",
    bag.browserVersion ? "passed" : "not_passed",
    `browser.version=${bag.browserVersion || "missing"}；可执行文件与 browsers.json 见 versions.json。`,
    true,
    "macos",
  );
  if (!bag.sandbox) {
    addCheck("macos.chromium.sandbox-flag", "unverified", "浏览器未启动，没有进程参数可看。", false, "macos");
  } else if (bag.sandbox.browserProcessCount === 0) {
    addCheck("macos.chromium.sandbox-flag", "unverified", "进程表里没有找到 Chromium 子进程。", false, "macos");
  } else if (bag.sandbox.noSandbox || bag.sandbox.disableSetuidSandbox) {
    addCheck("macos.chromium.sandbox-flag", "not_passed", "显式 chromiumSandbox:true 后，macOS 进程仍带有关闭 sandbox 的参数。", false, "macos");
  } else {
    addCheck("macos.chromium.sandbox-flag", "passed", "显式 chromiumSandbox:true 后，macOS 进程没有 --no-sandbox 或 --disable-setuid-sandbox。出现的是 macOS Seatbelt。", false, "macos");
  }
  addCheck(
    "macos.chromium.default-no-sandbox",
    bag.defaultProbe?.noSandbox ? "not_passed" : "unverified",
    bag.defaultProbe
      ? "未传 chromiumSandbox 时，Playwright 1.63 会追加 --no-sandbox。功能验证改为显式 chromiumSandbox:true。"
      : "没有完成默认启动参数探测。",
    false,
    "macos",
  );
  addCheck("macos.action.navigate", bag.navigateOk ? "passed" : "not_passed", bag.navigateOk ? "domcontentloaded 打开 loopback fixture，HTTP 200。" : "导航未完成。", true, "macos");
  addCheck("macos.action.fill", bag.fillOk ? "passed" : "not_passed", bag.fillOk ? "已向「备注」写入固定文本。" : "输入未成功。", true, "macos");
  addCheck("macos.action.click", bag.clickOk ? "passed" : "not_passed", bag.clickOk ? "已点击唯一的「写入备注」。" : "点击未成功。", true, "macos");
  addCheck("macos.evidence.screenshot", bag.screenshotBytes > 1000 ? "passed" : "not_passed", `截图 ${bag.screenshotBytes || 0} 字节。`, true, "macos");
  addCheck("macos.evidence.console", bag.consoleSeen && (bag.consoleFinal || []).some((line) => line.includes("[redacted]")) ? "passed" : "not_passed", bag.consoleSeen ? "已记录 console，哨兵已替换。" : "没有捕获含哨兵的 console。", true, "macos");
  addCheck("macos.evidence.network", bag.ping?.status === 200 && bag.hang && bag.hang.status == null && bag.foreignHosts?.length === 0 && bag.postCount === 0 ? "passed" : "not_passed", `ping=${bag.ping?.status ?? "missing"} hang=${bag.hang ? bag.hang.status : "missing"} post=${bag.postCount ?? "missing"} foreign=${(bag.foreignHosts || []).join(",") || "none"}`, true, "macos");
  addCheck("macos.snapshot.public-nodes", bag.s2?.nodes?.length > 0 ? "passed" : "not_passed", `最终契约节点 ${bag.s2?.nodes?.length || 0} 个。`, true, "macos");
  addCheck("macos.snapshot.aria", bag.aria?.ok ? "passed" : "not_passed", bag.aria?.ok ? "使用 locator.ariaSnapshot。" : (bag.aria?.reason || bag.aria?.error || "无障碍快照失败"), true, "macos");
  addCheck("macos.snapshot.cdp", bag.cdp?.ok ? "passed" : "not_passed", bag.cdp?.ok ? "使用 CDP DOMSnapshot 与 Accessibility.getFullAXTree，原始字符串表未落盘。" : (bag.cdp?.error || "CDP 失败"), true, "macos");
  addCheck("macos.snapshot.schema", bag.schemaOk ? "passed" : "not_passed", bag.schemaOk ? "前后两份快照符合 tools.schema.json BrowserSnapshot。" : "快照未通过契约校验。", true, "macos");
  addCheck("macos.wait.delayed-render", bag.earlyOk && bag.waitOk ? "passed" : "not_passed", `导航后延迟内容不可见，状态等待 ${bag.waitedMs ?? "n/a"} ms，页面时钟 ${bag.delayMs ?? "n/a"} ms。`, true, "macos");
  addCheck("macos.wait.not-networkidle", bag.networkIdle === "timed_out" ? "passed" : "not_passed", `长连接仍打开时 networkidle=${bag.networkIdle || "not-run"}，用时 ${bag.networkIdleMs ?? "n/a"} ms。成功路径没有依赖 networkidle。`, true, "macos");
  addCheck("macos.locator.duplicate-refused", bag.duplicateOk ? "passed" : "not_passed", "重复文案与两个可见「保存」未点击。", true, "macos");
  addCheck("macos.locator.testid-distinguishes", bag.testIdUnique ? "passed" : "not_passed", "data-testid=save-draft 可见且唯一，本次没有用它去点「保存」。", true, "macos");
  addCheck("macos.locator.hidden-refused", bag.hiddenOk ? "passed" : "not_passed", "隐藏的「危险操作」不可见，未点击。", true, "macos");
  addCheck("macos.snapshot.stale-refused", bag.staleOk ? "passed" : "not_passed", bag.fillChangedFingerprint ? "填写改变了指纹，旧快照语义与预期不同。" : "点击后回显改变指纹，旧 snapshot 被拒绝且没有再次点击。", true, "macos");
  addCheck("macos.redaction.applied", bag.redactionOk ? "passed" : "not_passed", bag.redactionOk ? "页面内哨兵存在，落盘证据不含哨兵。" : "脱敏存在性或扫描未通过。", true, "macos");
  addCheck("macos.font.han", bag.fontOk ? "passed" : "unverified", bag.fontOk ? "macOS 上中文样本宽度大于 0。" : "未测量中文宽度。", false, "macos");
  addCheck("macos.snapshot.iframe", bag.frameOk ? "passed" : "not_passed", bag.frameOk ? "同源 iframe 单独进入 frameIds。" : (bag.frameError || "iframe 未就绪"), false, "macos");
  addCheck("network.intranet-dns", "not_passed", "未提供内部主机名，未做内网解析。loopback 不是内网 DNS。", false, "network");
  addCheck("network.proxy", "not_passed", "没有按产品 Worker 策略做内网请求。本机代理环境变量只记录是否设置，不记录值。", false, "network");
  addCheck("network.corporate-tls", "not_passed", "未提供公司 CA，未做内网 HTTPS 握手。fixture 只有 loopback HTTP。", false, "network");
  addCheck("network.controlled-site", "not_passed", "未访问受控真实站点。127.0.0.1 fixture 不能代替。", false, "network");
  addCheck("evidence.playwright-trace", "unverified", "未启用 trace。原始 zip 会带上 cookie、storage 和 DOM value；trace 脱敏未做。", false, "macos");
  addCheck("evidence.rrweb", "unverified", "本次未接入 rrweb。", false, "macos");
  addCheck("browser.multi-context-isolation", "unverified", "只打开一个 browser context，不能证明任务间隔离。", false, "macos");
  addCheck("repro.independent-context", "unverified", "FR-026 独立复现未做。", false, "macos");
  if (bag.error) addCheck("macos.spike.exception", "not_passed", bag.error.slice(0, 500), true, "macos");
}

async function persist() {
  if (bag.s2) await writeJson("browser-snapshot.json", bag.s2);
  if (bag.s1) await writeJson("snapshot-before-action.json", bag.s1);
  if (bag.actions.length) await writeJson("actions.json", bag.actions);
  if (bag.scenarios) await writeJson("scenarios.json", bag.scenarios);
  if (bag.consoleFinal) await writeJson("console.json", bag.consoleFinal);
  if (bag.network) await writeJson("network.json", bag.network);
  if (bag.redaction) await writeJson("redaction.json", bag.redaction);
  if (bag.versions) await writeJson("versions.json", bag.versions);
  if (bag.cdp) await writeJson("cdp-supplement.json", bag.cdp);
  if (bag.schemaErrors) await writeJson("schema-validation.json", bag.schemaErrors);
  if (bag.aria?.yaml) await writeFile(path.join(evidenceDir, "aria-snapshot.txt"), bag.aria.yaml);
  buildChecks();
  const requiredBad = bag.checks.filter((check) => check.required && check.status !== "passed");
  const summary = {
    task: "T00",
    hostScope: "macos-arm64",
    startedAt: bag.startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: requiredBad.length ? 1 : 0,
    passed: bag.checks.filter((check) => check.status === "passed").map((check) => check.id),
    notPassed: bag.checks.filter((check) => check.status === "not_passed").map((check) => check.id),
    unverified: bag.checks.filter((check) => check.status === "unverified").map((check) => check.id),
    blocked: [],
    checks: bag.checks,
    error: bag.error,
    proposal: {
      playwright: "1.63.0",
      image: "mcr.microsoft.com/playwright:v1.63.0-noble",
      node: "24 LTS",
      digest: null,
      locked: false,
      note: "本文件只记录 macOS。Linux 容器结论见 docs/validation-results/T00-linux-container.json。",
    },
  };
  await writeJson("summary.json", summary);
  let hits = await scanForSentinels(evidenceDir);
  if (hits.length) {
    for (const hit of hits) await rm(path.join(evidenceDir, hit.file), { force: true });
    summary.scrubbed = hits;
    summary.exitCode = 1;
    summary.notPassed.push("macos.redaction.scan");
    await writeJson("summary.json", summary);
    hits = await scanForSentinels(evidenceDir);
  }
  if (hits.length) {
    for (const hit of hits) await rm(path.join(evidenceDir, hit.file), { force: true });
    process.exitCode = 1;
    return;
  }
  const files = [];
  for (const name of await readdir(evidenceDir)) {
    const full = path.join(evidenceDir, name);
    const info = await stat(full);
    if (!info.isFile()) continue;
    const buf = await readFile(full);
    files.push({ file: name, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  await writeJson("manifest.json", { files: files.sort((a, b) => a.file.localeCompare(b.file)) });
  const finalHits = await scanForSentinels(evidenceDir);
  process.exitCode = finalHits.length ? 1 : summary.exitCode;
  console.log(JSON.stringify({
    exitCode: process.exitCode,
    passed: summary.passed.length,
    notPassed: summary.notPassed,
    unverified: summary.unverified,
    scrubbed: summary.scrubbed || [],
  }));
}

async function closeRuntime() {
  await Promise.race([
    bag.page?.close({ runBeforeUnload: false }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  await bag.context?.close().catch(() => {});
  const browserClosed = await Promise.race([
    bag.browser?.close().then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  await bag.server?.close().catch(() => {});
  if (!browserClosed) {
    for (const pid of bag.sandbox?.pids || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  for (const name of await readdir(evidenceDir)) {
    await rm(path.join(evidenceDir, name), { recursive: true, force: true });
  }
  const playwrightPackage = readPackage("node_modules/playwright/package.json");
  const corePackage = readPackage("node_modules/playwright-core/package.json");
  bag.playwrightVersion = playwrightPackage?.version || null;
  const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"];
  const host = bag.host = {
    platform: process.platform,
    arch: process.arch,
    osVersion: capture("sw_vers", ["-productVersion"]),
    osBuild: capture("sw_vers", ["-buildVersion"]),
    uname: capture("uname", ["-sm"]),
    node: process.version,
    npm: capture("npm", ["-v"]),
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    docker: dockerStatus(),
    podman: hasBin("podman"),
    proxyEnv: Object.fromEntries(proxyNames.map((name) => [name, process.env[name] ? "set" : "unset"])),
    note: "uid 是 macOS 用户。代理只记录是否设置。Linux 容器结论不在本 spike。",
  };
  await writeJson("host-limits.json", {
    host,
    outOfScope: [
      "Linux 容器验收见 docs/validation-results/T00-linux-container.json。本文件不记录容器结论。",
    ],
    notPassedHere: [
      "内网 DNS：未提供内部主机名，未解析，不记录本机 DNS 服务器地址。",
      "代理：未按产品 Worker 策略做内网请求。本机代理变量见 host.proxyEnv，值为 set/unset。",
      "公司 CA / 内网 TLS：未提供 CA，未做内网 HTTPS 握手。",
      "受控真实站点：未访问。127.0.0.1 fixture 不能代替。",
    ],
  });

  bag.server = await startServer();
  const expected = Object.fromEntries(Object.entries(SENTINELS).map(([kind, secret]) => [kind, sha256(secret)]));
  const network = [];
  const byRequest = new Map();
  let querySeen = false;
  const consoleLines = [];
  let consoleSeen = false;

  const defaultBrowser = await chromium.launch({ headless: true });
  bag.defaultProbe = {
    chromiumSandbox: "omitted",
    version: defaultBrowser.version(),
    ...(() => {
      const observed = descendantProcs(process.pid);
      return {
        browserProcessCount: observed.browserProcessCount,
        noSandbox: observed.noSandbox,
        disableSetuidSandbox: observed.disableSetuidSandbox,
        disableDevShmUsage: observed.flags.includes("--disable-dev-shm-usage"),
      };
    })(),
  };
  await defaultBrowser.close();
  bag.browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  bag.launchOk = true;
  bag.browserVersion = bag.browser.version();
  bag.executablePath = chromium.executablePath();
  bag.sandbox = descendantProcs(process.pid);
  bag.context = await bag.browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "zh-CN",
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  bag.page = await bag.context.newPage();
  const page = bag.page;
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  page.on("console", (msg) => {
    const raw = msg.text();
    if (raw.includes(SENTINELS.console)) consoleSeen = true;
    consoleLines.push(redactText(`${msg.type()}: ${raw}`).slice(0, 1000));
  });
  page.on("pageerror", (error) => {
    consoleLines.push(redactText(`pageerror: ${error.message}`).slice(0, 1000));
  });
  page.on("request", (req) => {
    const raw = req.url();
    if (raw.includes(SENTINELS.query)) querySeen = true;
    const entry = {
      url: redactUrl(raw),
      method: req.method(),
      status: null,
      resourceType: req.resourceType(),
      summary: "",
    };
    byRequest.set(req, entry);
    network.push(entry);
  });
  page.on("response", (res) => {
    const entry = byRequest.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    const setCookieCount = typeof res.headerValues === "function" ? res.headerValues("set-cookie").length : 0;
    if (setCookieCount > 0 || res.headers()["set-cookie"]) entry.summary = "set-cookie omitted";
  });
  page.on("requestfailed", (req) => {
    const entry = byRequest.get(req);
    if (!entry) return;
    entry.summary = redactText(req.failure()?.errorText || "failed").slice(0, 200);
  });

  const target = `${bag.server.origin}/?auth=${encodeURIComponent(SENTINELS.query)}`;
  const navStarted = Date.now();
  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
  bag.navigateMs = Date.now() - navStarted;
  bag.responseStatus = response ? response.status() : null;
  bag.displayUrl = redactUrl(page.url());
  bag.navigateOk = bag.responseStatus === 200 && new URL(page.url()).hostname === "127.0.0.1";
  bag.actions.push({ type: "navigate", status: bag.navigateOk ? "passed" : "not_passed", waitUntil: "domcontentloaded", url: bag.displayUrl, responseStatus: bag.responseStatus, elapsedMs: bag.navigateMs });

  const early = await page.evaluate(() => ({
    spinnerVisible: !document.getElementById("spinner").hidden,
    lateVisible: !document.getElementById("late").hidden,
  }));
  bag.earlyOk = early.spinnerVisible === true && early.lateVisible === false;
  const waitStarted = Date.now();
  await page.getByTestId("late-content").waitFor({ state: "visible", timeout: 15000 });
  bag.waitedMs = Date.now() - waitStarted;
  const clocks = await page.evaluate(() => ({
    delay: window.__lateAt - window.__bootedAt,
    lateVisible: !document.getElementById("late").hidden,
    spinnerVisible: !document.getElementById("spinner").hidden,
  }));
  bag.delayMs = clocks.delay;
  bag.waitOk = clocks.lateVisible === true && clocks.spinnerVisible === false && clocks.delay >= 1500 && bag.waitedMs >= 800;
  bag.actions.push({ type: "wait-state", status: bag.waitOk ? "passed" : "not_passed", target: "late-content", state: "visible", elapsedMs: bag.waitedMs, pageDelayMs: bag.delayMs });

  try {
    await page.frameLocator("#side").locator("#frame-text").waitFor({ state: "visible", timeout: 15000 });
    bag.frameOk = true;
  } catch (error) {
    bag.frameOk = false;
    bag.frameError = redactText(error.message).slice(0, 300);
  }

  const idleStarted = Date.now();
  try {
    await page.waitForLoadState("networkidle", { timeout: 1500 });
    bag.networkIdle = "settled";
  } catch {
    bag.networkIdle = "timed_out";
  }
  bag.networkIdleMs = Date.now() - idleStarted;

  const saveRole = await classify(page.getByRole("button", { name: "保存", exact: true }));
  const duplicateText = await classify(page.getByText("请确认内容", { exact: true }));
  const draft = await classify(page.getByTestId("save-draft"));
  const dangerRole = await classify(page.getByRole("button", { name: "危险操作" }));
  let dangerIncludeHidden = { error: "not-run" };
  try {
    dangerIncludeHidden = await classify(page.getByRole("button", { name: "危险操作", includeHidden: true }));
  } catch (error) {
    dangerIncludeHidden = { error: redactText(error.message).slice(0, 200), reason: "error", actionable: false };
  }
  const dangerVisible = await page.locator("#hidden-danger").isVisible();
  const flagsBefore = await clickFlags(page);
  bag.duplicateOk = saveRole.reason === "not_unique" && saveRole.visibleCount >= 2 && duplicateText.reason === "not_unique" && duplicateText.visibleCount >= 2 && flagsBefore.save === 0;
  bag.testIdUnique = draft.actionable === true;
  bag.hiddenOk = dangerVisible === false && dangerRole.visibleCount === 0 && flagsBefore.hidden === false;
  bag.actions.push({ type: "click", status: "refused", reason: saveRole.reason, name: "保存", ...saveRole, clicked: false });
  bag.actions.push({ type: "resolve-text", status: "refused", reason: duplicateText.reason, name: "请确认内容", ...duplicateText, clicked: false });
  bag.actions.push({ type: "click", status: "refused", reason: "not_visible", name: "危险操作", domVisible: dangerVisible, role: dangerRole, includeHidden: dangerIncludeHidden, clicked: false });

  const pageId = randomUUID();
  const viewport = page.viewportSize();
  const title = await page.title();
  const s1nodes = await collectNodes(page);
  const fp1 = fingerprint(s1nodes.parts);
  const networkS1 = copyEntries(network);
  const consoleS1 = consoleLines.slice();
  bag.s1 = assembleSnapshot({
    snapshotId: randomUUID(),
    pageId,
    frameIds: s1nodes.frameIds,
    displayUrl: bag.displayUrl,
    title,
    responseStatus: bag.responseStatus,
    stateVersion: 1,
    viewport,
    nodes: s1nodes.nodes,
    screenshotRef: null,
    networkSummary: networkS1,
    consoleSummary: consoleS1,
  });

  const note = page.getByRole("textbox", { name: "备注" });
  const noteClass = await classify(note);
  if (!noteClass.actionable) throw new Error(`note not actionable: ${noteClass.reason}`);
  await note.fill("T00备注");
  bag.fillOk = (await note.inputValue()) === "T00备注";
  bag.actions.push({ type: "fill", status: bag.fillOk ? "passed" : "not_passed", target: "备注", uniqueness: noteClass });

  const mid = await collectNodes(page);
  const fpMid = fingerprint(mid.parts);
  bag.fillChangedFingerprint = fpMid !== fp1;
  const apply = page.getByTestId("apply-note");
  const applyClass = await classify(apply);
  if (applyClass.actionable && fpMid === fp1) {
    await apply.click({ timeout: 15000 });
    bag.clickOk = true;
  }
  const echo = await page.locator("#echo").innerText();
  bag.echoOk = echo === "已写入:T00备注";
  bag.echo = containedKinds(echo).length ? "[redacted]" : echo;
  bag.clickOk = bag.clickOk === true && bag.echoOk;
  bag.actions.push({ type: "click", status: bag.clickOk ? "passed" : "not_passed", target: "写入备注", snapshotId: bag.s1.snapshotId, uniqueness: applyClass, rechecked: fpMid === fp1 });

  const afterFlags = await clickFlags(page);
  const s2nodes = await collectNodes(page);
  const fp2 = fingerprint(s2nodes.parts);
  bag.staleOk = fp2 !== fp1 && afterFlags.apply === 1 && afterFlags.save === 0 && afterFlags.hidden === false;
  bag.actions.push({ type: "click", status: "refused", reason: "stale_snapshot", snapshotId: bag.s1.snapshotId, fingerprintChanged: fp2 !== fp1, applyClicks: afterFlags.apply });
  const flagsAfterRefusal = await clickFlags(page);
  if (flagsAfterRefusal.apply !== 1 || flagsAfterRefusal.save !== 0 || flagsAfterRefusal.hidden !== false) bag.staleOk = false;

  const presence = await page.evaluate(async (hashes) => {
    async function digest(text) {
      const bytes = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(buf)].map((item) => item.toString(16).padStart(2, "0")).join("");
    }
    const hidden = document.querySelector("#token");
    const password = document.querySelector("#pw");
    return {
      hiddenInput: hidden ? (await digest(hidden.value)) === hashes.hiddenInput : false,
      password: password ? (await digest(password.value)) === hashes.password : false,
      storage: (await digest(localStorage.getItem("lqa_token") || "")) === hashes.storage,
      session: (await digest(sessionStorage.getItem("lqa_session") || "")) === hashes.session,
    };
  }, expected);
  const cookies = await bag.context.cookies();
  const cookie = cookies.find((item) => item.name === "lqa_session");
  const cookieOk = cookie ? sha256(cookie.value) === expected.cookie : false;
  const queryOk = sha256(new URL(page.url()).searchParams.get("auth") || "") === expected.query;
  const docCookie = await page.evaluate(() => document.cookie);
  const cookieVisibleToJs = docCookie.includes(SENTINELS.cookie);
  let html = await page.content();
  const htmlKinds = containedKinds(html);
  html = "";
  const storageKeys = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
  bag.fontProbe = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    const sample = "延迟内容";
    const width = (font) => {
      ctx.font = font;
      return ctx.measureText(sample).width;
    };
    return { sample, sans: width("16px sans-serif"), pingfang: width('16px "PingFang SC"') };
  });
  bag.fontOk = bag.fontProbe.sans > 8;
  bag.userAgent = await page.evaluate(() => navigator.userAgent);

  bag.aria = await captureAria(page);
  bag.cdp = await captureCdp(page);
  await page.evaluate(() => {
    const password = document.querySelector("#pw");
    const hidden = document.querySelector("#token");
    if (password) password.value = "";
    if (hidden) hidden.value = "";
  });
  const screenshotRef = randomUUID();
  await page.screenshot({ path: path.join(evidenceDir, "screenshot.png"), fullPage: true });
  bag.screenshotBytes = (await stat(path.join(evidenceDir, "screenshot.png"))).size;

  bag.network = copyEntries(network);
  bag.consoleFinal = consoleLines.slice();
  bag.consoleSeen = consoleSeen;
  bag.querySeen = querySeen;
  bag.ping = bag.network.find((entry) => pathnameOf(entry.url) === "/api/ping") || null;
  bag.hang = bag.network.find((entry) => pathnameOf(entry.url) === "/api/hang") || null;
  bag.postCount = bag.network.filter((entry) => entry.method === "POST").length;
  bag.foreignHosts = [...new Set(bag.network.map((entry) => {
    try {
      return new URL(entry.url).hostname;
    } catch {
      return "invalid";
    }
  }))].filter((hostName) => hostName !== "127.0.0.1");

  bag.s2 = assembleSnapshot({
    snapshotId: randomUUID(),
    pageId,
    frameIds: s2nodes.frameIds,
    displayUrl: bag.displayUrl,
    title,
    responseStatus: bag.responseStatus,
    stateVersion: 2,
    viewport,
    nodes: s2nodes.nodes,
    screenshotRef,
    networkSummary: bag.network,
    consoleSummary: bag.consoleFinal,
  });
  const schemaS1 = await validateBrowserSnapshot(bag.s1, schemaPath);
  const schemaS2 = await validateBrowserSnapshot(bag.s2, schemaPath);
  bag.schemaOk = schemaS1.ok && schemaS2.ok;
  bag.schemaErrors = { before: schemaS1, after: schemaS2 };

  const lateNode = bag.s2.nodes.some((node) => node.text === "延迟内容已出现");
  const echoNode = bag.s2.nodes.some((node) => node.text === "已写入:T00备注");
  const saveNodes = bag.s2.nodes.filter((node) => node.role === "button" && node.name === "保存").length;
  const hiddenExcluded = s2nodes.excluded.some((item) => item.domId === "hidden-danger");
  const tokenExcluded = s2nodes.omissions.some((item) => item.domId === "token");
  const passwordOmitted = s2nodes.omissions.some((item) => item.domId === "pw");
  bag.redactionOk = presence.hiddenInput && presence.password && presence.storage && presence.session
    && cookieOk && queryOk && !cookieVisibleToJs && querySeen && consoleSeen
    && htmlKinds.includes("hiddenInput") && htmlKinds.includes("password") && htmlKinds.includes("storage")
    && htmlKinds.includes("session") && htmlKinds.includes("console")
    && tokenExcluded && passwordOmitted && hiddenExcluded && lateNode && echoNode && saveNodes === 2
    && bag.consoleFinal.some((line) => line.includes("fixture console") && line.includes("[redacted]"))
    && bag.displayUrl.includes("auth=[redacted]");

  bag.scenarios = {
    timeouts: { navigationMs: 30000, actionMs: 15000, networkIdleProbeMs: 1500, lateRenderMs: 1600 },
    early,
    clocks,
    waitedMs: bag.waitedMs,
    networkIdle: bag.networkIdle,
    networkIdleMs: bag.networkIdleMs,
    saveRole,
    duplicateText,
    draft,
    dangerRole,
    dangerIncludeHidden,
    fingerprints: { before: fp1, afterFill: fpMid, afterClick: fp2, fillChanged: bag.fillChangedFingerprint, clickChanged: fp2 !== fp1 },
    flags: { before: flagsBefore, afterClick: afterFlags, afterStaleRefusal: flagsAfterRefusal },
    frameIdsBefore: s1nodes.frameIds.length,
    frameIdsAfter: s2nodes.frameIds.length,
    excluded: s2nodes.excluded,
    omissions: s2nodes.omissions,
    iframeTextPresent: s2nodes.nodes.some((node) => node.text === "iframe 可见文本"),
  };
  bag.redaction = {
    policy: REDACTION_POLICY,
    presence: { ...presence, cookie: cookieOk, query: queryOk, console: consoleSeen, queryInNavigation: querySeen },
    htmlContainedKinds: htmlKinds,
    cookie: cookie ? { name: cookie.name, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, valueOmitted: true } : null,
    cookieVisibleToDocumentCookie: cookieVisibleToJs,
    storageKeys,
    storageValueOmitted: true,
    ariaContainedSentinelKinds: bag.aria?.containedSentinelKinds || [],
    cdpDomContainedSentinelKinds: bag.cdp?.dom?.containedSentinelKinds || [],
    cdpAxContainedSentinelKinds: bag.cdp?.axContainedSentinelKinds || [],
    rawHtmlPersisted: false,
    rawCdpPersisted: false,
    rawTracePersisted: false,
    screenshotMasked: true,
    displayUrl: bag.displayUrl,
  };
  bag.versions = {
    playwright: playwrightPackage?.version || null,
    playwrightCore: corePackage?.version || null,
    browserVersion: bag.browserVersion,
    executablePath: bag.executablePath,
    catalog: browserCatalog(),
    userAgent: bag.userAgent,
    launch: { headless: true, chromiumSandbox: true, extraArgs: [] },
    defaultLaunchProbe: bag.defaultProbe || null,
    sandboxObservation: bag.sandbox ? {
      browserProcessCount: bag.sandbox.browserProcessCount,
      noSandbox: bag.sandbox.noSandbox,
      disableSetuidSandbox: bag.sandbox.disableSetuidSandbox,
      flags: bag.sandbox.flags,
      scope: "macos-process-list",
    } : null,
    fontProbe: bag.fontProbe,
    node: process.version,
    v8: process.versions.v8,
  };

}

const { startServer } = await import("./server.mjs");

try {
  await main();
} catch (error) {
  bag.error = redactText(error?.stack || String(error)).slice(0, 4000);
} finally {
  await closeRuntime();
  try {
    await persist();
  } catch (error) {
    process.exitCode = 1;
    console.error(redactText(error?.stack || String(error)).slice(0, 1000));
  }
  process.exit(process.exitCode || 0);
}
