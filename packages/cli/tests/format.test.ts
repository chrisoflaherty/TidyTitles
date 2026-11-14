import path from "node:path";
import { describe, expect, it } from "vitest";
import { destinationLabel } from "../src/format";

describe("destinationLabel", () => {
  const dir = path.resolve("/media/music");

  it("shows the bare name when the file stays in its folder", () => {
    expect(destinationLabel(path.join(dir, "Song.mp3"), dir)).toBe("Song.mp3");
  });

  it("includes folders the template creates", () => {
    const destination = path.join(dir, "Artist", "Album (2001)", "01 - Song.mp3");
    expect(destinationLabel(destination, dir)).toBe(
      path.join("Artist", "Album (2001)", "01 - Song.mp3"),
    );
  });

  it("falls back to the bare name for a destination outside the base folder", () => {
    expect(destinationLabel(path.resolve("/elsewhere/Song.mp3"), dir)).toBe("Song.mp3");
  });
});
