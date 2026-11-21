// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createTVShow } from "@tidytitles/core";
import { App } from "../../src/renderer/src/App";
import { FileTable } from "../../src/renderer/src/components/FileTable";
import { formFromQuery, queryFromForm, rowActions } from "../../src/renderer/src/corrections";
import { appState, createFakeApi, file, matrix, op, pilot } from "./fixtures";

const files = [file(1, "The.Matrix.1999.mkv"), file(2, "Unknown.Film.2021.mkv"), file(3, "The.Office.S01E01.mkv")];
const matched = op(files[0]!, { newName: "The Matrix (1999).mkv", metadata: { ...matrix, verificationStatus: "auto_matched" } });
const noMatch = op(files[1]!, { status: "skipped", skipReason: "no_match" });
const episode = op(files[2]!, { newName: "Breaking Bad - S01E01 - Pilot.mkv", metadata: { ...pilot, verificationStatus: "auto_matched" } });
const planned = appState({ files, plan: "planned", operations: [matched, noMatch, episode] });

const officeUS = createTVShow({ id: 73244, title: "The Office (US)", originalTitle: "The Office", year: 2005 });
const officeUK = createTVShow({ id: 78107, title: "The Office", originalTitle: "The Office", year: 2001 });

describe("row actions", () => {
  it("offers what applies to the operation", () => {
    const enabled = (o: Parameters<typeof rowActions>[0]) =>
      rowActions(o).filter((a) => a.enabled).map((a) => a.action);
    expect(enabled(matched)).toEqual(["changeMatch", "editName", "clearMatch"]);
    expect(enabled(noMatch)).toEqual(["changeMatch"]);
    const custom = { ...matched, mediaFile: { ...matched.mediaFile, correction: { customName: "Mine", sequence: 1 } } };
    expect(enabled(custom)).toEqual(["changeMatch", "editName", "resetName", "clearMatch"]);
    // A name another file also gets can still be edited (that is how to fix it).
    expect(enabled({ ...matched, status: "skipped", skipReason: "duplicate_destination" })).toContain("editName");
  });

  it("turns the search form into a query and back", () => {
    const form = formFromQuery({ mediaType: "tv_episode", title: "The Office", season: 1, episode: 2 });
    expect(form).toMatchObject({ mediaType: "tv_episode", title: "The Office", year: "", season: "1", episode: "2" });
    expect(queryFromForm({ ...form, title: " Office ", year: "2005" })).toEqual({
      ok: true,
      query: { mediaType: "tv_episode", title: "Office", year: 2005, season: 1, episode: 2 },
    });
    expect(queryFromForm({ ...form, episode: "two" })).toMatchObject({ ok: false, field: "episode" });
    expect(queryFromForm({ ...form, title: "  " })).toMatchObject({ ok: false, field: "title" });
    expect(queryFromForm({ ...formFromQuery({ mediaType: "music", title: "Song" }), artist: "Band", year: "x" })).toEqual({
      ok: true,
      query: { mediaType: "music", title: "Song", artist: "Band" },
    });
  });
});

describe("FileTable actions", () => {
  it("has an actions button on each row only while a plan can be corrected", () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <FileTable app={planned} selectedFileId={1} onSelect={() => {}} onRemove={() => {}} onAction={onAction} />,
    );
    const buttons = screen.getAllByTestId("row-actions");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Actions for The.Matrix.1999.mkv");
    // Only the tab-stop row's button is in the tab order.
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1]);

    rerender(
      <FileTable app={{ ...planned, busy: "renaming" }} selectedFileId={1} onSelect={() => {}} onRemove={() => {}} onAction={onAction} />,
    );
    expect(screen.queryAllByTestId("row-actions")).toHaveLength(0);
    rerender(
      <FileTable app={{ ...planned, plan: "renamed" }} selectedFileId={1} onSelect={() => {}} onRemove={() => {}} onAction={onAction} />,
    );
    expect(screen.queryAllByTestId("row-actions")).toHaveLength(0);
  });

  it("opens Change Match with Enter and Edit New Name with F2 on a row", () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <FileTable app={planned} selectedFileId={1} onSelect={() => {}} onRemove={() => {}} onAction={onAction} />,
    );
    const rows = screen.getAllByTestId("file-row");
    fireEvent.keyDown(rows[0]!, { key: "Enter" });
    expect(onAction).toHaveBeenLastCalledWith(1, "changeMatch");
    fireEvent.keyDown(rows[0]!, { key: "F2" });
    expect(onAction).toHaveBeenLastCalledWith(1, "editName");

    // No name to edit without a match.
    onAction.mockClear();
    rerender(<FileTable app={planned} selectedFileId={2} onSelect={() => {}} onRemove={() => {}} onAction={onAction} />);
    fireEvent.keyDown(rows[1]!, { key: "F2" });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("runs an action from the menu with the keyboard, skipping disabled items", async () => {
    const onAction = vi.fn();
    render(<FileTable app={planned} selectedFileId={2} onSelect={() => {}} onRemove={() => {}} onAction={onAction} />);
    const rows = screen.getAllByTestId("file-row");
    fireEvent.keyDown(rows[1]!, { key: "F10", shiftKey: true });
    const menu = await screen.findByTestId("row-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe("Actions for Unknown.Film.2021.mkv");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Change Match…Enter", "Edit New Name…F2", "Clear Match"]);
    expect(items.map((i) => (i as HTMLButtonElement).disabled)).toEqual([false, true, true]);
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" }); // only one enabled item: stays
    expect(document.activeElement).toBe(items[0]);
    fireEvent.click(items[0]!);
    expect(onAction).toHaveBeenCalledWith(2, "changeMatch");
    expect(screen.queryByTestId("row-menu")).toBeNull();
  });

  it("closes the menu with Escape and gives focus back to the row", async () => {
    render(<FileTable app={planned} selectedFileId={1} onSelect={() => {}} onRemove={() => {}} onAction={() => {}} />);
    await userEvent.click(screen.getAllByTestId("row-actions")[0]!);
    const menu = await screen.findByTestId("row-menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("row-menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getAllByTestId("file-row")[0]);
  });

  it("marks a typed name and a cleared match", () => {
    const edited = {
      ...matched,
      destination: "/media/My Matrix.mkv",
      mediaFile: { ...matched.mediaFile, correction: { customName: "My Matrix", sequence: 1 } },
    };
    const cleared = {
      ...episode,
      destination: episode.source,
      status: "skipped" as const,
      skipReason: "match_cleared" as const,
      mediaFile: { ...episode.mediaFile, matchedMetadata: undefined, correction: { match: "cleared" as const, sequence: 2 } },
    };
    render(
      <FileTable app={{ ...planned, operations: [edited, noMatch, cleared] }} selectedFileId={null} onSelect={() => {}} onRemove={() => {}} />,
    );
    const rows = screen.getAllByTestId("file-row");
    expect(within(rows[0]!).getByTestId("name-edited").textContent).toBe("Edited");
    expect(rows[0]!.textContent).toContain("My Matrix.mkv");
    expect(within(rows[2]!).getByTestId("status-badge").textContent).toBe("Left alone");
    expect(rows[2]!.dataset.tone).toBeUndefined();
  });
});

describe("Change Match dialog", () => {
  it("starts with the fetch's search, searches with other words, and gives the show to the other episodes", async () => {
    const { api } = createFakeApi(planned);
    api.getMatchContext.mockResolvedValue({
      kind: "ok",
      context: {
        fileId: 3,
        query: { mediaType: "tv_episode", title: "The Office", season: 1, episode: 1 },
        queryTypes: ["movie", "tv_episode"],
        parsedTitle: "The Office",
        similarCount: 2,
      },
    });
    api.searchMatches.mockImplementation(async (_id, query) => ({
      kind: "results",
      searchId: `s-${query.title}`,
      query,
      options: query.title === "The Office" ? [officeUK] : [officeUS, officeUK],
    }));
    api.chooseMatch.mockResolvedValue({ kind: "applied", changed: 3, unmatched: 0 });
    render(<App />);
    const rows = await screen.findAllByTestId("file-row");
    fireEvent.click(rows[2]!);
    fireEvent.keyDown(rows[2]!, { key: "Enter" });

    const dialog = await screen.findByTestId("match-dialog");
    await waitFor(() => expect(within(dialog).getAllByTestId("match-option")).toHaveLength(1));
    expect(api.searchMatches).toHaveBeenCalledWith(3, { mediaType: "tv_episode", title: "The Office", season: 1, episode: 1 });
    expect((within(dialog).getByTestId("match-title") as HTMLInputElement).value).toBe("The Office");
    expect((within(dialog).getByTestId("match-season") as HTMLInputElement).value).toBe("1");

    const title = within(dialog).getByTestId("match-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Office{Enter}");
    await waitFor(() => expect(within(dialog).getAllByTestId("match-option")).toHaveLength(2));
    expect(within(dialog).getByTestId("match-message").textContent).toBe("2 results for “Office”.");
    const similar = within(dialog).getByTestId("match-apply-similar");
    expect(similar.textContent).toBe("Also use this show for the 2 other files named “The Office”");
    expect((within(similar).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);

    // Correct the episode number without searching again.
    const episodeField = within(dialog).getByTestId("match-episode");
    await userEvent.clear(episodeField);
    await userEvent.type(episodeField, "2");
    await userEvent.click(within(dialog).getByTestId("match-use"));
    expect(api.chooseMatch).toHaveBeenCalledWith("s-Office", 0, { applyToSimilar: true, season: 1, episode: 2 });
    await waitFor(() => expect(screen.queryByTestId("match-dialog")).toBeNull());
  });

  it("explains a missing episode, an empty result, and a missing provider", async () => {
    const { api } = createFakeApi(planned);
    api.getMatchContext.mockResolvedValue({
      kind: "ok",
      context: { fileId: 2, query: { mediaType: "movie", title: "Unknown Film", year: 2021 }, queryTypes: ["movie", "tv_episode"], parsedTitle: "Unknown Film", similarCount: 0 },
    });
    api.searchMatches.mockResolvedValueOnce({ kind: "results", searchId: "s1", query: { mediaType: "movie", title: "Unknown Film", year: 2021 }, options: [] });
    render(<App />);
    const rows = await screen.findAllByTestId("file-row");
    fireEvent.click(rows[1]!);
    fireEvent.keyDown(rows[1]!, { key: "Enter" });
    const dialog = await screen.findByTestId("match-dialog");
    await waitFor(() =>
      expect(within(dialog).getByTestId("match-message").textContent).toBe("Nothing found for “Unknown Film”. Try other words."),
    );
    expect((within(dialog).getByTestId("match-use") as HTMLButtonElement).disabled).toBe(true);
    // No "Clear Match" for a file without a match.
    expect(within(dialog).queryByTestId("match-clear")).toBeNull();

    // Search as a TV episode, which has no provider.
    api.searchMatches.mockResolvedValueOnce({ kind: "noProvider", mediaType: "tv_episode" });
    await userEvent.selectOptions(within(dialog).getByTestId("match-type"), "tv_episode");
    await userEvent.click(within(dialog).getByTestId("match-search"));
    await waitFor(() => expect(within(dialog).getByTestId("match-message").textContent).toContain("TVDB or TMDB API key"));

    api.searchMatches.mockResolvedValueOnce({ kind: "results", searchId: "s2", query: { mediaType: "tv_episode", title: "The Office" }, options: [officeUS] });
    const title = within(dialog).getByTestId("match-title");
    await userEvent.clear(title);
    await userEvent.type(title, "The Office");
    await userEvent.click(within(dialog).getByTestId("match-search"));
    await within(dialog).findByTestId("match-option");
    api.chooseMatch.mockResolvedValueOnce({ kind: "episodeNotFound", season: 3, episode: 9 });
    await userEvent.click(within(dialog).getByTestId("match-use"));
    await waitFor(() =>
      expect(within(dialog).getByTestId("match-message").textContent).toBe("The Office (US) has no season 3, episode 9. Check the numbers."),
    );
    expect(screen.getByTestId("match-dialog")).toBeTruthy();
  });

  it("clears a match from the row menu", async () => {
    const { api } = createFakeApi(planned);
    render(<App />);
    await userEvent.click((await screen.findAllByTestId("row-actions"))[0]!);
    await userEvent.click(await screen.findByTestId("row-action-clearMatch"));
    expect(api.clearMatch).toHaveBeenCalledWith(1);
  });
});

describe("Edit New Name dialog", () => {
  it("shows the name without its extension, reports refused names, and saves", async () => {
    const { api } = createFakeApi(planned);
    api.getEditableName.mockResolvedValue({
      kind: "ok",
      name: { name: "The Matrix (1999)", templateName: "The Matrix (1999)", extension: ".mkv", folder: "", custom: false },
    });
    api.setFileName
      .mockResolvedValueOnce({ kind: "invalid", problem: "invalid_characters", message: "A name can’t contain / \\ : * ? \" < > | or control characters." })
      .mockResolvedValueOnce({ kind: "applied" });
    render(<App />);
    const rows = await screen.findAllByTestId("file-row");
    fireEvent.click(rows[0]!);
    fireEvent.keyDown(rows[0]!, { key: "F2" });
    const dialog = await screen.findByTestId("name-dialog");
    const input = within(dialog).getByTestId("name-input") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("The Matrix (1999)"));
    expect(dialog.textContent).toContain(".mkv");
    expect(within(dialog).queryByTestId("name-reset")).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, "Matrix/1{Enter}");
    expect(api.setFileName).toHaveBeenLastCalledWith(1, "Matrix/1");
    expect((await within(dialog).findByTestId("name-error")).textContent).toContain("can’t contain");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await userEvent.clear(input);
    await userEvent.type(input, "Matrix{Enter}");
    expect(api.setFileName).toHaveBeenLastCalledWith(1, "Matrix");
    await waitFor(() => expect(screen.queryByTestId("name-dialog")).toBeNull());
  });

  it("goes back to the template's name", async () => {
    const { api } = createFakeApi(planned);
    api.getEditableName.mockResolvedValue({
      kind: "ok",
      name: { name: "Mine", templateName: "The Matrix (1999)", extension: ".mkv", folder: "", custom: true },
    });
    render(<App />);
    const rows = await screen.findAllByTestId("file-row");
    fireEvent.click(rows[0]!);
    fireEvent.keyDown(rows[0]!, { key: "F2" });
    await userEvent.click(await screen.findByTestId("name-reset"));
    expect(api.setFileName).toHaveBeenCalledWith(1, null);
  });
});
