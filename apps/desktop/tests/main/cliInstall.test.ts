import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHER_MARKER,
  chooseBinDir,
  inspectExisting,
  installLauncher,
  launcherScript,
  pathContains,
  resolveCliAvailability,
  shellQuote,
  windowsCommand,
} from "../../src/main/cliInstall";

const run = promisify(execFile);
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tt-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (over: Partial<Parameters<typeof resolveCliAvailability>[0]> = {}) => ({
  platform: "darwin" as NodeJS.Platform,
  execPath: "/Applications/TidyTitles.app/Contents/MacOS/TidyTitles",
  resourcesPath: path.join(dir, "Resources"),
  env: {},
  homedir: path.join(dir, "home"),
  ...over,
});

describe("command-line tool installer", () => {
  it("is unavailable when the bundle is not packaged", () => {
    const result = resolveCliAvailability(ctx());
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toMatch(/not bundled/);
  });

  it("uses the app executable and the bundled CLI", async () => {
    await mkdir(path.join(dir, "Resources", "cli"), { recursive: true });
    await writeFile(path.join(dir, "Resources", "cli", "tidytitles.mjs"), "");
    const result = resolveCliAvailability(ctx());
    expect(result).toEqual({
      available: true,
      locations: {
        executable: "/Applications/TidyTitles.app/Contents/MacOS/TidyTitles",
        bundle: path.join(dir, "Resources", "cli", "tidytitles.mjs"),
      },
    });
  });

  it("copies the bundle out of an AppImage mount", async () => {
    await mkdir(path.join(dir, "Resources", "cli"), { recursive: true });
    await writeFile(path.join(dir, "Resources", "cli", "tidytitles.mjs"), "");
    const result = resolveCliAvailability(ctx({ platform: "linux", env: { APPIMAGE: "/home/u/Apps/TidyTitles.AppImage" } }));
    expect(result.available && result.locations).toEqual({
      executable: "/home/u/Apps/TidyTitles.AppImage",
      bundle: path.join(dir, "home", ".local", "share", "TidyTitles", "cli", "tidytitles.mjs"),
      copyBundleFrom: path.join(dir, "Resources", "cli", "tidytitles.mjs"),
    });
  });

  it("quotes paths for the shell", () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });

  it("writes a launcher that runs the bundle with ELECTRON_RUN_AS_NODE and passes arguments", async () => {
    // A stand-in "Electron binary" that prints what it was given.
    const fakeExe = path.join(dir, "My App's", "TidyTitles");
    await mkdir(path.dirname(fakeExe), { recursive: true });
    await writeFile(fakeExe, '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "arg=$a"; done\n');
    await chmod(fakeExe, 0o755);
    const bundle = path.join(dir, "Res ources", "cli", "tidytitles.mjs");

    const bin = path.join(dir, "bin");
    const target = await installLauncher({ executable: fakeExe, bundle }, bin);
    expect(target).toBe(path.join(bin, "tidytitles"));
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    const script = await readFile(target, "utf8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(LAUNCHER_MARKER);
    expect(script).toBe(launcherScript({ executable: fakeExe, bundle }));

    const { stdout } = await run(target, ["rename", "--dry-run", "a b.mkv"]);
    expect(stdout.trim().split("\n")).toEqual(["node=1", `arg=${bundle}`, "arg=rename", "arg=--dry-run", "arg=a b.mkv"]);
  });

  it("copies the bundle when installing from an AppImage", async () => {
    const source = path.join(dir, "mount", "tidytitles.mjs");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "console.log('cli')");
    const bundle = path.join(dir, "share", "cli", "tidytitles.mjs");
    await installLauncher({ executable: "/x/TidyTitles.AppImage", bundle, copyBundleFrom: source }, path.join(dir, "bin"));
    expect(await readFile(bundle, "utf8")).toBe("console.log('cli')");
  });

  it("prefers a writable system bin directory, else ~/.local/bin", async () => {
    const system = path.join(dir, "usr-local-bin");
    expect(await chooseBinDir("/home/u", system)).toBe(path.join("/home/u", ".local", "bin"));
    await mkdir(system);
    expect(await chooseBinDir("/home/u", system)).toBe(system);
  });

  it("recognizes its own launchers", async () => {
    const target = path.join(dir, "tidytitles");
    expect(await inspectExisting(target)).toBe("none");
    await writeFile(target, "#!/bin/sh\necho other tool\n");
    expect(await inspectExisting(target)).toBe("other");
    await writeFile(target, launcherScript({ executable: "/a", bundle: "/b" }));
    expect(await inspectExisting(target)).toBe("ours");
  });

  it("checks PATH entries", () => {
    expect(pathContains("/usr/bin:/home/u/.local/bin/:/bin", "/home/u/.local/bin", ":")).toBe(true);
    expect(pathContains("/usr/bin:/bin", "/home/u/.local/bin", ":")).toBe(false);
    expect(pathContains("", "/usr/local/bin", ":")).toBe(false);
  });

  it("builds a PowerShell function for Windows", () => {
    const command = windowsCommand({ executable: "C:\\Program Files\\TidyTitles\\TidyTitles.exe", bundle: "C:\\Program Files\\TidyTitles\\resources\\cli\\tidytitles.mjs" });
    expect(command).toContain("function tidytitles");
    expect(command).toContain("$env:ELECTRON_RUN_AS_NODE = '1'");
    expect(command).toContain("& 'C:\\Program Files\\TidyTitles\\TidyTitles.exe' 'C:\\Program Files\\TidyTitles\\resources\\cli\\tidytitles.mjs' @args");
  });

  it("escapes every quote character PowerShell ends a single-quoted string on", () => {
    // PowerShell treats the typographic quotes U+2018..U+201B like "'".
    const command = windowsCommand({
      executable: "C:\\Users\\O\u2019Brien\\TidyTitles.exe",
      bundle: "C:\\Users\\it's\\cli.mjs",
    });
    expect(command).toContain("& 'C:\\Users\\O\u2019\u2019Brien\\TidyTitles.exe' 'C:\\Users\\it''s\\cli.mjs' @args");
  });
});
