// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/App";
import { FileTable } from "../../src/renderer/src/components/FileTable";
import { SelectionDialog, describeOption } from "../../src/renderer/src/components/SelectionDialog";
import { SettingsDialog } from "../../src/renderer/src/components/SettingsDialog";
import { EVENTS, type SelectionRequest } from "../../src/shared/ipc";
import { appState, createFakeApi, file, matrix, op, pilot, settingsPayload } from "./fixtures";

const files = [file(1, "The.Matrix.1999.mkv"), file(2, "Unknown.Film.2021.mkv"), file(3, "Breaking.Bad.S01E01.mkv")];
const plannedState = appState({
  files,
  plan: "planned",
  operations: [
    op(files[0]!, { newName: "The Matrix (1999).mkv", metadata: { ...matrix, verificationStatus: "manual_selection" } }),
    op(files[1]!, { status: "skipped", skipReason: "no_match" }),
    op(files[2]!, {
      newName: "Breaking Bad - S01E01 - Pilot.mkv",
      metadata: { ...pilot, verificationStatus: "auto_matched" },
      associatedFiles: [{ source: "/media/Breaking.Bad.S01E01.en.srt", destination: "/media/Breaking Bad - S01E01 - Pilot.en.srt", fileType: "subtitle" }],
    }),
  ],
});

describe("FileTable", () => {
  it("shows original and new names, status labels, row tones, and associated files", () => {
    render(<FileTable app={plannedState} selectedFileId={null} onSelect={() => {}} onRemove={() => {}} />);
    const rows = screen.getAllByTestId("file-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByTestId("status-badge").textContent).toBe("Selected");
    expect(rows[0]!.dataset.tone).toBe("success");
    expect(rows[0]!.textContent).toContain("The Matrix (1999).mkv");
    expect(within(rows[1]!).getByTestId("status-badge").textContent).toBe("No match");
    expect(rows[1]!.dataset.tone).toBe("danger");
    expect(rows[1]!.textContent).toContain("Unchanged");
    expect(document.querySelector(".assoc-row")!.textContent).toContain("Breaking Bad - S01E01 - Pilot.en.srt");
    // The full path is in the tooltip.
    expect(rows[0]!.querySelector('[title="/media/The.Matrix.1999.mkv"]')).not.toBeNull();
  });

  it("moves the selection with the arrow keys and removes with Delete", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(<FileTable app={plannedState} selectedFileId={1} onSelect={onSelect} onRemove={onRemove} />);
    const rows = screen.getAllByTestId("file-row");
    expect(rows[0]!.tabIndex).toBe(0);
    expect(rows[1]!.tabIndex).toBe(-1);
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith(2);
    rerender(<FileTable app={plannedState} selectedFileId={2} onSelect={onSelect} onRemove={onRemove} />);
    fireEvent.keyDown(rows[1]!, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(rows[1]!, { key: "Delete" });
    expect(onRemove).toHaveBeenCalledWith([2]);
    expect(onSelect).toHaveBeenLastCalledWith(3);
  });
});

describe("FileTable with a large list", () => {
  const many = Array.from({ length: 10_000 }, (_, i) => file(i + 1, `Movie.${String(i + 1).padStart(5, "0")}.2020.mkv`));
  const manyPlanned = appState({
    files: many,
    plan: "planned",
    operations: many.map((f, i) =>
      op(f, {
        newName: `Movie ${i + 1} (2020).mkv`,
        // Every tenth file has a subtitle, so groups differ in height.
        associatedFiles:
          i % 10 === 0 ? [{ source: `${f.path}.srt`, destination: `/media/Movie ${i + 1} (2020).srt`, fileType: "subtitle" }] : [],
      }),
    ),
  });

  it("renders only the rows near the viewport, with the full count for assistive technology", () => {
    render(<FileTable app={manyPlanned} selectedFileId={null} onSelect={() => {}} onRemove={() => {}} />);
    const rows = screen.getAllByTestId("file-row");
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0]!.textContent).toContain("Movie.00001.2020.mkv");
    const grid = screen.getByRole("grid");
    // Header + 10,000 files + 1,000 subtitles.
    expect(grid.getAttribute("aria-rowcount")).toBe("11001");
    expect(rows[0]!.getAttribute("aria-rowindex")).toBe("2");
    // Row 2 (file 2) follows file 1 and its subtitle.
    expect(rows[1]!.getAttribute("aria-rowindex")).toBe("4");
    // The rest of the list is a spacer, hidden from assistive technology.
    const spacers = document.querySelectorAll("tr.spacer-row");
    expect(spacers).toHaveLength(1);
    expect(spacers[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the selected row rendered and focusable wherever it is", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<FileTable app={manyPlanned} selectedFileId={1} onSelect={onSelect} onRemove={() => {}} />);
    const first = screen.getAllByTestId("file-row")[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith(10_000);
    rerender(<FileTable app={manyPlanned} selectedFileId={10_000} onSelect={onSelect} onRemove={() => {}} />);
    const last = screen.getAllByTestId("file-row").at(-1)!;
    expect(last.textContent).toContain("Movie.10000.2020.mkv");
    expect(last.getAttribute("aria-rowindex")).toBe("11001");
    expect(last.tabIndex).toBe(0);
    expect(document.activeElement).toBe(last);
    // Spacers stand in for the rows between the window and the selected row.
    expect(document.querySelectorAll("tr.spacer-row")).toHaveLength(1);
    expect(screen.getAllByTestId("file-row").length).toBeLessThan(100);

    // Escape clears the selection; the focused row stays rendered and focused.
    fireEvent.keyDown(last, { key: "Escape" });
    expect(onSelect).toHaveBeenLastCalledWith(null);
    rerender(<FileTable app={manyPlanned} selectedFileId={null} onSelect={onSelect} onRemove={() => {}} />);
    expect(document.activeElement).toBe(last);
    expect(last.isConnected).toBe(true);
    expect(last.tabIndex).toBe(-1);
    expect(screen.getAllByTestId("file-row")[0]!.tabIndex).toBe(0);
  });
});

describe("SelectionDialog", () => {
  const request: SelectionRequest = {
    id: "req-1",
    filename: "The.Matrix.1999.mkv",
    kind: "movie",
    options: [matrix, { ...matrix, id: 2, title: "The Matrix Reloaded", year: 2003, releaseDate: "2003-05-15" }],
  };

  it("describes options with en-US dates", () => {
    expect(describeOption(matrix)).toEqual({ title: "The Matrix (1999)", details: ["Released March 31, 1999"] });
  });

  it("selects the chosen option, by button or double-click", async () => {
    const onSelect = vi.fn();
    render(<SelectionDialog request={request} onSelect={onSelect} onSkip={() => {}} onCancelAll={() => {}} />);
    const options = screen.getAllByTestId("selection-option");
    expect(options).toHaveLength(2);
    await userEvent.click(within(options[1]!).getByRole("radio"));
    await userEvent.click(screen.getByTestId("selection-select"));
    expect(onSelect).toHaveBeenCalledWith(1);
    fireEvent.doubleClick(options[0]!);
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it("skips on Escape and on Skip, and cancels everything on Cancel All", async () => {
    const onSkip = vi.fn();
    const onCancelAll = vi.fn();
    render(<SelectionDialog request={request} onSelect={() => {}} onSkip={onSkip} onCancelAll={onCancelAll} />);
    fireEvent(screen.getByTestId("selection-dialog"), new Event("cancel", { cancelable: true }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("selection-skip"));
    expect(onSkip).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByTestId("selection-cancel-all"));
    expect(onCancelAll).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsDialog", () => {
  it("loads settings, previews templates live, and toggles key visibility", async () => {
    const { api } = createFakeApi();
    api.previewTemplates.mockImplementation(async (t) => ({
      ...settingsPayload().preview,
      movie: t.movie.includes("{bogus}") ? { errors: ["Unknown field: {bogus}"] } : { preview: "The Matrix (1999).mkv", errors: [] },
    }));
    render(<SettingsDialog onClose={() => {}} onSaved={() => {}} />);
    const movie = await screen.findByTestId("template-movie");
    expect(screen.getByTestId("template-movie-preview").textContent).toContain("The Matrix (1999).mkv");

    fireEvent.change(movie, { target: { value: "{title} {bogus}" } });
    expect((await screen.findByTestId("template-movie-error")).textContent).toContain("Unknown field: {bogus}");
    expect(movie.getAttribute("aria-invalid")).toBe("true");

    await userEvent.click(screen.getByTestId("settings-tab-api"));
    const key = screen.getByTestId("tmdb-key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("tmdb-secret");
    await userEvent.click(screen.getByRole("button", { name: "Show TMDB API key" }));
    expect(key.type).toBe("text");
  });

  it("saves the edited settings and reports errors from main", async () => {
    const { api } = createFakeApi();
    const onSaved = vi.fn();
    api.saveSettings.mockResolvedValueOnce({ ok: false, errors: ["Fix the template errors before saving."], templateErrors: { tv: ["Mismatched braces in template"] } });
    render(<SettingsDialog onClose={() => {}} onSaved={onSaved} />);
    await screen.findByTestId("template-movie");
    await userEvent.click(screen.getByTestId("settings-tab-files"));
    await userEvent.click(screen.getByTestId("conflict-auto_version"));
    await userEvent.click(screen.getByTestId("settings-save"));
    expect((await screen.findByTestId("settings-errors")).textContent).toContain("Fix the template errors");
    expect(screen.getByTestId("template-tv-error").textContent).toContain("Mismatched braces");
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.saveSettings.mock.calls[0]![0].conflictResolution).toBe("auto_version");

    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("switches tabs with the arrow keys", async () => {
    createFakeApi();
    render(<SettingsDialog onClose={() => {}} onSaved={() => {}} />);
    const tab = await screen.findByTestId("settings-tab-templates");
    fireEvent.keyDown(tab, { key: "ArrowDown" });
    expect(screen.getByTestId("settings-tab-api").getAttribute("aria-selected")).toBe("true");
  });
});

describe("App", () => {
  it("shows the empty state, then the table when main sends files", async () => {
    const { emit } = createFakeApi(appState({ apiKeys: { tmdb: false, tvdb: false }, providerChoices: ["musicbrainz"] }));
    render(<App />);
    expect(await screen.findByTestId("empty-state")).toBeTruthy();
    expect(screen.getByTestId("no-keys-note")).toBeTruthy();
    act(() => emit(EVENTS.state, plannedState));
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    expect(screen.getByTestId("rename").textContent).toContain("Rename 2");
  });

  it("asks main to choose a match and answers with the selected index", async () => {
    const { api, emit } = createFakeApi(appState({ files, busy: "fetching" }));
    render(<App />);
    await screen.findAllByTestId("file-row");
    act(() =>
      emit(EVENTS.selectionRequest, { id: "sel-9", filename: "The.Matrix.1999.mkv", kind: "movie", options: [matrix] }),
    );
    await userEvent.click(await screen.findByTestId("selection-select"));
    expect(api.answerSelection).toHaveBeenCalledWith("sel-9", 0);
    expect(screen.queryByTestId("selection-dialog")).toBeNull();
  });

  it("closes a withdrawn selection request", async () => {
    const { emit } = createFakeApi(appState({ files, busy: "fetching" }));
    render(<App />);
    await screen.findAllByTestId("file-row");
    act(() => emit(EVENTS.selectionRequest, { id: "sel-1", filename: "x", kind: "movie", options: [matrix] }));
    expect(await screen.findByTestId("selection-dialog")).toBeTruthy();
    act(() => emit(EVENTS.selectionClosed, { id: "sel-1" }));
    expect(screen.queryByTestId("selection-dialog")).toBeNull();
  });

  it("confirms before renaming and shows the summary", async () => {
    const { api } = createFakeApi(plannedState);
    api.rename.mockResolvedValueOnce({
      kind: "done",
      summary: { total: 3, completed: 2, failed: 0, skipped: 1, pending: 0, associatedFiles: 1, totalFiles: 4 },
      associatedRenamed: 1,
      coverArtDownloaded: 0,
      coverArtAttempted: false,
      failures: [],
      historySaved: 2,
    });
    render(<App />);
    await userEvent.click(await screen.findByTestId("rename"));
    const confirm = screen.getByTestId("confirm-rename");
    expect(confirm.textContent).toContain("2 files will get their new names, and 1 associated file will move with them");
    await userEvent.click(within(confirm).getByTestId("confirm"));
    expect(api.rename).toHaveBeenCalled();
    expect((await screen.findByTestId("rename-result")).textContent).toContain("Renamed 2 files.");
  });

  it("runs menu commands, but not behind an open dialog", async () => {
    const { api, emit } = createFakeApi(plannedState);
    render(<App />);
    await screen.findAllByTestId("file-row");
    act(() => emit(EVENTS.menuCommand, "settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    act(() => emit(EVENTS.menuCommand, "fetch"));
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("shows an error dialog when the fetch fails", async () => {
    const { api } = createFakeApi(appState({ files }));
    api.fetch.mockResolvedValueOnce({ kind: "error", message: "Invalid configuration" });
    render(<App />);
    await userEvent.click(await screen.findByTestId("fetch"));
    expect((await screen.findByTestId("error-dialog")).textContent).toContain("Invalid configuration");
  });

  it("adds dropped files by path", async () => {
    const { api } = createFakeApi(appState());
    render(<App />);
    const target = await screen.findByTestId("empty-state");
    const dropped = new File([""], "Inception.2010.mkv");
    fireEvent.drop(target, { dataTransfer: { files: [dropped], types: ["Files"] } });
    expect(api.pathForFile).toHaveBeenCalledWith(dropped);
    expect(api.addPaths).toHaveBeenCalledWith(["/dropped/Inception.2010.mkv"]);
  });

  it("sends option changes to main", async () => {
    const { api } = createFakeApi(appState({ files }));
    render(<App />);
    await userEvent.selectOptions(await screen.findByTestId("media-type"), "tv");
    expect(api.setOptions).toHaveBeenCalledWith({ mediaType: "tv" });
    await userEvent.click(screen.getByTestId("cover-art"));
    expect(api.setOptions).toHaveBeenLastCalledWith({ coverArt: true });
    expect((screen.getByTestId("cover-art") as HTMLInputElement).checked).toBe(true);
  });
});
