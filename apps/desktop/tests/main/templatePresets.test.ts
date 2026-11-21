import { afterEach, describe, expect, it } from "vitest";
import { NAMING_PRESETS, TemplateEngine } from "@tidytitles/core";
import { previewTemplates } from "../../src/main/templatePreview";
import { KEYS_TOML, createHarness, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("settings payload: presets and placeholder reference", () => {
  it("offers every core preset and documents every placeholder", async () => {
    h = await createHarness(KEYS_TOML);
    const payload = await h.controller.getSettingsPayload();
    expect(payload.presets.map((p) => p.id)).toEqual(NAMING_PRESETS.map((p) => p.id));
    expect(new Set(payload.fieldDocs.map((d) => d.field))).toEqual(new Set(TemplateEngine.VALID_FIELDS));
    expect(payload.fieldGroupLabels.release).toBe("From the original file name");
  });

  it("previews each preset with the sample metadata", () => {
    const byId = Object.fromEntries(NAMING_PRESETS.map((p) => [p.id, previewTemplates(p.templates)]));
    expect(byId.plex!.movie.preview).toBe("The Matrix (1999) {tmdb-603}/The Matrix (1999).mkv");
    expect(byId.plex!.music.preview).toBe("Pink Floyd/The Wall/206 - Comfortably Numb.flac");
    expect(byId.jellyfin!.tv.preview).toBe("Breaking Bad (2008) [tvdbid-81189]/Season 01/Breaking Bad S01E01 - Pilot.mkv");
    expect(byId.kodi!.music.preview).toBe("Pink Floyd/The Wall/Disc 2/06 - Comfortably Numb.flac");
    expect(byId.default!.movie.preview).toBe("The Matrix (1999).mkv");
    for (const preview of Object.values(byId)) {
      for (const item of Object.values(preview)) expect(item.errors).toEqual([]);
    }
  });

  it("previews the new release and metadata placeholders", () => {
    const p = previewTemplates({
      movie: "{title}< [{audio_codec} {audio_channels}]>< {hdr}>",
      tv: "{title} {air_date}",
      music: "{disc}/{disc_total} {track}/{track_total}",
    });
    expect(p.movie.preview).toBe("The Matrix [DTS-HD 5.1].mkv");
    expect(p.tv.preview).toBe("Breaking Bad 2008-01-20.mkv");
    expect(p.music.preview).toBe("2/2 6/26.flac");
  });
});
