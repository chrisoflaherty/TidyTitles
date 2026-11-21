/**
 * Edition, audio codec, audio channels, and HDR format from file names.
 * Expected values are guessit 3.8.0's output for each name.
 */

import { describe, expect, it } from "vitest";

import type { ParsedInfo } from "../src/models";
import { GuessItParser } from "../src/parser";

type Details = Pick<ParsedInfo, "edition" | "audioCodec" | "audioChannels" | "hdr">;

const CASES: Array<[string, Details]> = [
  ["Heat.1995.1080p.BluRay.DTS-HD.MA.5.1.x264-GRP.mkv", { audioCodec: "DTS-HD", audioChannels: "5.1" }],
  ["Dune.2021.1080p.BluRay.DTS-X.7.1.x264-GRP.mkv", { audioCodec: "DTS:X", audioChannels: "7.1" }],
  [
    "Tenet.2020.2160p.UHD.BluRay.TrueHD.7.1.Atmos.HDR.x265-GRP.mkv",
    { audioCodec: "Dolby TrueHD, Dolby Atmos", audioChannels: "7.1", hdr: "HDR10" },
  ],
  [
    "Wonka.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-GRP.mkv",
    { audioCodec: "Dolby Digital Plus, Dolby Atmos", audioChannels: "5.1", hdr: "Dolby Vision, HDR10" },
  ],
  ["Barbie.2023.2160p.WEB-DL.DD+5.1.HDR10+.H.265-GRP.mkv", { audioCodec: "Dolby Digital Plus", audioChannels: "5.1", hdr: "HDR10" }],
  ["Up.2009.1080p.WEB-DL.AAC2.0.H.264-GRP.mkv", { audioCodec: "AAC", audioChannels: "2.0" }],
  ["Jaws.1975.1080p.BluRay.AC3.x264-GRP.mkv", { audioCodec: "Dolby Digital" }],
  ["Inception.2010.1080p.BluRay.x264.DTS-FGT.mkv", { audioCodec: "DTS" }],
  ["The.Dark.Knight.2008.2160p.UHD.BluRay.x265.HDR-TERMINAL.mkv", { hdr: "HDR10" }],
  ["The.Departed.2006.1080p.BluRay.x264.DTS-ES.6.1-FGT.mkv", { audioCodec: "DTS" }],
  ["Alien.1979.Directors.Cut.1080p.BluRay.x264-GRP.mkv", { edition: "Director's Cut" }],
  ["Kingdom.of.Heaven.2005.Director's.Cut.1080p.BluRay.x264-GRP.mkv", { edition: "Director's Cut" }],
  ["Aliens.1986.EXTENDED.1080p.BluRay.x264-GRP.mkv", { edition: "Extended" }],
  ["The.Two.Towers.2002.Extended.Edition.1080p.BluRay.x264-GRP.mkv", { edition: "Extended" }],
  ["Amadeus.1984.Theatrical.Cut.1080p.BluRay.x264-GRP.mkv", { edition: "Theatrical" }],
  ["Avatar.2009.Special.Edition.1080p.BluRay.x264-GRP.mkv", { edition: "Special" }],
  ["Terminator.2.1991.Collectors.Edition.1080p.BluRay.x264-GRP.mkv", { edition: "Collector" }],
  ["Ghostbusters.1984.Extended.Remastered.1080p.BluRay.x264-GRP.mkv", { edition: "Extended, Remastered" }],
  ["Lawrence.of.Arabia.1962.Restored.1080p.BluRay.x264.mkv", { edition: "Restored" }],
  ["Dunkirk.2017.IMAX.1080p.BluRay.x264-GRP.mkv", { edition: "IMAX" }],
  ["Blade Runner (1982) Director's Cut.mkv", { edition: "Director's Cut" }],
  ["Pink Floyd - Comfortably Numb.flac", { audioCodec: "FLAC" }],
  // Words in a title are not tags.
  ["The.Extended.Family.mkv", {}],
  ["Charlottes.Web.1973.mkv", {}],
  // guessit knows none of these.
  ["Blade.Runner.1982.Final.Cut.1080p.BluRay.x264-GRP.mkv", {}],
  ["Movie.2010.2160p.WEB-DL.DoVi.H.265-GRP.mkv", {}],
];

describe("release details", () => {
  const parser = new GuessItParser();
  it.each(CASES)("%s", (name, expected) => {
    const info = parser.parse(name);
    const details: Details = {};
    for (const key of ["edition", "audioCodec", "audioChannels", "hdr"] as const) {
      if (info[key] !== undefined) details[key] = info[key];
    }
    expect(details).toEqual(expected);
  });
});
