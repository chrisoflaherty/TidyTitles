import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigService } from "@tidytitles/core";
import { AppController, type Emit } from "../../src/main/controller";
import { createFakeSessionOverrides } from "../../src/e2e/fakes";
import type { EventPayloads } from "../../src/shared/ipc";

export interface Harness {
  dir: string;
  media: string;
  config: ConfigService;
  controller: AppController;
  events: { channel: keyof EventPayloads; payload: unknown }[];
  /** Resolves with the next event on `channel`. */
  next<K extends keyof EventPayloads>(channel: K): Promise<EventPayloads[K]>;
  touch(rel: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createHarness(configToml?: string): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-desktop-"));
  const media = path.join(dir, "media");
  await mkdir(media, { recursive: true });
  const configDir = path.join(dir, "config");
  await mkdir(configDir, { recursive: true });
  if (configToml !== undefined) await writeFile(path.join(configDir, "config.toml"), configToml);
  const config = new ConfigService({ configDir, cacheDir: path.join(configDir, "cache"), env: {} });

  const events: Harness["events"] = [];
  const waiters: { channel: string; resolve: (p: unknown) => void }[] = [];
  const emit: Emit = (channel, payload) => {
    events.push({ channel, payload });
    const i = waiters.findIndex((w) => w.channel === channel);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(payload);
  };
  const controller = new AppController({
    config,
    emit,
    platform: "darwin",
    sessionOverrides: createFakeSessionOverrides(),
  });
  await controller.init();

  return {
    dir,
    media,
    config,
    controller,
    events,
    next: (channel) => new Promise((resolve) => waiters.push({ channel, resolve: resolve as (p: unknown) => void })),
    touch: async (rel) => {
      const file = path.join(media, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "");
      return file;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export const KEYS_TOML = '[api]\ntmdb_api_key = "k"\ntvdb_api_key = "k"\n';
