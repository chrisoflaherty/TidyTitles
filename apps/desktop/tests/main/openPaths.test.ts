import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_OPENED_PATHS,
  OpenedPathsQueue,
  existingPaths,
  openedPathsFromData,
  pathsFromArgv,
} from "../../src/main/openPaths";

const root = path.resolve("/work");
const packaged = { defaultApp: false, appPath: "/Applications/TidyTitles.app/Contents/Resources/app.asar", cwd: root };

describe("pathsFromArgv", () => {
  it("takes the arguments after the executable of a packaged app", () => {
    expect(pathsFromArgv(["C:\\TidyTitles\\TidyTitles.exe"], packaged)).toEqual([]);
    expect(pathsFromArgv(["/opt/TidyTitles/TidyTitles", "/media/a.mkv", "/media/Shows"], packaged)).toEqual([
      path.resolve("/media/a.mkv"),
      path.resolve("/media/Shows"),
    ]);
  });

  it("ignores Chromium, Electron, Node, and macOS switches", () => {
    const argv = [
      "/opt/TidyTitles/TidyTitles",
      "--user-data-dir=/tmp/profile",
      "--no-sandbox",
      "--inspect=0",
      "-psn_0_12345",
      "/media/a.mkv",
      "--allow-file-access-from-files",
    ];
    expect(pathsFromArgv(argv, packaged)).toEqual([path.resolve("/media/a.mkv")]);
  });

  it("resolves relative paths against the working directory", () => {
    expect(pathsFromArgv(["TidyTitles", "a.mkv", "../b.mp3"], packaged)).toEqual([
      path.join(root, "a.mkv"),
      path.resolve(root, "..", "b.mp3"),
    ]);
  });

  it("skips empty and malformed arguments", () => {
    expect(pathsFromArgv(["TidyTitles", "", "a\0b", "x".repeat(5_000)], packaged)).toEqual([]);
  });

  it("skips Electron's arguments and the app's own path in development (`electron .`)", () => {
    const ctx = { defaultApp: true, appPath: "/src/apps/desktop", cwd: "/src/apps/desktop" };
    expect(pathsFromArgv(["/x/Electron", ".", "--no-sandbox", "/media/a.mkv"], ctx)).toEqual([path.resolve("/media/a.mkv")]);
    expect(pathsFromArgv(["/x/Electron", "."], ctx)).toEqual([]);
  });

  it("skips Playwright's loader and switches before the e2e entry", () => {
    const appDir = "/src/apps/desktop";
    const ctx = { defaultApp: true, appPath: path.join(appDir, "out-e2e", "main"), cwd: appDir };
    const argv = [
      "/x/Electron",
      "-r",
      "/x/playwright-core/lib/server/electron/loader.js",
      "--inspect=0",
      "--remote-debugging-port=0",
      path.join(appDir, "out-e2e", "main", "index.js"),
      "/media/a.mkv",
    ];
    expect(pathsFromArgv(argv, ctx)).toEqual([path.resolve("/media/a.mkv")]);
    // A relative entry works too.
    expect(pathsFromArgv(["/x/Electron", "out-e2e/main/index.js", "Shows"], ctx)).toEqual([path.join(appDir, "Shows")]);
  });

  it("takes nothing when a development command line has no recognizable app path", () => {
    const ctx = { defaultApp: true, appPath: "/src/apps/desktop", cwd: "/" };
    expect(pathsFromArgv(["/x/Electron", "/media/a.mkv"], ctx)).toEqual([]);
  });
});

describe("existingPaths", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-open-"));
    await writeFile(path.join(dir, "a.mkv"), "");
    await mkdir(path.join(dir, "Shows"));
    await symlink(path.join(dir, "a.mkv"), path.join(dir, "link.mkv"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps existing files and folders", async () => {
    const file = path.join(dir, "a.mkv");
    const folder = path.join(dir, "Shows");
    await expect(existingPaths([file, folder, path.join(dir, "link.mkv")])).resolves.toEqual([
      file,
      folder,
      path.join(dir, "link.mkv"),
    ]);
  });

  it("drops missing, relative, non-string, and malformed paths", async () => {
    await expect(
      existingPaths([path.join(dir, "missing.mkv"), "a.mkv", 42, null, {}, `${dir}/a\0.mkv`, "", "/".repeat(5_000)]),
    ).resolves.toEqual([]);
  });

  it("removes duplicates, also when spelled differently", async () => {
    const file = path.join(dir, "a.mkv");
    await expect(existingPaths([file, `${dir}${path.sep}.${path.sep}a.mkv`, file])).resolves.toEqual([file]);
  });

  it("looks at no more than the limit", async () => {
    const many = Array.from({ length: MAX_OPENED_PATHS + 5 }, () => path.join(dir, "a.mkv"));
    await expect(existingPaths(many)).resolves.toHaveLength(1);
  });
});

describe("openedPathsFromData", () => {
  it("reads a second instance's paths and ignores anything else", () => {
    expect(openedPathsFromData({ openedPaths: ["/a.mkv"] })).toEqual(["/a.mkv"]);
    expect(openedPathsFromData(undefined)).toEqual([]);
    expect(openedPathsFromData("x")).toEqual([]);
    expect(openedPathsFromData({ openedPaths: "/a.mkv" })).toEqual([]);
  });
});

describe("OpenedPathsQueue", () => {
  it("collects bursts without duplicates and empties on take", () => {
    const queue = new OpenedPathsQueue();
    queue.add(["/a.mkv"]);
    queue.add(["/b.mkv", "/a.mkv"]);
    expect(queue.size).toBe(2);
    expect(queue.take()).toEqual(["/a.mkv", "/b.mkv"]);
    expect(queue.size).toBe(0);
    expect(queue.take()).toEqual([]);
  });
});
