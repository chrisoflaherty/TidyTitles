// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTrack, createArtist } from "@tidytitles/core";
import { describe, expect, it, vi } from "vitest";
import { MetadataConfirmNote, MetadataResultList, MetadataUndoList } from "../../src/renderer/src/components/MetadataReport";
import { SettingsDialog } from "../../src/renderer/src/components/SettingsDialog";
import { createFakeApi, file, matrix, op } from "./fixtures";

describe("Settings: write metadata", () => {
  it("shows both options off by default and saves them", async () => {
    const { api } = createFakeApi();
    render(<SettingsDialog onClose={() => {}} onSaved={vi.fn()} />);
    await screen.findByTestId("template-movie");
    await userEvent.click(screen.getByTestId("settings-tab-files"));
    const tags = screen.getByTestId("write-music-tags") as HTMLInputElement;
    const nfo = screen.getByTestId("write-nfo") as HTMLInputElement;
    expect(tags.checked).toBe(false);
    expect(nfo.checked).toBe(false);
    expect(screen.getByTestId("write-metadata-settings").textContent).toMatch(/Plex doesn’t read them/);
    await userEvent.click(tags);
    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.saveSettings.mock.calls[0]![0].writeMetadata).toEqual({ musicTags: true, nfo: false });
  });
});

const track = createTrack({ id: "rec-1", title: "Song", artist: createArtist({ id: "a", name: "Artist" }) });

describe("rename confirmation", () => {
  it("says what will be written, and that hard links get no tags", () => {
    const ready = [op(file(1, "song.flac"), { newName: "Song.flac", metadata: track }), op(file(2, "m.mkv"), { newName: "The Matrix (1999).mkv", metadata: matrix })];
    const { rerender } = render(<MetadataConfirmNote ready={ready} settings={{ musicTags: true, nfo: true }} transfer="move" />);
    expect(screen.getByTestId("confirm-metadata").textContent).toBe(
      "Tags from MusicBrainz matches will be written into the 1 music file where they differ.NFO files will be written for 1 video.",
    );
    rerender(<MetadataConfirmNote ready={ready} settings={{ musicTags: true, nfo: false }} transfer="hardlink" />);
    expect(screen.getByTestId("confirm-metadata").textContent).toMatch(/won’t be written .* hard linked/);
    rerender(<MetadataConfirmNote ready={ready} settings={{ musicTags: false, nfo: false }} transfer="move" />);
    expect(screen.queryByTestId("confirm-metadata")).toBeNull();
  });
});

describe("rename and undo results", () => {
  it("lists the tags written per file and what was left alone, with the reason", () => {
    render(
      <MetadataResultList
        report={{
          musicTags: true,
          nfo: true,
          files: [
            { name: "Song.flac", tags: { status: "written", format: "flac", changes: [{ field: "title", from: "Old", to: "Song" }, { field: "year", to: "1999" }] } },
            { name: "Song.wav", tags: { status: "not_written", reason: "unsupported_format", changes: [] } },
            { name: "The Matrix (1999).mkv", nfo: [{ kind: "movie", path: "/m/The Matrix (1999).nfo", status: "not_written", reason: "exists" }] },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("tags-written").textContent).toBe("1");
    expect(screen.getByTestId("nfo-written").textContent).toBe("0");
    const details = screen.getByTestId("metadata-details").textContent!;
    expect(details).toContain("Song.flac: title “Old” → “Song”, year “1999”");
    expect(details).toContain("Song.wav: tags not written; tags of this format can’t be written");
    expect(details).toContain("The Matrix (1999).nfo: a file of that name is already there");
  });

  it("lists tags put back and NFO files left in place by undo", () => {
    render(
      <MetadataUndoList
        items={[
          { name: "Song.flac", status: "undone", errors: [], kept: [], tags: { status: "restored" } },
          { name: "Edited.mp3", status: "undone", errors: [], kept: [], tags: { status: "not_restored", reason: "changed" } },
          { name: "Ep.mkv", status: "undone", errors: [], kept: [], createdFiles: [{ name: "tvshow.nfo", kind: "tvshow", status: "kept", reason: "in_use" }] },
        ]}
      />,
    );
    const text = screen.getByTestId("undo-metadata").textContent!;
    expect(text).toContain("Tags put back1");
    expect(text).toContain("Edited.mp3: tags left as they are, because the file was changed after the rename");
    expect(text).toContain("tvshow.nfo: left in place, because other episodes in its folder use it");
  });
});
