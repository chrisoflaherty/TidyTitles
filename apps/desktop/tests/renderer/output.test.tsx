// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/src/App";
import { FileTable } from "../../src/renderer/src/components/FileTable";
import { HistoryDialog } from "../../src/renderer/src/components/HistoryDialog";
import { UndoResultDialog } from "../../src/renderer/src/components/MessageDialogs";
import { SettingsDialog } from "../../src/renderer/src/components/SettingsDialog";
import { destinationView, outputSummary } from "../../src/renderer/src/destination";
import { EVENTS, type HistoryEntryView } from "../../src/shared/ipc";
import { appState, createFakeApi, file, matrix, op, pilot } from "./fixtures";

const files = [file(1, "The.Matrix.1999.mkv"), file(2, "Breaking.Bad.S01E01.mkv")];
const output = { movie: "/Volumes/Media/Movies", tv: "", music: "" };
const planned = appState({
  files,
  plan: "planned",
  output,
  operations: [
    {
      ...op(files[0]!, { metadata: { ...matrix, verificationStatus: "auto_matched" } }),
      destination: "/Volumes/Media/Movies/The Matrix (1999)/The Matrix (1999).mkv",
    },
    op(files[1]!, { newName: "Breaking Bad - S01E01 - Pilot.mkv", metadata: { ...pilot, verificationStatus: "auto_matched" } }),
  ],
});

describe("destinationView", () => {
  it("keeps names in the same folder short and labels other folders by the output folder", () => {
    expect(destinationView("/m/a.mkv", "/m/A.mkv", undefined)).toEqual({ text: "A.mkv", elsewhere: false });
    expect(destinationView("/m/a.mkv", "/m/Artist/Album/A.mkv", "/out")).toEqual({ text: "Artist/Album/A.mkv", elsewhere: false });
    expect(destinationView("/m/a.mkv", "/Volumes/Media/Movies/A/A.mkv", "/Volumes/Media/Movies")).toEqual({
      text: "Movies/A/A.mkv",
      elsewhere: true,
    });
    expect(destinationView("C:\\in\\a.mkv", "D:\\Movies\\A.mkv", "D:\\Movies")).toEqual({ text: "Movies/A.mkv", elsewhere: true });
    expect(destinationView("/m/a.mkv", "/x/A.mkv", undefined)).toEqual({ text: "/x/A.mkv", elsewhere: true });
  });

  it("summarizes the folders in use", () => {
    expect(outputSummary({ movie: "", tv: " ", music: "" })).toBeNull();
    expect(outputSummary({ movie: "/a/Films", tv: "/b/Shows", music: "" })).toEqual({
      text: "Movies → Films, TV → Shows",
      detail: "Movies: /a/Films\nTV: /b/Shows",
    });
  });
});

describe("main window", () => {
  it("marks a destination in another folder and names that folder", () => {
    render(<FileTable app={planned} selectedFileId={null} onSelect={() => {}} onRemove={() => {}} />);
    const rows = screen.getAllByTestId("file-row");
    const elsewhere = within(rows[0]!).getByTestId("dest-elsewhere");
    expect(elsewhere.textContent).toContain("Movies/The Matrix (1999)/The Matrix (1999).mkv");
    expect(elsewhere.textContent).toContain("In another folder");
    expect(elsewhere.querySelector('[title="Goes to /Volumes/Media/Movies/The Matrix (1999)/The Matrix (1999).mkv"]')).not.toBeNull();
    expect(within(rows[1]!).queryByTestId("dest-elsewhere")).toBeNull();
  });

  it("shows the output folders and the transfer mode in the options bar", async () => {
    const { api } = createFakeApi(planned);
    render(<App />);
    const chip = await screen.findByTestId("output-chip");
    expect(chip.textContent).toContain("Movies → Movies");
    expect(chip.title).toContain("/Volumes/Media/Movies");
    await userEvent.selectOptions(screen.getByTestId("transfer-mode"), "copy");
    expect(api.setOptions).toHaveBeenCalledWith({ transferMode: "copy" });
    await userEvent.click(chip);
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    expect(await screen.findByTestId("output-movie")).toBeTruthy();
  });

  it("says so when files stay in their folders", async () => {
    createFakeApi(appState({ files }));
    render(<App />);
    expect((await screen.findByTestId("output-chip")).textContent).toContain("Same folders");
  });

  it("names the destination folders and the mode in the rename confirmation", async () => {
    const { emit } = createFakeApi(planned);
    render(<App />);
    await screen.findAllByTestId("file-row");
    act(() => emit(EVENTS.state, { ...planned, options: { ...planned.options, transferMode: "copy" } }));
    await userEvent.click(await screen.findByTestId("rename"));
    const confirm = await screen.findByTestId("confirm-rename");
    expect(confirm.textContent).toContain("Copy Files?");
    expect(confirm.textContent).toContain("the originals stay as they are");
    expect(within(confirm).getByTestId("confirm-destinations").textContent).toContain("/Volumes/Media/Movies");
    expect(confirm.textContent).toContain("1 file stay in their folders");
    expect(within(confirm).getByTestId("confirm").textContent).toBe("Copy 2 Files");
  });
});

describe("Output settings", () => {
  it("edits the folders with the picker, the mode, and the history limit", async () => {
    const { api } = createFakeApi();
    api.chooseFolder.mockResolvedValueOnce("/Volumes/Media/Shows");
    render(<SettingsDialog onClose={() => {}} onSaved={() => {}} initialTab="output" />);
    await userEvent.click(await screen.findByTestId("output-tv-choose"));
    await waitFor(() => expect((screen.getByTestId("output-tv") as HTMLInputElement).value).toBe("/Volumes/Media/Shows"));
    await userEvent.click(screen.getByTestId("transfer-hardlink"));
    const limit = screen.getByTestId("history-limit") as HTMLInputElement;
    await userEvent.clear(limit);
    await userEvent.type(limit, "0");
    expect(limit.getAttribute("aria-invalid")).toBe("true");
    await userEvent.clear(limit);
    await userEvent.type(limit, "500");
    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.saveSettings.mock.calls[0]![0]).toMatchObject({
      output: { movie: "", tv: "/Volumes/Media/Shows", music: "", transferMode: "hardlink" },
      history: { maxEntries: 500 },
    });
  });
});

const entries: HistoryEntryView[] = [
  {
    timestamp: "2026-11-21T09:15:00",
    position: 0,
    operations: 1,
    files: 1,
    transfer: "copy",
    samples: [{ source: "/m/b.mkv", destination: "/m/B (2002).mkv" }],
  },
  {
    timestamp: "2026-11-07T19:00:00.123000",
    position: 1,
    operations: 3,
    files: 4,
    transfer: "move",
    samples: [{ source: "/m/a.mkv", destination: "/m/A (2001).mkv" }],
  },
];

describe("History dialog", () => {
  it("lists renames with en-US dates and confirms before undoing an older one", async () => {
    const { api } = createFakeApi();
    api.getHistory.mockResolvedValueOnce(entries);
    const undone: string[] = [];
    render(<HistoryDialog busy={false} onClose={() => {}} onUndo={(e) => undone.push(e.timestamp)} />);
    const rows = await screen.findAllByTestId("history-entry");
    expect(rows).toHaveLength(2);
    // Month first, 12-hour clock; the year shows only when it is not this year.
    expect(rows[1]!.textContent).toMatch(/Saturday, November 7(, 2026)? at 7:00 PM/);
    expect(rows[1]!.textContent).toContain("Renamed 3 files (4 with associated files)");
    expect(rows[1]!.textContent).toContain("A (2001).mkv and 2 more");
    expect(rows[0]!.textContent).toContain("Copied 1 file");

    await userEvent.click(within(rows[1]!).getByTestId("history-undo"));
    const confirm = screen.getByTestId("history-confirm");
    expect(confirm.textContent).toContain("Move 4 files back to their original names");
    expect(confirm.textContent).toContain("1 later rename will stay as it is");
    await userEvent.click(screen.getByTestId("history-confirm-undo"));
    expect(undone).toEqual(["2026-11-07T19:00:00.123000"]);
  });

  it("says when there is nothing to undo", async () => {
    createFakeApi();
    render(<HistoryDialog busy={false} onClose={() => {}} onUndo={() => {}} />);
    expect(await screen.findByTestId("history-empty")).toBeTruthy();
  });

  it("opens from the toolbar and shows the undo result", async () => {
    const { api } = createFakeApi(appState({ files }));
    api.getHistory.mockResolvedValue(entries);
    api.undoEntry.mockResolvedValueOnce({
      kind: "done",
      historyFound: true,
      undone: 2,
      missing: 0,
      kept: 1,
      failed: 0,
      items: [{ name: "A (2001).mkv", status: "kept", errors: [], kept: [{ name: "A (2001).mkv", reason: "changed" }] }],
    });
    render(<App />);
    await userEvent.click(await screen.findByTestId("history"));
    const rows = await screen.findAllByTestId("history-entry");
    fireEvent.click(within(rows[1]!).getByTestId("history-undo"));
    await userEvent.click(screen.getByTestId("history-confirm-undo"));
    expect(api.undoEntry).toHaveBeenCalledWith("2026-11-07T19:00:00.123000");
    const result = await screen.findByTestId("undo-result");
    expect(result.textContent).toContain("Left in place");
    expect(within(result).getByTestId("undo-kept").textContent).toContain("replaced or changed after the rename");
  });
});

describe("Undo result", () => {
  it("lists files left in place with the reason", () => {
    render(
      <UndoResultDialog
        onClose={() => {}}
        outcome={{
          kind: "done",
          historyFound: true,
          undone: 0,
          missing: 0,
          kept: 1,
          failed: 0,
          items: [{ name: "x.mkv", status: "kept", errors: [], kept: [{ name: "x.mkv", reason: "original_missing" }] }],
        }}
      />,
    );
    expect(screen.getByTestId("undo-kept").textContent).toContain("the original is gone");
  });
});

describe("hard-link skip reasons", () => {
  it("have their own labels", async () => {
    const { operationStatus } = await import("../../src/renderer/src/status");
    const base = op(files[0]!, { status: "skipped", skipReason: "cross_device_link" });
    expect(operationStatus(base, "planned").label).toBe("Can't link across drives");
    expect(operationStatus({ ...base, skipReason: "link_unsupported" }, "planned").label).toBe("Links not supported");
  });
});
