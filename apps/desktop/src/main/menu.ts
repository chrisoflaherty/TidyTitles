/**
 * The application menu: standard roles plus the app's commands. Commands
 * that need the window's UI (dialogs, confirmations) are forwarded to the
 * renderer as `MenuCommand`s; the renderer runs the same handlers as its
 * toolbar buttons.
 */

import type { Menu, MenuItemConstructorOptions } from "electron";
import type { AppState, MenuCommand } from "../shared/ipc";

export const REPO_URL = "https://github.com/chrisoflaherty/TidyTitles";

export interface MenuContext {
  platform: NodeJS.Platform;
  appName: string;
  isDev: boolean;
  /** Undefined when the command-line tool can be installed. */
  cliUnavailableReason?: string;
  send: (command: MenuCommand) => void;
  installCli: () => void;
  openExternal: (url: string) => void;
}

/** Menu item ids whose enabled state follows the app state. */
export const COMMAND_IDS = [
  "addFiles",
  "addFolder",
  "clear",
  "fetch",
  "cancelFetch",
  "rename",
  "undo",
  "settings",
] as const satisfies readonly MenuCommand[];

export function buildMenuTemplate(ctx: MenuContext): MenuItemConstructorOptions[] {
  const mac = ctx.platform === "darwin";
  const cmd = (id: MenuCommand, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    id,
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => ctx.send(id),
  });

  const settingsItem = cmd("settings", mac ? "Settings…" : "Settings…", "CmdOrCtrl+,");
  const cliItem: MenuItemConstructorOptions = {
    id: "installCli",
    label: "Install Command Line Tool…",
    enabled: ctx.cliUnavailableReason === undefined,
    ...(ctx.cliUnavailableReason
      ? { sublabel: "Not included in this build", toolTip: ctx.cliUnavailableReason }
      : {}),
    click: () => ctx.installCli(),
  };

  // Opens the update dialog in the window, which starts the check.
  const updatesItem = cmd("checkForUpdates", "Check for Updates…");

  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({
      label: ctx.appName,
      submenu: [
        { role: "about" },
        updatesItem,
        { type: "separator" },
        settingsItem,
        cliItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push({
    label: "File",
    submenu: [
      cmd("addFiles", "Add Files…", "CmdOrCtrl+O"),
      cmd("addFolder", "Add Folder…", "CmdOrCtrl+Shift+O"),
      { type: "separator" },
      cmd("clear", "Clear List", "CmdOrCtrl+Shift+Backspace"),
      { type: "separator" },
      ...(mac
        ? ([{ role: "close" }] as MenuItemConstructorOptions[])
        : ([
            settingsItem,
            cliItem,
            { type: "separator" },
            { role: "quit", accelerator: "Ctrl+Q" },
          ] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  });

  template.push({
    label: "Rename",
    submenu: [
      cmd("fetch", "Fetch Metadata", "CmdOrCtrl+R"),
      cmd("cancelFetch", "Stop Fetching", "CmdOrCtrl+."),
      { type: "separator" },
      cmd("rename", "Rename Files…", "CmdOrCtrl+Enter"),
      cmd("undo", "Undo Last Rename…", "CmdOrCtrl+Alt+Z"),
    ],
  });

  template.push({
    label: "View",
    submenu: [
      ...(ctx.isDev
        ? ([
            { role: "reload", accelerator: "CmdOrCtrl+Shift+R" },
            { role: "toggleDevTools" },
            { type: "separator" },
          ] as MenuItemConstructorOptions[])
        : []),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  template.push({
    role: "windowMenu",
  });

  template.push({
    role: "help",
    submenu: [
      { label: `${ctx.appName} on GitHub`, click: () => ctx.openExternal(REPO_URL) },
      { label: "Template Reference", click: () => ctx.openExternal(`${REPO_URL}/blob/main/wiki/Templates.md`) },
      { label: "Report an Issue", click: () => ctx.openExternal(`${REPO_URL}/issues`) },
      ...(mac ? [] : ([{ type: "separator" }, updatesItem, { role: "about" }] as MenuItemConstructorOptions[])),
    ],
  });

  return template;
}

/** Which commands are available in a state. */
export function commandEnabled(state: AppState): Record<(typeof COMMAND_IDS)[number], boolean> {
  const idle = state.busy === null;
  const pending = state.operations?.some((op) => op.status === "pending") ?? false;
  return {
    addFiles: idle,
    addFolder: idle,
    clear: idle && state.files.length > 0,
    fetch: idle && state.files.length > 0,
    cancelFetch: state.busy === "fetching",
    rename: idle && state.plan === "planned" && pending,
    undo: idle && state.lastRename !== null,
    settings: idle,
  };
}

/** Update menu items' enabled state. */
export function applyMenuState(menu: Menu | null, state: AppState): void {
  if (!menu) return;
  for (const [id, enabled] of Object.entries(commandEnabled(state))) {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = enabled;
  }
}
