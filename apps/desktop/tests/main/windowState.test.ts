import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZE,
  MIN_SIZE,
  fitToDisplays,
  loadWindowState,
  parseWindowState,
  saveWindowState,
} from "../../src/main/windowState";

const screen = { x: 0, y: 0, width: 1440, height: 875 };
const second = { x: 1440, y: 0, width: 1920, height: 1055 };

describe("window state", () => {
  it("parses saved state and rejects garbage", () => {
    expect(parseWindowState({ x: 10.4, y: 20, width: 900, height: 600, maximized: true })).toEqual({
      x: 10,
      y: 20,
      width: 900,
      height: 600,
      maximized: true,
    });
    expect(parseWindowState({ width: "900", height: 600 })).toBeUndefined();
    expect(parseWindowState(null)).toBeUndefined();
    expect(parseWindowState({ width: 900, height: 600 })).toEqual({ width: 900, height: 600, maximized: false });
  });

  it("uses the default size, centered, when nothing is saved", () => {
    expect(fitToDisplays(undefined, [screen])).toEqual({ ...DEFAULT_SIZE, maximized: false });
  });

  it("keeps a position that is visible on some display", () => {
    expect(fitToDisplays({ x: 1600, y: 100, width: 1000, height: 700, maximized: false }, [screen, second])).toMatchObject({
      x: 1600,
      y: 100,
    });
  });

  it("drops a position on a display that is gone", () => {
    const fitted = fitToDisplays({ x: 2000, y: 100, width: 1000, height: 700, maximized: false }, [screen]);
    expect(fitted.x).toBeUndefined();
    expect(fitted.y).toBeUndefined();
  });

  it("clamps the size to the minimum and the largest display", () => {
    expect(fitToDisplays({ width: 300, height: 200, maximized: false }, [screen])).toMatchObject(MIN_SIZE);
    expect(fitToDisplays({ width: 5000, height: 4000, maximized: false }, [screen])).toMatchObject({ width: 1440, height: 875 });
  });

  it("round-trips through a file and tolerates a corrupt one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tt-window-"));
    try {
      const file = path.join(dir, "nested", "window-state.json");
      saveWindowState(file, { x: 5, y: 6, width: 800, height: 500, maximized: false });
      expect(await loadWindowState(file)).toEqual({ x: 5, y: 6, width: 800, height: 500, maximized: false });
      await writeFile(file, "{not json");
      expect(await loadWindowState(file)).toBeUndefined();
      expect(await loadWindowState(path.join(dir, "missing.json"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
