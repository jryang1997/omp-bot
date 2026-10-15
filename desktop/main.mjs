import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { TERMINAL_RUN_STATES } from "../src/constants.mjs";
import { startServer } from "../src/server.mjs";

const runFile = promisify(execFile);

// 本机兼容底线：台账用 node:sqlite，需要 Node >= 24；原生 OMP 协议按 18.10 冻结。
const MIN_OMP = [18, 10, 0];
const MIN_NODE_MAJOR = 24;
const RUN_LIST_LIMIT = 1000;
// 打包身份与 installer 一致；开发版独立，避免 Electron 的外壳缓存污染正式版。
const APP_USER_MODEL_ID = app.isPackaged ? "org.ompbot.app" : "org.ompbot.app.dev";

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? m.slice(1, 4).map(Number) : null;
}
function atLeast(found, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    const a = found[i] ?? 0;
    if (a !== minimum[i]) return a > minimum[i];
  }
  return true;
}

async function checkRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= MIN_NODE_MAJOR)) {
    throw new Error(
      `需要 Node ${MIN_NODE_MAJOR} 或更新版本（当前 ${process.versions.node}）。\n` +
        "工作台台账使用 Node 内置 node:sqlite；旧版本没有这个模块。",
    );
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    if (typeof DatabaseSync !== "function") throw new Error("DatabaseSync 缺失");
  } catch (error) {
    throw new Error(`当前运行时缺少可用的 node:sqlite，工作台无法保存台账：${error.message}`);
  }
}

/** 找可用的原生 omp，并记录来源与版本（打包时优先随包内置的那份）。 */
async function findOmp() {
  const executable = process.platform === "win32" ? "omp.exe" : "omp";
  const candidates = [];
  if (app.isPackaged) candidates.push([join(process.resourcesPath, "runtime", executable), "bundled"]);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const clean = directory.trim().replace(/^"(.*)"$/, "$1");
    if (isAbsolute(clean)) candidates.push([join(clean, executable), "path"]);
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push([join(process.env.LOCALAPPDATA, "omp", executable), "localappdata"]);
  }

  let failure;
  for (const [candidate, source] of candidates) {
    if (!existsSync(candidate)) continue;
    let version;
    try {
      const { stdout } = await runFile(candidate, ["--version"], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      version = parseVersion(stdout);
      if (!version) throw new Error(`无法识别的版本输出: ${String(stdout).trim().slice(0, 80)}`);
    } catch (error) {
      failure = error;
      continue;
    }
    if (!atLeast(version, MIN_OMP)) {
      failure = new Error(`${candidate} 是 ${version.join(".")}，低于要求的 ${MIN_OMP.join(".")}`);
      continue;
    }
    return { bin: candidate, version: version.join("."), source };
  }
  throw new Error(
    (app.isPackaged
      ? "内置 OMP 无法启动。请重新安装 omp-bot，或把可运行的原生 omp.exe 加入 PATH。\n"
      : "找不到可运行的 OMP。请先安装 oh-my-pi 的原生 omp.exe，将它加入 PATH，" +
        "或安装到 %LOCALAPPDATA%\\omp\\omp.exe。\n") +
      `需要 OMP ${MIN_OMP.join(".")} 或更新版本。\n` +
      "请在 OMP 中配置模型和登录凭据（在终端运行 `omp login`），然后重新打开 omp-bot。" +
      (failure ? `\n\n${failure.message}` : ""),
  );
}

/** 打包内置 OMP 的版本来源（.desktop-runtime/VERSION 由 scripts/prepare-desktop.mjs 写入）。 */
function bundledProvenance() {
  if (!app.isPackaged) return null;
  const file = join(process.resourcesPath, "runtime", "VERSION");
  try {
    return existsSync(file) ? readFileSync(file, "utf8").trim() : "缺少 VERSION 记录";
  } catch (error) {
    return `VERSION 读取失败: ${error.message}`;
  }
}

function appIconFile() {
  return join(app.getAppPath(), "web", "assets", process.platform === "win32" ? "app-icon.ico" : "app-icon.png");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows 上原生通知要归属到应用自己，否则可能挂在 electron 默认名下。
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
  let phase = "starting"; // starting | running | stopping | stopped
  let backend;
  let window;
  let tray;
  let omp; // { bin, version, source }
  const notified = new Set();

  function showWindow(botId) {
    if (!window || window.isDestroyed() || phase === "stopping" || phase === "stopped") return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (botId) {
      // 通知点击后让 UI 打开对应 bot：UiOwner 在 renderer 里监听 ompbot:open-bot，detail = { botId }。
      void window.webContents
        .executeJavaScript(`window.dispatchEvent(new CustomEvent("ompbot:open-bot", { detail: ${JSON.stringify({ botId })} }))`)
        .catch(() => {});
    }
  }

  app.on("second-instance", () => showWindow());

  function notify(key, title, body, botId) {
    if (!Notification.isSupported() || notified.has(key)) return;
    notified.add(key);
    if (notified.size > 500) notified.clear();
    // 前台已经看得到的进展不重复弹系统通知。
    if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) return;
    const notification = new Notification({ title, body: body.slice(0, 400) });
    notification.on("click", () => showWindow(botId));
    notification.show();
  }

  function botName(botId) {
    if (!botId) return "团队";
    try {
      return backend?.orch.getBot(botId)?.name ?? botId;
    } catch {
      return botId;
    }
  }

  function handleEvent(event) {
    if (!event || typeof event !== "object") return;
    if (String(event.type).startsWith("run_") || String(event.type).startsWith("ui_")) refreshTray();
    const run = event.run;
    if (event.type === "run_finished" && run) {
      if (run.state === "completed") {
        notify(`run:${run.id}`, `${botName(run.botId)} 已完成`, run.reply || run.text || "回合已结束", run.botId);
      } else if (run.state === "failed") {
        notify(`run:${run.id}`, `${botName(run.botId)} 运行失败`, run.error || "任务以失败结束", run.botId);
      } else if (run.state === "reconciliation_required" || run.state === "interrupted") {
        // 外部效果未知/被中断：这类必须让人看到，不能当成普通失败悄悄过去。
        notify(
          `run:${run.id}`,
          `${botName(run.botId)} 需要你确认`,
          run.recovery?.reason ? `外部效果未知（${run.recovery.reason}）：已停止且不会自动重放` : run.error || `运行以 ${run.state} 结束`,
          run.botId,
        );
      }
      return;
    }
    if (event.type === "run_updated" && run && (run.state === "waiting_input" || run.state === "waiting_approval")) {
      notify(`wait:${run.id}:${run.state}`, `${botName(run.botId)} 等你处理`, run.text || "有一步需要你确认或补充", run.botId);
      return;
    }
    if (event.type === "ui_request") {
      const approval = event.approval ?? event;
      const id = approval?.id ?? approval?.nativeId ?? "unknown";
      notify(
        `ui:${id}`,
        "需要你审批",
        [approval?.title, approval?.message].filter(Boolean).join(" — ") || "原生工具请求你的决定",
        approval?.botId,
      );
    }
  }

  function watchEvents(orch) {
    const forward = typeof orch.onEvent === "function" ? orch.onEvent : null;
    orch.onEvent = (event) => {
      try {
        forward?.(event);
      } catch (error) {
        if (!app.isPackaged) console.error("事件转发失败", error);
      }
      try {
        handleEvent(event);
      } catch (error) {
        if (!app.isPackaged) console.error("通知处理失败", error);
      }
    };
  }

  function counts() {
    if (!backend) return { active: null, pending: null };
    let active = null;
    let pending = null;
    try {
      if (typeof backend.orch.listRuns === "function") {
        active = backend.orch.listRuns({ limit: RUN_LIST_LIMIT }).filter((run) => !TERMINAL_RUN_STATES.has(run.state)).length;
      }
    } catch {}
    try {
      const ledger = backend.orch.ledger;
      if (typeof ledger?.list === "function") {
        pending = ledger.list("approvals", { limit: 500 }).filter((a) => a.status === "pending").length;
      }
    } catch {}
    return { active, pending };
  }

  function buildTrayMenu() {
    const { active, pending } = counts();
    return Menu.buildFromTemplate([
      { label: window?.isVisible() ? "隐藏窗口" : "显示窗口", click: () => (window?.isVisible() ? window.hide() : showWindow()) },
      { type: "separator" },
      { label: active === null ? "后台任务 (不可用)" : `后台任务 ${active}`, enabled: false },
      ...(pending === null ? [] : [{ label: `待审批 ${pending}`, enabled: false }]),
      { type: "separator" },
      { label: "打开数据目录", click: openDataDir },
      ...nativeMenuItems(),
      { type: "separator" },
      { label: "退出 omp-bot", click: () => app.quit() },
    ]);
  }

  function refreshTray() {
    if (!tray) return;
    try {
      tray.setContextMenu(buildTrayMenu());
      tray.setToolTip(counts().active ? `omp-bot · 后台任务 ${counts().active}` : "omp-bot");
    } catch {}
  }

  function openDataDir() {
    const home = backend?.orch?.home;
    if (!home) return;
    void shell.openPath(home).then((message) => {
      if (message) dialog.showErrorBox("无法打开数据目录", `${home}\n\n${message}`);
    });
  }

  function runNative(args) {
    if (!omp) throw new Error("还没有找到可用的 OMP");
    return runFile(omp.bin, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  }

  async function showVersion() {
    let native = `可用版本: ${omp?.version ?? "未探测"} (${omp?.source ?? "?"})`;
    try {
      const { stdout } = await runNative(["--version"]);
      native = `omp --version: ${String(stdout).trim()}`;
    } catch (error) {
      native += `\n读取 omp --version 失败: ${error.message}`;
    }
    const bundled = bundledProvenance();
    dialog.showMessageBox(window, {
      type: "info",
      title: "版本",
      message: `omp-bot ${app.getVersion()}`,
      detail: [
        native,
        bundled ? `随包内置 OMP: ${bundled}` : "开发模式：使用 PATH 里的 OMP，未随包内置",
        `Electron ${process.versions.electron}`,
        `Node ${process.versions.node}`,
        `数据目录 ${backend?.orch?.home ?? "(未启动)"}`,
        "应用更新需要重新运行 npm run package:win 并安装新包；本项目没有发布源，不做自动更新。",
      ].join("\n"),
      noLink: true,
    });
  }

  async function showDiagnostics() {
    const lines = [
      `omp-bot ${app.getVersion()} (${app.isPackaged ? "packaged" : "dev"})`,
      `Electron ${process.versions.electron} / Chrome ${process.versions.chrome}`,
      `Node ${process.versions.node} (要求 >= ${MIN_NODE_MAJOR})`,
      `平台 ${process.platform} ${process.arch}`,
      `OMP: ${omp ? `${omp.bin} (${omp.version}, ${omp.source})` : "未探测"}`,
      `内置 OMP 记录: ${bundledProvenance() ?? "(开发模式)"}`,
      `数据目录: ${backend?.orch?.home ?? "(未启动)"}`,
      `数据锁: ${backend?.orch?.store?.readonly ? "只读（另一进程持有）" : "本进程持有"}`,
      `界面地址: ${backend ? new URL(backend.url).origin : "(未启动)"}`,
    ];
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const probe = new DatabaseSync(":memory:");
      probe.exec("select 1");
      probe.close();
      lines.push("node:sqlite: 可用");
    } catch (error) {
      lines.push(`node:sqlite: 不可用 (${error.message})`);
    }
    try {
      const { stdout } = await runNative(["config", "list"]);
      lines.push("omp config: 可读");
      if (!app.isPackaged) lines.push(String(stdout).trim().slice(0, 400));
    } catch (error) {
      lines.push(`omp config: 读取失败 (${error.message})`);
    }
    dialog.showMessageBox(window, {
      type: "info",
      title: "诊断信息",
      message: "本机运行环境",
      detail: lines.join("\n"),
      noLink: true,
    });
  }

  /** 在真实终端里跑原生交互命令（登录、帮助），凭据由 OMP 自己管理，本应用不接触、不打印。 */
  function openTerminal(args, title) {
    if (!omp) return dialog.showErrorBox(title, "还没有找到可用的 OMP");
    const command = [JSON.stringify(omp.bin), ...args].join(" ");
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", title, "cmd", "/k", command], { detached: true, stdio: "ignore" }).unref();
      return undefined;
    }
    if (process.platform === "darwin") {
      spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], { detached: true, stdio: "ignore" }).unref();
      return undefined;
    }
    return dialog.showMessageBox(window, {
      type: "info",
      title,
      message: `请在终端里运行：${command}`,
      detail: "本应用不会代填或保存任何密钥。",
    });
  }

  function nativeMenuItems() {
    return [
      { label: "检查版本", click: () => void showVersion() },
      { label: "诊断信息", click: () => void showDiagnostics() },
      { label: "原生帮助 (omp --help)", click: () => openTerminal(["--help"], "omp 帮助") },
      { label: "模型登录 (omp login)", click: () => openTerminal(["login"], "omp 登录") },
    ];
  }

  function buildAppMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "文件", submenu: [{ label: "退出", accelerator: "CmdOrCtrl+Q", click: () => app.quit() }] },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { label: "显示主窗口", click: () => showWindow() },
          { label: "隐藏到托盘", click: () => window?.hide() },
          { type: "separator" },
          { label: "打开数据目录", click: openDataDir },
        ],
      },
      { label: "帮助", submenu: nativeMenuItems() },
    ]));
  }

  app.on("window-all-closed", () => {
    // 有托盘时窗口关闭只是隐藏；没有托盘就没有恢复入口，维持原来的退出行为。
    if (!tray) app.quit();
  });
  app.on("activate", () => showWindow());

  const startup = app.whenReady().then(async () => {
    if (phase !== "starting") return;
    await checkRuntime();
    omp = await findOmp();
    if (phase !== "starting") return;
    backend = await startServer({
      port: 0,
      host: "127.0.0.1",
      home: process.env.OMPBOT_HOME || undefined,
      bin: omp.bin,
    });
    if (backend.orch.store.readonly) {
      throw new Error(
        `数据目录正由另一个 omp-bot 进程使用。\n\n${backend.orch.home}\n\n` +
          "请先关闭使用该目录的 CLI 或 serve 服务，再打开桌面应用。此窗口不会修改被锁定的数据。",
      );
    }
    if (phase !== "starting") return;

    watchEvents(backend.orch);

    window = new BrowserWindow({
      title: "omp-bot",
      width: 1280,
      height: 860,
      show: false,
      icon: appIconFile(),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: !app.isPackaged,
      },
    });

    // 任务栏按钮（含固定与分组）认的是窗口的 App User Model 身份，不是窗口图标：外壳读不到 app.asar 内的文件，
    // 所以打包后用 EXE 里已烘焙的多尺寸图标，开发时用磁盘上的 ico。
    if (process.platform === "win32") {
      const portable = process.env.PORTABLE_EXECUTABLE_FILE;
      // 便携版解包在临时目录，重启必须回到外壳 exe；开发版要带上项目目录，否则重启只会开出空的 Electron。
      const relaunchCommand = portable
        ? `"${portable}"`
        : app.isPackaged
          ? `"${process.execPath}"`
          : `"${process.execPath}" "${app.getAppPath()}"`;
      window.setAppDetails({
        appId: APP_USER_MODEL_ID,
        appIconPath: app.isPackaged ? portable || process.execPath : appIconFile(),
        appIconIndex: 0,
        relaunchCommand,
        relaunchDisplayName: "omp-bot",
      });
    }

    const origin = new URL(backend.url).origin;
    function localUrl(target) {
      try {
        const url = new URL(target);
        return url.protocol === "http:" && url.origin === origin;
      } catch {
        return false;
      }
    }
    function openExternal(target) {
      let url;
      try { url = new URL(target); } catch { return; }
      if (!["http:", "https:"].includes(url.protocol) || localUrl(target)) return;
      void shell.openExternal(url.href).catch((error) => {
        dialog.showErrorBox("无法打开浏览器", error.message);
      });
    }
    function guardNavigation(event) {
      if (localUrl(event.url)) return;
      event.preventDefault();
      if (event.isMainFrame) openExternal(event.url);
    }
    window.webContents.on("will-frame-navigate", guardNavigation);
    window.webContents.on("will-redirect", guardNavigation);
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === "clipboard-sanitized-write" && localUrl(contents.getURL()));
    });
    window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      return permission === "clipboard-sanitized-write" && contents?.id === window.webContents.id && requestingOrigin === origin;
    });
    window.on("page-title-updated", (event) => event.preventDefault());
    window.on("close", (event) => {
      // 关窗不结束后台任务；只有显式退出才真正停止。
      if (phase === "stopping" || phase === "stopped" || !tray) return;
      event.preventDefault();
      window.hide();
    });
    window.once("ready-to-show", () => {
      if (phase === "starting" || phase === "running") {
        window.show();
        window.focus();
      }
    });

    // 托盘：关窗后仍能回到窗口或显式退出。
    const iconFile = appIconFile();
    const icon = existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
    if (!icon.isEmpty()) {
      tray = new Tray(icon);
      tray.on("click", () => (window.isVisible() ? window.hide() : showWindow()));
      refreshTray();
    }
    buildAppMenu();

    await window.loadURL(backend.launchUrl ?? backend.url);
    if (phase === "starting") phase = "running";
    refreshTray();
  });

  void startup.catch((error) => {
    if (phase !== "stopping") dialog.showErrorBox("omp-bot 启动失败", error.message ?? String(error));
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (phase === "stopped") return;
    event.preventDefault();
    if (phase === "stopping") return;
    phase = "stopping";
    void (async () => {
      try {
        await startup.catch(() => {});
        if (!backend) return;
        const orch = backend.orch;
        if (orch.store.readonly) {
          // 只读进程不能替持锁进程刷盘；只关服务，不碰别人的锁。
          await new Promise((resolve, reject) => {
            backend.server.close((error) => (error ? reject(error) : resolve()));
            backend.server.closeAllConnections();
          });
          return;
        }
        if (typeof orch.listRuns === "function" && typeof orch.cancelRun === "function") {
          const live = orch.listRuns({ limit: RUN_LIST_LIMIT }).filter((run) => !TERMINAL_RUN_STATES.has(run.state));
          await Promise.allSettled(live.map((run) => orch.cancelRun(run.id, "desktop-quit")));
        }
        const closing = backend.close();
        backend.server.closeAllConnections();
        await closing;
      } catch (error) {
        dialog.showErrorBox("omp-bot 关闭失败", error.message ?? String(error));
      } finally {
        if (backend && !backend.orch.store.readonly) backend.orch.store.releaseLock?.();
        phase = "stopped";
        app.quit();
      }
    })();
  });
}
