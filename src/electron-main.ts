import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { desktopSearchPath, mergeChildEnvironment } from "./core/desktop-env.js";

const CONFIG_TEMPLATE = `# Multi-Agent Office local configuration
# Keep this file private. Restart the app after changing it.
# The first-start screen fills these values for you.

# Z.AI / GLM Coding Plan (mainland China)
ZAI_CODING_CN_API_KEY=
MAO_PI_PROVIDER=zai-coding-cn
MAO_PI_MODEL=glm-5.2
MAO_PI_THINKING=medium
MAO_DEFAULT_AGENT=pi
MAO_SETUP_COMPLETED=0

# Alternative providers (uncomment and update MAO_PI_PROVIDER / MAO_PI_MODEL above)
# ZAI_API_KEY=
# DEEPSEEK_API_KEY=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=

# Codex Agents use a locally installed Codex CLI. An absolute path is safest.
# MAO_CODEX_COMMAND=/absolute/path/to/codex

# Maximum concurrent read-only Agent runs.
MAO_MAX_PARALLEL_READ_RUNS=4
`;

/** Attempts to start the bundled server before giving up. */
const SERVER_START_ATTEMPTS = 3;
/** A cold first launch behind antivirus scanning can take far longer than a warm one. */
const SERVER_READY_TIMEOUT_MS = 120_000;

interface DesktopPaths {
  userDataRoot: string;
  dataRoot: string;
  configPath: string;
  logPath: string;
}

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let serverUrl: string | undefined;
let desktopLogPath: string | undefined;
let quitting = false;
let fatalReported = false;
const isWindows = process.platform === "win32";
const isSmokeTest = process.argv.includes("--smoke-test");

// The window only ever loads 127.0.0.1. A system-wide proxy (common alongside VPN
// tools) must never sit between the window and the local server.
app.commandLine.appendSwitch("no-proxy-server");

// Without these handlers an unexpected error tears the process down with no UI at
// all, which users can only describe as "double-clicking the icon does nothing".
process.on("uncaughtException", (error: unknown) => {
  void reportFatal("主进程未捕获异常", error);
});
process.on("unhandledRejection", (reason: unknown) => {
  void reportFatal("主进程未处理的 Promise 拒绝", reason);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  revealApplication();
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow) {
    revealApplication();
    return;
  }
  mainWindow = createMainWindow();
  if (serverUrl) void loadWorkspace(mainWindow, serverUrl);
});

app.on("child-process-gone", (_event, details) => {
  void writeDesktopLog(
    `Chromium child process gone: ${details.type} (${details.reason})`,
  );
});

if (hasSingleInstanceLock) {
  void app
    .whenReady()
    .then(startDesktopApp)
    .catch((error: unknown) => reportFatal("桌面启动失败", error));
}

async function startDesktopApp(): Promise<void> {
  app.setName("Multi-Agent Office");
  if (isWindows) app.setAppUserModelId("com.multiagentoffice.desktop");

  const paths = resolveDesktopPaths();
  desktopLogPath = paths.logPath;
  await ensureLogDirectory(paths);
  await writeDesktopLog(
    `Desktop launcher starting (app ${app.getVersion()}, electron ${process.versions.electron}, ${process.platform}-${process.arch})`,
  );

  // The window comes up before any work that can fail or stall, so every launch
  // produces something on screen within a second.
  if (!isSmokeTest) {
    mainWindow = createMainWindow();
    showStatusPage(
      "正在启动 Multi-Agent Office",
      "正在准备本地服务，首次启动可能需要一到两分钟。",
    );
    installApplicationMenu(paths);
  }

  await ensureConfigFile(paths);
  await mkdir(paths.dataRoot, { recursive: true });

  const url = await startLocalServer(paths);
  await writeDesktopLog(`Local server ready at ${url}`);

  if (isSmokeTest) {
    app.quit();
    return;
  }

  if (isWindows) installWindowsTray(paths);
  if (mainWindow) await loadWorkspace(mainWindow, url);
}

async function startLocalServer(paths: DesktopPaths): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERVER_START_ATTEMPTS; attempt += 1) {
    const port = await findAvailablePort();
    const url = `http://127.0.0.1:${port}`;
    await writeDesktopLog(`Starting local server on port ${port} (attempt ${attempt})`);
    const child = startServerProcess({ port, paths });
    // Track the child before it is ready so quitting mid-startup never orphans it.
    serverProcess = child;
    try {
      await waitForServer(url, child);
      serverUrl = url;
      watchServerExit(child, paths.logPath);
      return url;
    } catch (error) {
      lastError = error;
      await writeDesktopLog(
        `Local server attempt ${attempt} failed on port ${port}: ${errorMessage(error)}`,
      );
      child.removeAllListeners("exit");
      if (child.exitCode === null && child.signalCode === null) child.kill();
      serverProcess = undefined;
      if (quitting) break;
      if (attempt < SERVER_START_ATTEMPTS) await delay(500);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("本地服务启动失败，请查看 desktop.log");
}

function startServerProcess(input: {
  port: number;
  paths: DesktopPaths;
}): ChildProcessWithoutNullStreams {
  const appRoot = app.getAppPath();
  const entryPath = join(appRoot, "dist", "src", "server.js");
  const log = createWriteStream(input.paths.logPath, { flags: "a" });
  const child = spawn(process.execPath, [entryPath], {
    cwd: input.paths.userDataRoot,
    env: mergeChildEnvironment(process.env, {
      ELECTRON_RUN_AS_NODE: "1",
      PATH: desktopPath(),
      PORT: String(input.port),
      MAO_APP_ROOT: appRoot,
      MAO_CONFIG_FILE: input.paths.configPath,
      MAO_DATA_DIR: input.paths.dataRoot,
      MAO_DEFAULT_WORKSPACE: defaultWorkspacePath(),
      MAO_WEB_ROOT: join(appRoot, "dist-web"),
    }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  log.write(`\n[${new Date().toISOString()}] Starting local server\n`);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("close", () => log.end());
  child.once("error", (error) => {
    log.write(`[${new Date().toISOString()}] Server spawn error: ${errorStack(error)}\n`);
  });
  return child;
}

function watchServerExit(child: ChildProcessWithoutNullStreams, logPath: string): void {
  child.once("exit", (code, signal) => {
    void writeDesktopLog(`Server exited (${code ?? signal ?? "unknown"})`);
    if (quitting) return;
    showStatusPage(
      "本地服务已停止",
      `Multi-Agent Office 的本地服务意外退出（${code ?? signal ?? "unknown"}）。`,
      "error",
    );
    void dialog.showMessageBox({
      type: "error",
      title: "本地服务已停止",
      message: "Multi-Agent Office 的本地服务意外退出。",
      detail: `退出状态：${code ?? signal ?? "unknown"}\n日志：${logPath}\n\n${readLogTail()}`,
    });
  });
}

function createMainWindow(): BrowserWindow {
  const icon = applicationIcon();
  const window = new BrowserWindow({
    title: "Multi-Agent Office",
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: true,
    backgroundColor: "#f5f1e8",
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (!serverUrl || !target.startsWith(serverUrl)) event.preventDefault();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    void writeDesktopLog(`Renderer process gone: ${details.reason}`);
    if (!quitting && serverUrl) void openFrontendInBrowser(serverUrl);
  });
  window.webContents.on(
    "did-fail-load",
    (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      void writeDesktopLog(`Window failed to load ${failedUrl}: ${description} (${code})`);
    },
  );
  return window;
}

async function loadWorkspace(window: BrowserWindow, url: string): Promise<void> {
  try {
    await window.loadURL(url);
    await writeDesktopLog("Workspace window displayed");
  } catch (error) {
    await writeDesktopLog(`Could not display the workspace: ${errorStack(error)}`);
    showStatusPage(
      "无法显示工作台",
      "本地服务已经就绪，正在改用系统默认浏览器打开。",
      "error",
    );
    await openFrontendInBrowser(url);
  }
}

async function openFrontendInBrowser(url: string): Promise<void> {
  try {
    await shell.openExternal(url);
  } catch (error) {
    await writeDesktopLog(`Could not open the default browser: ${errorStack(error)}`);
    await dialog.showMessageBox({
      type: "error",
      title: "无法打开浏览器",
      message: "Multi-Agent Office 已启动，但无法打开系统默认浏览器。",
      detail: `请手动打开：${url}`,
    });
  }
}

function revealApplication(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (serverUrl) void openFrontendInBrowser(serverUrl);
}

function installWindowsTray(paths: DesktopPaths): void {
  const icon = applicationIcon();
  if (!icon || icon.isEmpty()) {
    void writeDesktopLog("Tray icon unavailable; skipping the notification area icon");
    return;
  }
  try {
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
  } catch (error) {
    void writeDesktopLog(`Could not create the tray icon: ${errorStack(error)}`);
    return;
  }
  tray.setToolTip("Multi-Agent Office");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => revealApplication(),
      },
      {
        label: "在浏览器中打开",
        click: () => {
          if (serverUrl) void openFrontendInBrowser(serverUrl);
        },
      },
      { type: "separator" },
      {
        label: "打开 config.env",
        click: () => void openLocalFile(paths.configPath),
      },
      {
        label: "打开用户数据目录",
        click: () => void shell.openPath(paths.dataRoot),
      },
      {
        label: "打开运行日志",
        click: () => void openLocalFile(paths.logPath),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => app.quit(),
      },
    ]),
  );
  tray.on("click", () => revealApplication());
  tray.on("double-click", () => revealApplication());
}

function installApplicationMenu(paths: DesktopPaths): void {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    {
      label: "配置",
      submenu: [
        {
          label: "打开 config.env",
          accelerator: "CmdOrCtrl+,",
          click: () => void openLocalFile(paths.configPath),
        },
        {
          label: "打开用户数据目录",
          click: () => void shell.openPath(paths.dataRoot),
        },
        {
          label: "打开运行日志",
          click: () => void openLocalFile(paths.logPath),
        },
        {
          label: "在浏览器中打开",
          click: () => {
            if (serverUrl) void openFrontendInBrowser(serverUrl);
          },
        },
        { type: "separator" },
        {
          label: "重启以应用配置",
          click: () => {
            app.relaunch();
            app.quit();
          },
        },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * `app.getPath` reads the Windows shell folders, which fail on machines whose
 * profile directories were redirected or removed. Startup must survive that.
 */
function resolveDesktopPaths(): DesktopPaths {
  const userDataRoot = safePath("userData", () =>
    join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "Multi-Agent Office",
    ),
  );
  return {
    userDataRoot,
    dataRoot: join(userDataRoot, "data"),
    configPath: join(userDataRoot, "config.env"),
    logPath: join(userDataRoot, "desktop.log"),
  };
}

function defaultWorkspacePath(): string {
  return safePath("documents", () => safePath("home", () => homedir()));
}

function safePath(name: "userData" | "documents" | "home", fallback: () => string): string {
  try {
    const value = app.getPath(name);
    if (value) return value;
  } catch (error) {
    void writeDesktopLog(`Could not resolve the ${name} path: ${errorMessage(error)}`);
  }
  return fallback();
}

function applicationIcon(): NativeImage | undefined {
  for (const candidate of [
    join(app.getAppPath(), "build", "icon.png"),
    join(process.resourcesPath, "build", "icon.png"),
  ]) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function ensureLogDirectory(paths: DesktopPaths): Promise<void> {
  try {
    await mkdir(paths.userDataRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Keep launching: the dialog path still reports the failure to the user.
    console.error("Could not create the user data directory", error);
  }
}

async function ensureConfigFile(paths: DesktopPaths): Promise<void> {
  if (existsSync(paths.configPath)) return;
  await mkdir(paths.userDataRoot, { recursive: true, mode: 0o700 });
  await writeFile(paths.configPath, CONFIG_TEMPLATE, { encoding: "utf8", mode: 0o600 });
}

async function openLocalFile(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) shell.showItemInFolder(path);
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("无法分配本地端口"));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForServer(
  url: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let nextNotice = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (quitting) throw new Error("启动过程中应用已退出");
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("本地服务在启动完成前退出，请查看 desktop.log");
    }
    if (await probeHealth(url)) return;
    if (Date.now() >= nextNotice) {
      nextNotice = Date.now() + 5_000;
      const seconds = Math.round((SERVER_READY_TIMEOUT_MS - (deadline - Date.now())) / 1000);
      showStatusPage(
        "正在启动 Multi-Agent Office",
        `正在等待本地服务就绪（已用 ${seconds} 秒）。首次启动时杀毒软件扫描会明显拖慢这一步。`,
      );
    }
    await delay(200);
  }
  throw new Error("等待本地服务启动超时，请查看 desktop.log");
}

/**
 * Uses `node:http` rather than `fetch` so the probe cannot be diverted by a proxy
 * agent or DNS setting: it must reach the loopback server and nothing else.
 */
async function probeHealth(url: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const request = httpGet(`${url}/api/health`, { timeout: 2_000 }, (response) => {
      response.resume();
      resolveProbe(response.statusCode === 200);
    });
    request.once("error", () => resolveProbe(false));
    request.once("timeout", () => {
      request.destroy();
      resolveProbe(false);
    });
  });
}

function desktopPath(): string {
  return desktopSearchPath({
    platform: process.platform,
    environment: process.env,
    homeDirectory: homedir(),
  });
}

function stopServer(): void {
  if (!serverProcess || serverProcess.killed) return;
  serverProcess.kill("SIGTERM");
  serverProcess = undefined;
}

function showStatusPage(
  title: string,
  detail: string,
  tone: "info" | "error" = "info",
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const accent = tone === "error" ? "#a4342b" : "#6b6353";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>Multi-Agent Office</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f5f1e8; color: #2f2a21;
         font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.7; color: ${accent}; }
  code { font-size: 0.85em; word-break: break-all; }
</style></head>
<body><main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${desktopLogPath ? `<p><code>${escapeHtml(desktopLogPath)}</code></p>` : ""}
</main></body></html>`;
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function reportFatal(title: string, error: unknown): Promise<void> {
  if (fatalReported) return;
  fatalReported = true;
  await writeDesktopLog(`${title}: ${errorStack(error)}`);
  // A failure caused by the user quitting mid-startup is not worth a dialog.
  if (quitting) return;
  const detail = [
    desktopLogPath ? `日志：${desktopLogPath}` : "尚未创建日志文件。",
    readLogTail(),
  ]
    .filter(Boolean)
    .join("\n\n");
  showStatusPage(title, errorMessage(error), "error");
  try {
    if (app.isReady()) {
      await dialog.showMessageBox({
        type: "error",
        title: "Multi-Agent Office 启动失败",
        message: `${title}：${errorMessage(error)}`,
        detail,
      });
    } else {
      dialog.showErrorBox("Multi-Agent Office 启动失败", `${title}：${errorMessage(error)}\n\n${detail}`);
    }
  } catch (dialogError) {
    console.error("Could not show the startup failure dialog", dialogError);
  }
  app.quit();
}

function readLogTail(lines = 20): string {
  if (!desktopLogPath || !existsSync(desktopLogPath)) return "";
  try {
    return readFileSync(desktopLogPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : errorMessage(error);
}

async function writeDesktopLog(message: string): Promise<void> {
  if (!desktopLogPath) return;
  try {
    await appendFile(
      desktopLogPath,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8",
    );
  } catch {
    // Logging must never prevent the desktop launcher from starting.
  }
}
