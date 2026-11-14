import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildMenuTemplate, commandEnabled } from "../../src/main/menu";
import type { AppState } from "../../src/shared/ipc";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

const ctx = (platform: NodeJS.Platform, cliUnavailableReason?: string) => ({
  platform,
  appName: "TidyTitles",
  isDev: false,
  cliUnavailableReason,
  send: vi.fn(),
  installCli: vi.fn(),
  openExternal: vi.fn(),
});

describe("application menu", () => {
  it("has the macOS app menu with standard roles and the app commands", () => {
    const c = ctx("darwin");
    const template = buildMenuTemplate(c);
    expect(template.map((m) => m.label ?? m.role)).toEqual(["TidyTitles", "File", "Edit", "Rename", "View", "windowMenu", "help"]);
    const items = flatten(template);
    const roles = items.map((i) => i.role).filter(Boolean);
    for (const role of ["about", "services", "hide", "hideOthers", "quit", "undo", "redo", "cut", "copy", "paste", "selectAll", "close", "togglefullscreen"]) {
      expect(roles).toContain(role);
    }
    const byId = Object.fromEntries(items.filter((i) => i.id).map((i) => [i.id, i]));
    expect(byId.addFiles!.accelerator).toBe("CmdOrCtrl+O");
    expect(byId.fetch!.accelerator).toBe("CmdOrCtrl+R");
    expect(byId.rename!.accelerator).toBe("CmdOrCtrl+Enter");
    expect(byId.settings!.accelerator).toBe("CmdOrCtrl+,");
    expect(byId.installCli!.enabled).toBe(true);
    // No reload shortcut in production; CmdOrCtrl+R belongs to Fetch.
    expect(roles).not.toContain("reload");
    (byId.fetch!.click as () => void)();
    expect(c.send).toHaveBeenCalledWith("fetch");
  });

  it("puts Settings and Quit in the File menu on Windows and Linux", () => {
    const template = buildMenuTemplate(ctx("win32"));
    expect(template[0]!.label).toBe("File");
    const file = flatten([template[0]!]);
    expect(file.some((i) => i.id === "settings")).toBe(true);
    expect(file.some((i) => i.role === "quit")).toBe(true);
    expect(flatten(template).some((i) => i.role === "about")).toBe(true);
  });

  it("puts Check for Updates under About on macOS and in Help elsewhere", () => {
    const c = ctx("darwin");
    const mac = buildMenuTemplate(c);
    const appMenu = mac[0]!.submenu as MenuItemConstructorOptions[];
    expect(appMenu[0]!.role).toBe("about");
    expect(appMenu[1]!.id).toBe("checkForUpdates");
    expect(appMenu[1]!.label).toBe("Check for Updates…");
    (appMenu[1]!.click as () => void)();
    expect(c.send).toHaveBeenCalledWith("checkForUpdates");
    expect(flatten(mac).filter((i) => i.id === "checkForUpdates")).toHaveLength(1);

    for (const platform of ["win32", "linux"] as const) {
      const template = buildMenuTemplate(ctx(platform));
      const help = template.find((m) => m.role === "help")!.submenu as MenuItemConstructorOptions[];
      expect(help.slice(-2).map((i) => i.id ?? i.role)).toEqual(["checkForUpdates", "about"]);
      expect(flatten(template).filter((i) => i.id === "checkForUpdates")).toHaveLength(1);
    }
  });

  it("disables Install Command Line Tool with an explanation when the CLI is not bundled", () => {
    const items = flatten(buildMenuTemplate(ctx("darwin", "not bundled")));
    const cli = items.find((i) => i.id === "installCli")!;
    expect(cli.enabled).toBe(false);
    expect(cli.toolTip).toBe("not bundled");
    expect(cli.sublabel).toBeTruthy();
  });

  it("enables commands from the state", () => {
    const base = {
      files: [{ id: 1 }],
      operations: null,
      plan: "none",
      busy: null,
      lastRename: null,
    } as unknown as AppState;
    expect(commandEnabled(base)).toMatchObject({ fetch: true, rename: false, undo: false, cancelFetch: false, clear: true });
    expect(commandEnabled({ ...base, busy: "fetching" })).toMatchObject({ fetch: false, cancelFetch: true, settings: false });
    expect(
      commandEnabled({ ...base, plan: "planned", operations: [{ status: "pending" }] } as unknown as AppState).rename,
    ).toBe(true);
    expect(commandEnabled({ ...base, lastRename: { timestamp: "", operations: 1, files: 1 } }).undo).toBe(true);
  });
});
