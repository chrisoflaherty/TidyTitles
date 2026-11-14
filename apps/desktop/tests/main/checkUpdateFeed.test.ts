import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "scripts", "check-update-feed.mjs");

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const sha = (data: string) => createHash("sha512").update(data).digest("base64");

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A fake release folder: files with content, and a feed file describing them. */
async function release(
  files: Record<string, string>,
  feed: { name: string; version: string; urls: string[]; tamper?: string },
) {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-feed-"));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  const entries = feed.urls.map((url) => {
    const content = files[url] ?? "";
    return `  - url: ${url}\n    sha512: ${url === feed.tamper ? sha("other") : sha(content)}\n    size: ${Buffer.byteLength(content)}`;
  });
  const first = feed.urls[0]!;
  await writeFile(
    path.join(dir, feed.name),
    `version: ${feed.version}\nfiles:\n${entries.join("\n")}\npath: ${first}\nsha512: ${sha(files[first] ?? "")}\nreleaseDate: '2026-11-14T00:00:00.000Z'\n`,
  );
  // electron-builder writes this too; it must never be uploaded.
  await writeFile(path.join(dir, "builder-debug.yml"), "x: 1\n");
  return dir;
}

const V = "0.2.0-beta.3";
const mac = (arch: string) => ({
  [`TidyTitles-${V}-macos-${arch}.zip`]: `zip-${arch}`,
  [`TidyTitles-${V}-macos-${arch}.zip.blockmap`]: "bm",
  [`TidyTitles-${V}-macos-${arch}.dmg`]: `dmg-${arch}`,
  [`TidyTitles-${V}-macos-${arch}.dmg.blockmap`]: "bm",
});
const macUrls = (arch: string) => [`TidyTitles-${V}-macos-${arch}.zip`, `TidyTitles-${V}-macos-${arch}.dmg`];

describe("check-update-feed", () => {
  it("accepts a complete macOS beta feed and lists exactly the files to upload", async () => {
    const d = await release({ ...mac("arm64"), ...mac("x64") }, { name: "beta-mac.yml", version: V, urls: [...macUrls("arm64"), ...macUrls("x64")] });
    const result = await run(["--platform", "mac", "--dir", d, "--version", V, "--list"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const listed = result.stdout.trim().split("\n");
    expect(listed).toContain("beta-mac.yml");
    expect(listed).toContain(`TidyTitles-${V}-macos-x64.zip.blockmap`);
    expect(listed).not.toContain("builder-debug.yml");
    expect(listed).toHaveLength(9);
  });

  it("rejects a feed whose checksum does not match, or that misses an architecture", async () => {
    const d = await release(
      { ...mac("arm64"), ...mac("x64") },
      { name: "beta-mac.yml", version: V, urls: [...macUrls("arm64"), ...macUrls("x64")], tamper: `TidyTitles-${V}-macos-x64.zip` },
    );
    const bad = await run(["--platform", "mac", "--dir", d, "--version", V]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("sha512 does not match");
  });

  it("rejects a missing architecture", async () => {
    const d = await release(mac("arm64"), { name: "beta-mac.yml", version: V, urls: macUrls("arm64") });
    const bad = await run(["--platform", "mac", "--dir", d, "--version", V]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("no x64 zip");
  });

  it("wants latest.yml for a stable Windows version and beta.yml for a beta", async () => {
    const exe = "TidyTitles-0.3.0-windows-setup.exe";
    const d = await release({ [exe]: "exe", [`${exe}.blockmap`]: "bm" }, { name: "latest.yml", version: "0.3.0", urls: [exe] });
    expect((await run(["--platform", "win", "--dir", d, "--version", "0.3.0"])).code).toBe(0);
    const wrong = await run(["--platform", "win", "--dir", d, "--version", "0.3.0-beta.1"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("missing beta.yml");
  });

  it("checks the Linux feed name and refuses prerelease names beta testers are not offered", async () => {
    const image = `TidyTitles-0.2.0-rc.1-x86_64.AppImage`;
    const d = await release({ [image]: "img" }, { name: "rc-linux.yml", version: "0.2.0-rc.1", urls: [image] });
    const result = await run(["--platform", "linux", "--dir", d, "--version", "0.2.0-rc.1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('prerelease "rc"');
  });
});
