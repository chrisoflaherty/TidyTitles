import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, runIn, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(async () => {
  sb = await createSandbox();
});
afterEach(async () => {
  await sb.cleanup();
});

const configFile = () => path.join(sb.configDir, "config.toml");
const config = (args: string[]) => runIn(["config", ...args, "--config-dir", sb.configDir]);

describe("config presets", () => {
  it("lists every preset and marks the defaults as in effect", async () => {
    const r = await config(["presets"]);
    expect(r.code).toBe(0);
    for (const id of ["default", "plex", "jellyfin", "kodi"]) expect(r.stdout).toContain(id);
    expect(r.stdout).toContain("TidyTitles (in effect)");
    expect(r.stdout).toContain("In effect: TidyTitles");
  });

  it("--json lists templates and the preset in effect", async () => {
    const r = await config(["presets", "--json"]);
    const out = JSON.parse(r.stdout);
    expect(out.current).toBe("default");
    expect(out.presets.map((p: { id: string }) => p.id)).toEqual(["default", "plex", "jellyfin", "kodi"]);
    expect(out.presets[1].templates.tv).toContain("Season {season2}");
  });
});

describe("config preset", () => {
  it("writes the preset's three templates and shows it as in effect", async () => {
    const r = await config(["preset", "Jellyfin"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Applied the Jellyfin preset.");
    const toml = await readFile(configFile(), "utf8");
    expect(toml).toContain('movie = "{title} ({year})< [tmdbid-{tmdb_id}]>/');
    expect(toml).toContain("Season {season2}");

    const show = await config(["show"]);
    expect(show.stdout).toContain("  Preset: Jellyfin");
    expect(JSON.parse((await config(["show", "--json"])).stdout).templatePreset).toBe("jellyfin");

    await config(["set-template", "movie", "{title}"]);
    expect((await config(["show"])).stdout).toContain("  Preset: Custom");
    expect((await config(["presets"])).stdout).toContain("In effect: Custom");
  });

  it("rejects an unknown preset without writing anything", async () => {
    const r = await config(["preset", "emby"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown preset: emby");
    expect(r.stderr).toContain("default, plex, jellyfin, kodi");
    await expect(readFile(configFile(), "utf8")).rejects.toThrow();
  });
});
