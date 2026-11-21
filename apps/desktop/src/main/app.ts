/**
 * Electron wiring: the window, security policy, menu, IPC, and the
 * command-line tool installer. The workflow itself lives in `controller.ts`.
 *
 * Production starts here from `index.ts`. The e2e test build starts here from
 * `src/e2e/main.ts`, passing fake providers through `sessionOverrides`; that
 * entry is compiled only into the separate `out-e2e` build.
 */

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import { MUSIC_EXTENSIONS, VIDEO_EXTENSIONS } from "@tidytitles/core";
import {
  EVENTS,
  IPC,
  type AppState,
  type EventPayloads,
  type MenuCommand,
  type UpdateCapability,
  type UpdateState,
} from "../shared/ipc";
import {
  LAUNCHER_NAME,
  chooseBinDir,
  defaultCliEnvironment,
  inspectExisting,
  installLauncher,
  loginShellPath,
  pathContains,
  resolveCliAvailability,
  windowsCommand,
} from "./cliInstall";
import { createConfigService } from "./configDir";
import {
  OpenedPathsQueue,
  existingPaths,
  openedPathsFromData,
  pathsFromArgv,
  type SecondInstanceData,
} from "./openPaths";
import { TaskFeedback, electronProgressArgs, type FeedbackNotification, type FeedbackSink } from "./taskFeedback";
import { AppController, type SessionOverrides } from "./controller";
import { REPO_URL, applyMenuState, buildMenuTemplate } from "./menu";
import { PREFERENCES_FILE, loadPreferences, savePreferences } from "./preferences";
import { UpdateController, resolveUpdateCapability, type UpdateEngine } from "./updater";
import {
  GITHUB_FEED,
  createElectronUpdateEngine,
  hasUpdateConfig,
  macBundlePath,
  readMacLocation,
  readMacSignature,
  testFeedFromBuild,
} from "./updaterEngine";
import {
  isSafeExternalUrl,
  parseAccept,
  parseDialogKind,
  parseEditableSettings,
  parseEnabled,
  parseFileIds,
  parsePaths,
  parseRunOptions,
  parseSelectionAnswer,
  parseTemplates,
} from "./validate";
import { parseFileId, parseMatchChoice, parseMatchQuery, parseNewName } from "./validate";
import { MIN_SIZE, fitToDisplays, loadWindowState, saveWindowState } from "./windowState";

export interface StartOptions {
  /** Test builds only: replace providers / HTTP for every session. */
  sessionOverrides?: SessionOverrides;
  /**
   * Test builds only. "off": no updater (the e2e build's default). An object:
   * a scripted engine in place of electron-updater.
   */
  updates?: "off" | { engine: UpdateEngine; capability: UpdateCapability; currentVersion: string };
  /**
   * Test builds only: replace the system notification, the Dock bounce or
   * taskbar flash, and the focus check (the e2e build records them instead).
   */
  feedback?: Partial<Pick<FeedbackSink, "notify" | "requestAttention" | "isFocused">>;
}

/**
 * Feed URL of the local end-to-end update test, set at build time only by
 * `electron-vite build --mode update-test`. Null in every other build, so a
 * shipped app cannot be pointed at another feed.
 */
declare const __TIDYTITLES_UPDATE_TEST_FEED__: string | null;
/** update-test builds only: scratch folder for config and userData (null otherwise). */
declare const __TIDYTITLES_UPDATE_TEST_DIR__: string | null;

const APP_NAME = "TidyTitles";
/** electron-builder's `appId`; the Windows installer gives its shortcuts this AppUserModelID. */
const APP_ID = "com.filerenamer.tidytitles";

export function startApp(options: StartOptions = {}): void {
  app.setName(APP_NAME);
  // Windows attributes notifications to the shortcut with the same
  // AppUserModelID. A development Electron has no such shortcut.
  if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

  if (__TIDYTITLES_UPDATE_TEST_DIR__) {
    // Local update test: stay out of the real config and userData, also after
    // the system updater relaunches the app without the test's environment.
    process.env.TIDYTITLES_CONFIG_DIR ||= path.join(__TIDYTITLES_UPDATE_TEST_DIR__, "config");
    app.setPath("userData", path.join(__TIDYTITLES_UPDATE_TEST_DIR__, "user-data"));
  }

  // macOS sends files dropped on the Dock icon or opened with Finder's "Open
  // With" as `open-file` events, the first ones before the app is ready.
  // They wait here until the main part below takes over.
  const earlyOpened: string[] = [];
  let receiveOpened = (candidates: readonly unknown[]) => {
    for (const c of candidates) if (typeof c === "string") earlyOpened.push(c);
  };
  app.on("open-file", (event, file) => {
    event.preventDefault();
    receiveOpened([file]);
  });

  if (process.platform === "darwin") {
    // A second instance (`open -n`) receives its files through `open-file`,
    // not its command line, and before it is ready. Ask for the lock only
    // then, so the files can be handed to the running instance.
    void app.whenReady().then(() => {
      const data: SecondInstanceData = { openedPaths: earlyOpened };
      if (!app.requestSingleInstanceLock(data)) {
        app.quit();
        return;
      }
      runApp();
    });
  } else {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    runApp();
  }

  function runApp(): void {
    startMain(options, earlyOpened, (receive) => {
      receiveOpened = receive;
    });
  }
}

function startMain(
  options: StartOptions,
  earlyOpened: readonly string[],
  setReceiver: (receive: (candidates: readonly unknown[]) => void) => void,
): void {
  const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
  const mac = process.platform === "darwin";
  const rendererIndex = path.join(import.meta.dirname, "../renderer/index.html");
  const preloadPath = path.join(import.meta.dirname, "../preload/index.cjs");
  const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");
  const preferencesFile = () => path.join(app.getPath("userData"), PREFERENCES_FILE);

  let mainWindow: BrowserWindow | null = null;
  let lastState: AppState | null = null;
  let updates: UpdateController | null = null;

  const send = <K extends keyof EventPayloads>(channel: K, payload: EventPayloads[K]) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // -------------------------------------------------------------------------
  // Feedback outside the window: icon progress, notifications, attention
  // -------------------------------------------------------------------------

  const liveWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

  /** Show, restore, and focus the window (creating it if it was closed). */
  const bringForward = () => {
    const win = liveWindow();
    if (!win) {
      void ensureWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  // Notifications are kept referenced so their click handlers survive garbage collection.
  const liveNotifications: Notification[] = [];
  const showNotification = ({ title, body }: FeedbackNotification) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    const forget = () => {
      const i = liveNotifications.indexOf(notification);
      if (i >= 0) liveNotifications.splice(i, 1);
    };
    notification.on("click", () => {
      forget();
      if (mac) app.focus({ steal: true });
      bringForward();
    });
    notification.on("close", forget);
    liveNotifications.push(notification);
    if (liveNotifications.length > 5) liveNotifications.shift();
    notification.show();
  };

  const requestAttention = () => {
    if (mac) {
      // One bounce, not a bounce until the app is activated.
      app.dock?.bounce("informational");
      return;
    }
    const win = liveWindow();
    if (!win) return;
    win.flashFrame(true);
    win.once("focus", () => {
      if (!win.isDestroyed()) win.flashFrame(false);
    });
  };

  const feedback = new TaskFeedback({
    setProgress: (progress) => {
      const win = liveWindow();
      if (!win) return;
      const { value, mode } = electronProgressArgs(progress, process.platform);
      win.setProgressBar(value, mode ? { mode } : undefined);
    },
    isFocused: options.feedback?.isFocused ?? (() => liveWindow()?.isFocused() ?? false),
    notify: options.feedback?.notify ?? showNotification,
    requestAttention: options.feedback?.requestAttention ?? requestAttention,
  });

  const controller = new AppController({
    config: createConfigService(),
    emit: (channel, payload) => {
      if (channel === EVENTS.state) {
        lastState = payload as AppState;
        applyMenuState(Menu.getApplicationMenu(), lastState);
        feedback.onState(lastState);
        // Items that arrived while other items were being added.
        if (lastState.busy === null && opened.size > 0) announceOpened();
      } else if (channel === EVENTS.progress) {
        feedback.onProgress(payload as EventPayloads[typeof EVENTS.progress]);
      } else if (channel === EVENTS.selectionRequest) {
        feedback.onSelectionRequest((payload as EventPayloads[typeof EVENTS.selectionRequest]).id);
      }
      send(channel, payload);
    },
    sessionOverrides: options.sessionOverrides,
  });

  // -------------------------------------------------------------------------
  // Security policy for every web contents
  // -------------------------------------------------------------------------

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  });

  /** Only our own renderer page may call the IPC API. */
  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    if (!frame || !mainWindow || event.sender !== mainWindow.webContents) return false;
    try {
      const url = new URL(frame.url);
      if (isDev && process.env.ELECTRON_RENDERER_URL) {
        return url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
      }
      return url.protocol === "file:" && url.pathname === pathToFileURL(rendererIndex).pathname;
    } catch {
      return false;
    }
  };

  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted IPC sender");
      return fn(...args);
    });
  };

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  const mediaExtensions = (set: ReadonlySet<string>) => [...set].map((e) => e.slice(1)).sort();

  const showAddDialog = async (kind: "files" | "folder") => {
    if (controller.isBusy) return null;
    const dialogOptions: OpenDialogOptions =
      kind === "folder"
        ? { title: "Add Folder", buttonLabel: "Add", properties: ["openDirectory", "multiSelections"] }
        : {
            title: "Add Files",
            buttonLabel: "Add",
            properties: ["openFile", "multiSelections"],
            filters: [
              {
                name: "Media Files",
                extensions: [...mediaExtensions(VIDEO_EXTENSIONS), ...mediaExtensions(MUSIC_EXTENSIONS)],
              },
              { name: "Video Files", extensions: mediaExtensions(VIDEO_EXTENSIONS) },
              { name: "Audio Files", extensions: mediaExtensions(MUSIC_EXTENSIONS) },
              { name: "All Files", extensions: ["*"] },
            ],
          };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    // Files picked in the dialog are taken as chosen; folders are filtered.
    return controller.addPaths(result.filePaths, { filterExplicitFiles: false });
  };

  handle(IPC.getState, () => controller.getState());
  handle(IPC.addFilesDialog, (kind) => showAddDialog(parseDialogKind(kind)));
  handle(IPC.addPaths, (paths) => controller.addPaths(parsePaths(paths), { filterExplicitFiles: true }));
  handle(IPC.takeOpenedPaths, (accept) => takeOpenedPaths(parseAccept(accept)));
  handle(IPC.removeFiles, (ids) => controller.removeFiles(parseFileIds(ids)));
  handle(IPC.clearFiles, () => controller.clearFiles());
  handle(IPC.setOptions, (opts) => controller.setOptions(parseRunOptions(opts)));
  handle(IPC.fetch, () => controller.fetch());
  handle(IPC.cancelFetch, () => controller.cancelFetch());
  handle(IPC.answerSelection, (id, index) => {
    const answer = parseSelectionAnswer(id, index);
    controller.answerSelection(answer.id, answer.index);
  });
  handle(IPC.rename, async () => {
    const outcome = await controller.rename();
    feedback.renameFinished(outcome);
    return outcome;
  });
  handle(IPC.undo, async () => {
    const outcome = await controller.undo();
    feedback.undoFinished(outcome);
    return outcome;
  });
  handle(IPC.getSettings, () => controller.getSettingsPayload());
  handle(IPC.previewTemplates, (templates) => controller.previewTemplates(parseTemplates(templates)));
  handle(IPC.saveSettings, (settings) => controller.saveSettings(parseEditableSettings(settings)));
  handle(IPC.getMatchContext, (fileId) => controller.getMatchContext(parseFileId(fileId)));
  handle(IPC.searchMatches, (fileId, query) => controller.searchMatches(parseFileId(fileId), parseMatchQuery(query)));
  handle(IPC.chooseMatch, (searchId, index, options) => {
    const choice = parseMatchChoice(searchId, index, options);
    return controller.chooseMatch(choice.searchId, choice.index, choice.options);
  });
  handle(IPC.clearMatch, (fileId) => controller.clearMatch(parseFileId(fileId)));
  handle(IPC.getEditableName, (fileId) => controller.getEditableName(parseFileId(fileId)));
  handle(IPC.setFileName, (fileId, name) => controller.setFileName(parseFileId(fileId), parseNewName(name)));
  handle(IPC.openExternal, async (url) => {
    if (!isSafeExternalUrl(url)) throw new Error("Only https links can be opened");
    await shell.openExternal(url);
  });

  // Updates. The renderer only asks; main decides (idle rule, no downgrade).
  const offUpdateState = (): UpdateState => ({
    status: { kind: "idle" },
    capability: { kind: "off", reason: "development" },
    currentVersion: app.getVersion(),
    autoCheck: false,
    manual: false,
    checkId: 0,
  });
  handle(IPC.getUpdateState, () => updates?.getState() ?? offUpdateState());
  // Returns at once; the outcome arrives as update-state events (a download can take minutes).
  handle(IPC.checkForUpdates, () => {
    void updates?.check({ manual: true });
  });
  handle(IPC.restartToUpdate, () => updates?.restartToUpdate() ?? "notReady");
  handle(IPC.openReleasePage, async () => {
    const url = updates?.releasePageUrl();
    if (url && isSafeExternalUrl(url)) await shell.openExternal(url);
  });
  handle(IPC.setAutoCheckForUpdates, (enabled) => updates?.setAutoCheck(parseEnabled(enabled)));

  // -------------------------------------------------------------------------
  // Files opened with the app (Dock, Finder's Open With, the command line)
  // -------------------------------------------------------------------------

  const opened = new OpenedPathsQueue();
  /** Set once the startup window has been created; before that it takes the queue itself. */
  let started = false;

  /**
   * Untrusted paths from `open-file`, a command line, or a second instance:
   * only existing absolute paths are queued. The renderer then takes them
   * (`takeOpenedPaths`) if it would accept a drop.
   */
  const receive = async (candidates: readonly unknown[]) => {
    const paths = await existingPaths(candidates);
    if (paths.length === 0) return;
    opened.add(paths);
    if (!started) return;
    bringForward();
    announceOpened();
  };

  // macOS sends one `open-file` per item when several are opened at once:
  // let a burst collect before the renderer takes it.
  let announceTimer: NodeJS.Timeout | null = null;
  const announceOpened = () => {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announceTimer = null;
      send(EVENTS.pathsOpened, null);
    }, 150);
  };

  /**
   * The same rules as a drop: refused, with a message, while a task runs or
   * a dialog is open. Only adding other items makes them wait instead.
   */
  const takeOpenedPaths = async (accept: boolean) => {
    if (opened.size === 0) return null;
    // Adding takes a moment; the items wait for it rather than being refused
    // (they are announced again when it finishes).
    if (controller.getState().busy === "adding") return null;
    const paths = opened.take();
    if (!accept || controller.isBusy) {
      await messageBox({
        type: "info",
        message: paths.length === 1 ? "The item wasn’t added" : "The items weren’t added",
        detail: "Wait for the current task to finish, then open them again.",
      });
      return null;
    }
    return controller.addPaths(paths, { filterExplicitFiles: true });
  };

  const argvContext = (cwd: string) => ({ defaultApp: Boolean(process.defaultApp), appPath: app.getAppPath(), cwd });

  setReceiver((candidates) => void receive(candidates));
  void receive([...earlyOpened, ...pathsFromArgv(process.argv, argvContext(process.cwd()))]);

  // -------------------------------------------------------------------------
  // Command-line tool
  // -------------------------------------------------------------------------

  const messageBox = (opts: MessageBoxOptions) =>
    mainWindow ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);

  const installCli = async () => {
    const availability = resolveCliAvailability(defaultCliEnvironment());
    if (!availability.available) {
      await messageBox({ type: "info", message: "The command-line tool is not available", detail: availability.reason });
      return;
    }
    const { locations } = availability;

    if (process.platform === "win32") {
      const command = windowsCommand(locations);
      const { response } = await messageBox({
        type: "info",
        message: "Use TidyTitles from PowerShell",
        detail:
          "Add this function to your PowerShell profile (open it with: notepad $PROFILE), " +
          `then open a new PowerShell window and run "tidytitles --help".\n\n${command}`,
        buttons: ["Copy Command", "Close"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) clipboard.writeText(command);
      return;
    }

    const binDir = await chooseBinDir(os.homedir());
    const target = path.join(binDir, LAUNCHER_NAME);
    if ((await inspectExisting(target)) === "other") {
      const { response } = await messageBox({
        type: "warning",
        message: `Replace the existing “${LAUNCHER_NAME}” in ${binDir}?`,
        detail: "A file with that name is already there and was not installed by TidyTitles.",
        buttons: ["Replace", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
    }

    try {
      await installLauncher(locations, binDir);
    } catch (error) {
      await messageBox({
        type: "error",
        message: "Could not install the command-line tool",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const onPath = pathContains(await loginShellPath(process.env), binDir);
    await messageBox({
      type: "info",
      message: `Installed “${LAUNCHER_NAME}” in ${binDir}`,
      detail: onPath
        ? `${binDir} is on your PATH. Open a new terminal window and run:\n\n${LAUNCHER_NAME} --help`
        : `${binDir} is not on your PATH yet. Add this line to your shell profile (for example ~/.zshrc or ~/.bashrc):\n\n` +
          `export PATH="${binDir}:$PATH"\n\nThen open a new terminal window and run: ${LAUNCHER_NAME} --help`,
    });
  };

  // -------------------------------------------------------------------------
  // Window
  // -------------------------------------------------------------------------

  const createWindow = async () => {
    const saved = await loadWindowState(windowStateFile());
    const bounds = fitToDisplays(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
    );

    const win = new BrowserWindow({
      ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      width: bounds.width,
      height: bounds.height,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: APP_NAME,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f1f22" : "#ffffff",
      ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });
    mainWindow = win;
    feedback.reapply();

    win.once("ready-to-show", () => {
      if (bounds.maximized) win.maximize();
      win.show();
    });

    win.on("close", (event) => {
      const busy = controller.getState().busy;
      if (busy === "renaming" || busy === "undoing") {
        event.preventDefault();
        void messageBox({
          type: "warning",
          message: "Files are being renamed",
          detail: "Wait for renaming to finish before closing the window.",
        });
        return;
      }
      if (busy === "fetching") controller.cancelFetch();
      // The Dock's progress belongs to the app, not the window: clear it now.
      win.setProgressBar(-1);
      const normal = win.getNormalBounds();
      try {
        saveWindowState(windowStateFile(), { ...normal, maximized: win.isMaximized() });
      } catch {
        // Losing the saved window position is harmless; never block closing on it.
      }
    });
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });

    try {
      if (isDev && process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
      else await win.loadFile(rendererIndex);
    } catch (error) {
      console.error("Could not load the window:", error);
    }
  };

  /** Create the window unless it exists or is being created. */
  let creatingWindow: Promise<void> | null = null;
  const ensureWindow = (): Promise<void> => {
    if (liveWindow()) return Promise.resolve();
    creatingWindow ??= createWindow().finally(() => {
      creatingWindow = null;
    });
    return creatingWindow;
  };

  const sendMenuCommand = (command: MenuCommand) => {
    if (!mainWindow) {
      void ensureWindow().then(() => send(EVENTS.menuCommand, command));
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    send(EVENTS.menuCommand, command);
  };

  const installMenu = () => {
    const cli = resolveCliAvailability(defaultCliEnvironment());
    const template = buildMenuTemplate({
      platform: process.platform,
      appName: APP_NAME,
      isDev,
      cliUnavailableReason: cli.available ? undefined : cli.reason,
      send: sendMenuCommand,
      installCli: () => void installCli(),
      openExternal: (url) => {
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    if (lastState) applyMenuState(Menu.getApplicationMenu(), lastState);
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  // A second launch: Windows and Linux pass its files on its command line,
  // macOS (`open -n`) in `additionalData` (see startApp).
  app.on("second-instance", (_event, argv, workingDirectory, additionalData) => {
    const cwd = typeof workingDirectory === "string" && path.isAbsolute(workingDirectory) ? workingDirectory : os.homedir();
    const fromArgv = Array.isArray(argv) ? pathsFromArgv(argv.filter((a): a is string => typeof a === "string"), argvContext(cwd)) : [];
    void receive([...fromArgv, ...openedPathsFromData(additionalData)]);
    if (!mainWindow) return void ensureWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    if (!mac) app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void ensureWindow();
  });

  void app.whenReady().then(async () => {
    nativeTheme.themeSource = "system";
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: "Copyright © 2024 Chris O’Flaherty. MIT License.",
      website: REPO_URL,
    });
    installMenu();
    await controller.init();
    updates = await createUpdates();
    await ensureWindow();
    started = true;
    // Anything that arrived while the window was loading.
    if (opened.size > 0) announceOpened();
    updates.start();
  });

  app.on("will-quit", () => updates?.dispose());

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  async function createUpdates(): Promise<UpdateController> {
    const preferences = await loadPreferences(preferencesFile());
    let capability: UpdateCapability;
    let engine: UpdateEngine | null = null;
    let currentVersion = app.getVersion();

    if (options.updates === "off") {
      capability = { kind: "off", reason: "test" };
    } else if (options.updates) {
      ({ engine, capability, currentVersion } = options.updates);
    } else {
      const bundle = mac ? macBundlePath(process.execPath) : "";
      capability = resolveUpdateCapability({
        platform: process.platform,
        isPackaged: app.isPackaged,
        env: process.env,
        hasUpdateConfig: hasUpdateConfig(process.resourcesPath),
        ...(mac && app.isPackaged
          ? { macSignature: await readMacSignature(bundle), macLocation: await readMacLocation(bundle) }
          : {}),
      });
      if (capability.kind !== "off") {
        try {
          engine = createElectronUpdateEngine({
            mode: capability.kind === "self" ? "self" : "check",
            feed: testFeedFromBuild(__TIDYTITLES_UPDATE_TEST_FEED__) ?? GITHUB_FEED,
          });
        } catch (error) {
          console.error("[updater] could not start:", error);
          capability = { kind: "off", reason: "disabled" };
        }
      }
    }
    console.log(`[updater] ${capability.kind}${"reason" in capability ? ` (${capability.reason})` : ""}, version ${currentVersion}`);

    return new UpdateController({
      engine,
      capability,
      currentVersion,
      autoCheck: preferences.autoCheckForUpdates,
      saveAutoCheck: (enabled) => savePreferences(preferencesFile(), { ...preferences, autoCheckForUpdates: enabled }),
      isIdle: () => controller.getState().busy === null,
      emit: (state) => send(EVENTS.updateState, state),
    });
  }
}
