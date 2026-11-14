import { createArtist, createTrack } from "@tidytitles/core";
import { describe, expect, it } from "vitest";
import { splitForMiddleEllipsis } from "../../src/renderer/src/components/MiddleEllipsis";
import {
  formatCount,
  formatDuration,
  formatReleaseDate,
  formatTimestamp,
  parseLocalTimestamp,
  plural,
  relativeTo,
  shortcut,
} from "../../src/renderer/src/format";
import { availability, initialUiState, listCounts, reconcileAppState, reducer, sameJson } from "../../src/renderer/src/state";
import { operationStatus, providerLabel } from "../../src/renderer/src/status";
import { appState, file, matrix, op, pilot } from "./fixtures";

describe("en-US formatting", () => {
  it("formats numbers with comma grouping", () => {
    expect(formatCount(18450)).toBe("18,450");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(1204, "file")).toBe("1,204 files");
  });

  it("formats history timestamps month-first with a 12-hour clock", () => {
    const now = new Date(2026, 10, 14, 12, 0, 0);
    expect(formatTimestamp("2026-11-14T19:05:42.123000", now)).toBe("Saturday, November 14 at 7:05 PM");
    expect(formatTimestamp("2025-07-04T09:30:00", now)).toBe("Friday, July 4, 2025 at 9:30 AM");
    expect(parseLocalTimestamp("garbage")).toBeUndefined();
    expect(formatTimestamp("garbage", now)).toBe("garbage");
  });

  it("formats release dates and durations", () => {
    expect(formatReleaseDate("1999-03-31")).toBe("March 31, 1999");
    expect(formatReleaseDate(undefined)).toBeUndefined();
    expect(formatDuration(355_000)).toBe("5:55");
    expect(formatDuration(0)).toBeUndefined();
  });

  it("shows paths relative to the source folder and platform shortcuts", () => {
    expect(relativeTo("/m", "/m/Queen/A Night/11 - Song.mp3")).toBe("Queen/A Night/11 - Song.mp3");
    expect(relativeTo("C:\\m", "C:\\m\\Movie (1999).mkv")).toBe("Movie (1999).mkv");
    expect(relativeTo("/m", "/other/x.mkv")).toBe("/other/x.mkv");
    expect(shortcut("darwin", "O", { shift: true })).toBe("⇧⌘O");
    expect(shortcut("win32", "O", { shift: true })).toBe("Ctrl+Shift+O");
  });

  it("splits names for middle truncation, keeping the extension in the tail", () => {
    const [head, tail] = splitForMiddleEllipsis("The.Matrix.Reloaded.2003.1080p.BluRay.x264-GROUP.mkv");
    expect(head + tail).toBe("The.Matrix.Reloaded.2003.1080p.BluRay.x264-GROUP.mkv");
    expect(tail.endsWith(".mkv")).toBe(true);
    expect(tail.length).toBeGreaterThanOrEqual(12);
    expect(splitForMiddleEllipsis("short.mkv")).toEqual(["", "short.mkv"]);
  });
});

describe("status presentation", () => {
  const f = file(1, "x.mkv");
  it("labels every verification status, with the Python color meanings", () => {
    const cases = [
      [{ ...matrix, verificationStatus: "auto_matched" }, "Auto-matched", "success"],
      [{ ...matrix, verificationStatus: "manual_selection" }, "Selected", "success"],
      [{ ...pilot, verificationStatus: "auto_matched" }, "Auto-matched", "success"],
    ] as const;
    for (const [metadata, label, tone] of cases) {
      const s = operationStatus(op(f, { metadata, newName: "y.mkv" }), "planned");
      expect([s.label, s.rowTone]).toEqual([label, tone]);
    }
    const track = (verificationStatus: "verified" | "unverified" | "from_provider") =>
      createTrack({ id: "t", title: "T", artist: createArtist({ id: "a", name: "A" }), verificationStatus });
    expect(operationStatus(op(f, { metadata: track("verified") }), "planned")).toMatchObject({ label: "Verified", rowTone: "success" });
    expect(operationStatus(op(f, { metadata: track("unverified") }), "planned")).toMatchObject({ label: "Unverified", rowTone: "warning", tone: "warning" });
    const fromProvider = operationStatus(op(f, { metadata: track("from_provider") }), "planned");
    expect(fromProvider.label).toBe("From MusicBrainz");
    expect(fromProvider.rowTone).toBeUndefined();
  });

  it("labels skips by their typed reason", () => {
    const skip = (fields: Parameters<typeof op>[1]) => operationStatus(op(f, { status: "skipped", ...fields }), "planned");
    expect(skip({ skipReason: "no_match" })).toMatchObject({ label: "No match", rowTone: "danger" });
    expect(skip({ skipReason: "lookup_failed", lookupError: { kind: "authentication", name: "AuthenticationError", message: "401" } }).label).toBe("API key rejected");
    expect(skip({ skipReason: "lookup_failed", lookupError: { kind: "rate_limit", name: "RateLimitError", message: "429" } }).label).toBe("Rate limited");
    expect(skip({ skipReason: "lookup_failed", lookupError: { kind: "provider", name: "ProviderError", message: "503" } })).toMatchObject({ label: "Lookup failed", detail: "503" });
    expect(skip({ skipReason: "duplicate_destination" }).label).toBe("Duplicate name");
    expect(skip({ skipReason: "would_overwrite" }).label).toBe("Name taken");
    expect(skip({ skipReason: "template_error", errorMessage: "bad" }).label).toBe("Template error");
    expect(skip({ skipReason: "same_path" })).toMatchObject({ label: "Already named", tone: "neutral" });
  });

  it("shows rename results and the not-fetched state", () => {
    expect(operationStatus(undefined, "none").label).toBe("Not fetched");
    expect(operationStatus(op(f, { status: "completed", metadata: { ...matrix, verificationStatus: "auto_matched" } }), "renamed")).toMatchObject({ label: "Renamed", rowTone: "success" });
    expect(operationStatus(op(f, { status: "failed", errorMessage: "EACCES" }), "renamed")).toMatchObject({ label: "Failed", detail: "EACCES", rowTone: "danger" });
  });

  it("names providers like the Python GUI", () => {
    expect(providerLabel("auto", { tmdb: true, tvdb: true })).toBe("Auto (TMDB + TVDB + MusicBrainz)");
    expect(providerLabel("auto", { tmdb: true, tvdb: false })).toBe("Auto (TMDB + MusicBrainz)");
    expect(providerLabel("musicbrainz", { tmdb: false, tvdb: false })).toBe("MusicBrainz (music only)");
  });
});

describe("reducer", () => {
  it("keeps the selection only while its file exists, and drops a withdrawn selection request", () => {
    const files = [file(1, "a.mkv"), file(2, "b.mkv")];
    let s = reducer(initialUiState, { type: "state", state: appState({ files, busy: "fetching" }) });
    s = reducer(s, { type: "selectFile", id: 2 });
    s = reducer(s, { type: "selectionRequest", request: { id: "r1", filename: "a.mkv", kind: "movie", options: [] } });
    expect(s.selection?.id).toBe("r1");
    s = reducer(s, { type: "selectionDone", id: "other" });
    expect(s.selection?.id).toBe("r1");
    s = reducer(s, { type: "state", state: appState({ files: [files[0]!], busy: null }) });
    expect(s.selectedFileId).toBeNull();
    expect(s.selection).toBeNull();
  });

  it("tracks nested drag enter/leave", () => {
    let s = reducer(initialUiState, { type: "dragEnter" });
    s = reducer(s, { type: "dragEnter" });
    s = reducer(s, { type: "dragLeave" });
    expect(s.dragDepth).toBe(1);
    expect(reducer(s, { type: "dragEnd" }).dragDepth).toBe(0);
  });

  it("counts and gates actions from the state", () => {
    const files = [file(1, "a.mkv"), file(2, "b.mkv")];
    const planned = appState({
      files,
      plan: "planned",
      operations: [op(files[0]!, { newName: "A.mkv" }), op(files[1]!, { status: "skipped", skipReason: "no_match" })],
    });
    expect(listCounts(planned)).toMatchObject({ files: 2, ready: 1, skipped: 1 });
    expect(availability(planned)).toMatchObject({ rename: true, fetch: true, undo: false });
    expect(availability({ ...planned, busy: "renaming" })).toMatchObject({ rename: false, add: false });
    expect(availability(null).add).toBe(false);
  });
});

describe("state snapshots keep unchanged objects", () => {
  const files = [file(1, "a.mkv"), file(2, "b.mkv"), file(3, "c.mkv")];
  const ops = files.map((f) => op(f, { newName: `${f.name}.new.mkv` }));
  // Main sends a fresh copy of everything with each snapshot.
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const prev = appState({ files, operations: ops, plan: "planned" });

  it("compares JSON values deeply", () => {
    expect(sameJson({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(sameJson([1], { 0: 1 })).toBe(false);
  });

  it("reuses the arrays when nothing in the list changed", () => {
    const next = reconcileAppState(prev, copy({ ...prev, busy: "renaming" }));
    expect(next.busy).toBe("renaming");
    expect(next.files).toBe(prev.files);
    expect(next.operations).toBe(prev.operations);
    expect(next.options).toBe(prev.options);
  });

  it("replaces only what changed", () => {
    const changed = copy(prev);
    changed.operations![1]!.status = "completed";
    const next = reconcileAppState(prev, changed);
    expect(next.files).toBe(prev.files);
    expect(next.operations).not.toBe(prev.operations);
    expect(next.operations![0]).toBe(ops[0]);
    expect(next.operations![1]).not.toBe(ops[1]);
    expect(next.operations![1]!.status).toBe("completed");
    expect(next.operations![2]).toBe(ops[2]);
  });

  it("follows files by id when the list is reordered or shrinks", () => {
    const next = reconcileAppState(prev, copy(appState({ files: [files[2]!, files[0]!], operations: null })));
    expect(next.files).not.toBe(prev.files);
    expect(next.files[0]).toBe(files[2]);
    expect(next.files[1]).toBe(files[0]);
    expect(next.operations).toBeNull();
  });

  it("is what the reducer stores", () => {
    const s1 = reducer(initialUiState, { type: "state", state: prev });
    const s2 = reducer(s1, { type: "state", state: copy(prev) });
    expect(s2.app!.files).toBe(s1.app!.files);
    expect(s2.app!.operations).toBe(s1.app!.operations);
  });
});
