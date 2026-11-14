/** Test harness: run the CLI in-process against temp directories with fake providers. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createTrack,
  createTVShow,
  type Album,
  type Episode,
  type Movie,
  type MovieProvider,
  type MusicProvider,
  type Track,
  type TVProvider,
  type TVShow,
} from "@tidytitles/core";
import { runCli, type CliDeps } from "../src/program";
import type { Prompter, SelectChoice } from "../src/prompts";

// ---------------------------------------------------------------------------
// Fixtures and fake providers (after packages/core/tests/fakes.ts)
// ---------------------------------------------------------------------------

export const matrix: Movie = createMovie({
  id: 603,
  title: "The Matrix",
  originalTitle: "The Matrix",
  year: 1999,
  posterPath: "/matrix.jpg",
});
export const matrixReloaded: Movie = createMovie({
  id: 604,
  title: "The Matrix Reloaded",
  originalTitle: "The Matrix Reloaded",
  year: 2003,
});
export const breakingBad: TVShow = createTVShow({
  id: 1396,
  title: "Breaking Bad",
  originalTitle: "Breaking Bad",
  year: 2008,
});
export const pilot: Episode = createEpisode({ show: breakingBad, season: 1, episode: 1, title: "Pilot" });

const queen = createArtist({ id: "q-1", name: "Queen" });
const opera: Album = createAlbum({ id: "r-1", title: "A Night at the Opera", artist: queen, year: 1975 });
export const bohemian: Track = createTrack({
  id: "rec-1",
  title: "Bohemian Rhapsody",
  artist: queen,
  album: opera,
  trackNumber: 11,
});

type Result<T> = T | Error | (() => T | Promise<T>);

async function resolveResult<T>(value: Result<T>): Promise<T> {
  if (value instanceof Error) throw value;
  if (typeof value === "function") return (value as () => T | Promise<T>)();
  return value;
}

export class FakeMovieProvider implements MovieProvider {
  calls: Array<[string, number | undefined]> = [];
  constructor(private results: Record<string, Result<Movie[]>> = {}) {}
  async searchMovie(title: string, year?: number): Promise<Movie[]> {
    this.calls.push([title, year]);
    return resolveResult(this.results[title] ?? []);
  }
  async getMovie(): Promise<Movie | undefined> {
    return undefined;
  }
}

export class FakeTVProvider implements TVProvider {
  searchCalls: string[] = [];
  constructor(
    private shows: Record<string, Result<TVShow[]>> = {},
    private episodes: Record<number, Episode> = {},
  ) {}
  async searchShow(title: string): Promise<TVShow[]> {
    this.searchCalls.push(title);
    return resolveResult(this.shows[title] ?? []);
  }
  async getShow(): Promise<TVShow | undefined> {
    return undefined;
  }
  async getEpisode(showId: number): Promise<Episode | undefined> {
    return this.episodes[showId];
  }
}

export class FakeMusicProvider implements MusicProvider {
  calls: string[] = [];
  constructor(private recordings: Record<string, Result<Track[]>> = {}) {}
  async searchRecording(title: string): Promise<Track[]> {
    this.calls.push(title);
    return resolveResult(this.recordings[title] ?? []);
  }
  async searchRelease(): Promise<Album[]> {
    return [];
  }
  async getRecording(): Promise<Track | undefined> {
    return undefined;
  }
  async getRelease(): Promise<Album | undefined> {
    return undefined;
  }
}

export const MATRIX_FILE = "The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv";
export const BB_FILE = "Breaking.Bad.S01E01.720p.HDTV.x264.mkv";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface PromptCall {
  kind: "confirm" | "select";
  message: string;
  choices?: SelectChoice<unknown>[];
}

/** A prompter that answers from queues and records every question. */
export class FakePrompter implements Prompter {
  calls: PromptCall[] = [];
  constructor(
    public confirmAnswers: Array<boolean | (() => boolean | Promise<boolean>)> = [],
    public selectAnswers: Array<unknown | (() => unknown)> = [],
  ) {}

  async confirm(message: string): Promise<boolean> {
    this.calls.push({ kind: "confirm", message });
    const answer = this.confirmAnswers.shift();
    if (answer === undefined) throw new Error(`Unexpected confirm: ${message}`);
    return typeof answer === "function" ? answer() : answer;
  }

  async select<T>(message: string, choices: SelectChoice<T>[]): Promise<T> {
    this.calls.push({ kind: "select", message, choices: choices as SelectChoice<unknown>[] });
    if (this.selectAnswers.length === 0) throw new Error(`Unexpected select: ${message}`);
    const answer = this.selectAnswers.shift();
    return (typeof answer === "function" ? await (answer as () => unknown)() : answer) as T;
  }
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

export class OutputBuffer {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunOptions = Partial<Omit<CliDeps, "stdout" | "stderr">>;

export async function runIn(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const stdout = new OutputBuffer();
  const stderr = new OutputBuffer();
  const code = await runCli(argv, {
    prompter: new FakePrompter(),
    env: {},
    ...options,
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Remove ANSI escape sequences. */
export function strip(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// ---------------------------------------------------------------------------
// Temp directories
// ---------------------------------------------------------------------------

export interface Sandbox {
  root: string;
  configDir: string;
  media: string;
  cleanup(): Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tidytitles-cli-"));
  const configDir = path.join(root, "config");
  const media = path.join(root, "media");
  await mkdir(media, { recursive: true });
  return {
    root,
    configDir,
    media,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Create a file (and its directory) under `dir`. */
export async function touch(dir: string, name: string, content = name): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** Write a config.toml with the given API keys. */
export async function writeKeys(
  configDir: string,
  keys: { tmdb?: string; tvdb?: string },
  extra = "",
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "config.toml"),
    `[api]\ntmdb_api_key = "${keys.tmdb ?? ""}"\ntvdb_api_key = "${keys.tvdb ?? ""}"\n${extra}`,
  );
}
