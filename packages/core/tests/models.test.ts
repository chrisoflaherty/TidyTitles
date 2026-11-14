import { describe, expect, it } from "vitest";
import {
  createParsedMusicInfo,
  isMusicInfoComplete,
  trackFromParsedInfo,
} from "../src/models";

describe("models", () => {
  it("reports music info completeness", () => {
    const info = createParsedMusicInfo({
      title: "Song",
      artist: "Artist",
      album: "Album",
      trackNumber: 1,
    });
    expect(isMusicInfoComplete(info)).toBe(false);
    expect(isMusicInfoComplete({ ...info, year: 2020 })).toBe(true);
  });

  it("builds a local track from parsed tags", () => {
    const track = trackFromParsedInfo(
      createParsedMusicInfo({ title: "Song", album: "Album", year: 2020 }),
      "unverified",
    );
    expect(track.artist.name).toBe("Unknown Artist");
    expect(track.album?.provider).toBe("local");
    expect(track.verificationStatus).toBe("unverified");
  });
});
