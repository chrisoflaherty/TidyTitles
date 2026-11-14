/**
 * The document types in electron-builder.yml (Dock drops, and Finder's "Open
 * With" for folders, on macOS) must list exactly the extensions the app
 * adds, and must never make TidyTitles the default app for any type on any
 * platform.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { MUSIC_EXTENSIONS, VIDEO_EXTENSIONS } from "@tidytitles/core";

interface DocumentType {
  CFBundleTypeName: string;
  CFBundleTypeRole: string;
  LSHandlerRank: string;
  CFBundleTypeExtensions?: string[];
  LSItemContentTypes?: string[];
}

const config = yaml.load(
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "electron-builder.yml"), "utf8"),
) as Record<string, unknown> & { mac: { extendInfo: { CFBundleDocumentTypes: DocumentType[] } } };
const types = config.mac.extendInfo.CFBundleDocumentTypes;
const byName = (name: string) => types.find((t) => t.CFBundleTypeName === name);
const bare = (set: ReadonlySet<string>) => [...set].map((e) => e.slice(1)).sort();

/** Every key path in the config, to find a `fileAssociations` anywhere. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...keyPaths(child, `${prefix}${key}.`)]);
}

describe("document types", () => {
  it("lists core's video and music extensions", () => {
    expect([...(byName("Video File")?.CFBundleTypeExtensions ?? [])].sort()).toEqual(bare(VIDEO_EXTENSIONS));
    expect([...(byName("Audio File")?.CFBundleTypeExtensions ?? [])].sort()).toEqual(bare(MUSIC_EXTENSIONS));
  });

  it("includes folders", () => {
    expect(byName("Folder")?.LSItemContentTypes).toEqual(["public.folder"]);
  });

  it("is never the default app: folders are an alternate (Finder owns them), files only accept drops", () => {
    expect(types).toHaveLength(3);
    // Alternate would make TidyTitles the default for a type no other app claims (.mkv on a stock Mac).
    expect(byName("Folder")?.LSHandlerRank).toBe("Alternate");
    expect(byName("Video File")?.LSHandlerRank).toBe("None");
    expect(byName("Audio File")?.LSHandlerRank).toBe("None");
    for (const type of types) expect(type.CFBundleTypeRole).toBe("Viewer");
  });

  it("declares no fileAssociations (the Windows installer would make them the default)", () => {
    expect(keyPaths(config).filter((k) => /fileAssociations/i.test(k))).toEqual([]);
  });
});
