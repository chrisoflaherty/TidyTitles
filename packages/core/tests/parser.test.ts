/** Tests for the filename parsers (port of tests/test_parser.py, plus parity cases). */

import { describe, expect, it } from "vitest";

import type { ParsedInfo } from "../src/models";
import { GuessItParser, RegexParser, createParser } from "../src/parser";

describe("RegexParser", () => {
  it("parses a movie filename with year", () => {
    const result = new RegexParser().parse("The.Matrix.1999.1080p.BluRay.x264.mkv");

    expect(result.title).toBe("The Matrix");
    expect(result.year).toBe(1999);
    expect(result.mediaType).toBe("movie");
    expect(result.quality).toBe("1080p");
    expect(result.source).toBe("BluRay");
  });

  it("parses a movie with year in parentheses", () => {
    const result = new RegexParser().parse("The Matrix (1999).mkv");

    expect(result.title).toBe("The Matrix");
    expect(result.year).toBe(1999);
    expect(result.mediaType).toBe("movie");
  });

  it("parses a TV episode in S01E01 format", () => {
    const result = new RegexParser().parse("Breaking.Bad.S01E01.720p.HDTV.mkv");

    expect(result.title).toBe("Breaking Bad");
    expect(result.season).toBe(1);
    expect(result.episode).toBe(1);
    expect(result.mediaType).toBe("tv_episode");
  });

  it("parses a TV episode in 1x01 format", () => {
    const result = new RegexParser().parse("Breaking Bad 1x01.mkv");

    expect(result.title).toBe("Breaking Bad");
    expect(result.season).toBe(1);
    expect(result.episode).toBe(1);
    expect(result.mediaType).toBe("tv_episode");
  });

  it("returns unknown for an unrecognized filename", () => {
    const result = new RegexParser().parse("random_file.mkv");

    expect(result.mediaType).toBe("unknown");
    expect(result.title).toBe("random file");
    expect(result.rawFilename).toBe("random_file.mkv");
  });

  it("extracts codec and release group", () => {
    const result = new RegexParser().parse("The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv");

    expect(result.codec).toBe("x264");
    expect(result.group).toBe("SPARKS");
  });

  // Expected values are the Python RegexParser's output, quirks included
  // (e.g. "WEB-DL" yields group "DL", S01E100 yields episode 10).
  it.each<[string, Omit<ParsedInfo, "rawFilename">]>([
    ["Inception.2010.720p.WEB-DL.mp4", { title: "Inception", year: 2010, mediaType: "movie", quality: "720p", source: "WEB-DL", group: "DL" }],
    ["Doctor.Who.2005.S01E01.mkv", { title: "Doctor Who 2005", season: 1, episode: 1, mediaType: "tv_episode" }],
    ["Show.Name.2010.mkv", { title: "Show Name 2010", mediaType: "unknown" }],
    ["Movie (2010) [WEB-DL].mkv", { title: "Movie", year: 2010, mediaType: "movie", source: "WEB-DL" }],
    ["Breaking.Bad.S01E100.mkv", { title: "Breaking Bad", season: 1, episode: 10, mediaType: "tv_episode" }],
  ])("matches the Python fallback on %s", (filename, expected) => {
    expect(new RegexParser().parse(filename)).toEqual({ ...expected, rawFilename: filename });
  });
});

describe("createParser", () => {
  it("returns the regex fallback when guessit is disabled", () => {
    expect(createParser(false)).toBeInstanceOf(RegexParser);
  });

  it("returns the guessit-compatible parser by default", () => {
    expect(createParser()).toBeInstanceOf(GuessItParser);
    expect(createParser(true)).toBeInstanceOf(GuessItParser);
  });
});

type Expected = Omit<ParsedInfo, "rawFilename">;

/**
 * Expected values are the output of the Python GuessItParser (guessit 3.8.0)
 * for the same filename, taken from scripts/parser-corpus.txt via
 * scripts/parser-parity.ts. Fields guessit left empty are absent.
 */
const GUESSIT_CASES: Array<[string, Expected]> = [
  ["The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"The Matrix","year":1999,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["Interstellar.2014.IMAX.1080p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"Interstellar","year":2014,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["Pulp.Fiction.1994.REMASTERED.1080p.BluRay.x264-AMIABLE.mkv", {"mediaType":"movie","title":"Pulp Fiction","year":1994,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"AMIABLE"}],
  ["Forrest.Gump.1994.DVDRip.XviD-DoNE.avi", {"mediaType":"movie","title":"Forrest Gump","year":1994,"source":"DVD","codec":"Xvid","group":"DoNE"}],
  ["The.Godfather.1972.1080p.BluRay.x264-CiNEFiLE.mkv", {"mediaType":"movie","title":"The Godfather","year":1972,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"CiNEFiLE"}],
  ["Arrival.2016.1080p.WEB-DL.H264.AC3-EVO.mkv", {"mediaType":"movie","title":"Arrival","year":2016,"quality":"1080p","source":"Web","codec":"H.264","group":"EVO"}],
  ["Joker.2019.HDCAM.x264-TOMMY.mkv", {"mediaType":"movie","title":"Joker","year":2019,"source":"HD Camera","codec":"H.264","group":"TOMMY"}],
  ["Black.Panther.2018.1080p.BluRay.x264-Replica.mkv", {"mediaType":"movie","title":"Black Panther","year":2018,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"Replica"}],
  ["The.Social.Network.2010.1080p.BluRay.DTS.x264-CtrlHD.mkv", {"mediaType":"movie","title":"The Social Network","year":2010,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"CtrlHD"}],
  ["Pans.Labyrinth.2006.SPANISH.1080p.BluRay.x264-HDMaNiAcS.mkv", {"mediaType":"movie","title":"Pans Labyrinth","year":2006,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"HDMaNiAcS"}],
  ["Glass.Onion.A.Knives.Out.Mystery.2022.1080p.NF.WEB-DL.DDP5.1.Atmos.x264-CMRG.mkv", {"mediaType":"movie","title":"Glass Onion A Knives Out Mystery","year":2022,"quality":"1080p","source":"Web","codec":"H.264","group":"CMRG"}],
  ["Poor.Things.2023.2160p.WEB.H265-SuccessfulCrab.mkv", {"mediaType":"movie","title":"Poor Things","year":2023,"quality":"2160p","source":"Web","codec":"H.265","group":"SuccessfulCrab"}],
  ["Inception (2010) [1080p].mp4", {"mediaType":"movie","title":"Inception","year":2010,"quality":"1080p"}],
  ["Heat [1995].mkv", {"mediaType":"movie","title":"Heat","year":1995}],
  ["The_Big_Lebowski_1998_1080p_BluRay.mkv", {"mediaType":"movie","title":"The Big Lebowski","year":1998,"quality":"1080p","source":"Blu-ray"}],
  ["Moonlight 2016 1080p WEB-DL.mkv", {"mediaType":"movie","title":"Moonlight","year":2016,"quality":"1080p","source":"Web"}],
  ["It (2017).mkv", {"mediaType":"movie","title":"It","year":2017}],
  ["The Godfather.mkv", {"mediaType":"movie","title":"The Godfather"}],
  ["Ocean's.Eleven.2001.720p.BluRay.x264-SiNNERS.mkv", {"mediaType":"movie","title":"Ocean's Eleven","year":2001,"quality":"720p","source":"Blu-ray","codec":"H.264","group":"SiNNERS"}],
  ["Mission.Impossible.Dead.Reckoning.Part.One.2023.1080p.WEB-DL.mkv", {"mediaType":"movie","title":"Mission Impossible Dead Reckoning","year":2023,"quality":"1080p","source":"Web"}],
  ["2001.A.Space.Odyssey.1968.1080p.BluRay.x264-AMIABLE.mkv", {"mediaType":"movie","title":"2001 A Space Odyssey","year":1968,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"AMIABLE"}],
  ["1917.2019.1080p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"1917","year":2019,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["Nineteen.Eighty-Four.1984.1080p.BluRay.mkv", {"mediaType":"movie","title":"Nineteen Eighty-Four","year":1984,"quality":"1080p","source":"Blu-ray"}],
  ["22.Jump.Street.2014.1080p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"22 Jump Street","year":2014,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["50.First.Dates.2004.720p.BluRay.x264.mkv", {"mediaType":"movie","title":"50 First Dates","year":2004,"quality":"720p","source":"Blu-ray","codec":"H.264"}],
  ["Toy Story 3 (2010).mkv", {"mediaType":"movie","title":"Toy Story 3","year":2010}],
  ["Terminator.2.Judgment.Day.1991.1080p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"Terminator 2 Judgment Day","year":1991,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["Shrek.2.2004.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Shrek 2","year":2004,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["John.Wick.Chapter.4.2023.1080p.WEB-DL.DDP5.1.H.264-NOGRP.mkv", {"mediaType":"movie","title":"John Wick Chapter 4","year":2023,"quality":"1080p","source":"Web","codec":"H.264","group":"NOGRP"}],
  ["Super.8.2011.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Super 8","year":2011,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["Hotel.Transylvania.3.2018.mkv", {"mediaType":"movie","title":"Hotel Transylvania 3","year":2018}],
  ["The.Lord.of.the.Rings.2001.Part1.avi", {"mediaType":"movie","title":"The Lord of the Rings","year":2001}],
  ["Harry Potter and the Deathly Hallows Part 2 (2011).mkv", {"mediaType":"movie","title":"Harry Potter and the Deathly Hallows","year":2011}],
  ["Breaking.Bad.S05E16.Felina.1080p.WEB-DL.DD5.1.H.264-BS.mkv", {"mediaType":"tv_episode","title":"Breaking Bad","season":5,"episode":16,"episodeTitle":"Felina","quality":"1080p","source":"Web","codec":"H.264","group":"BS"}],
  ["Game of Thrones - S01E01 - Winter Is Coming.mkv", {"mediaType":"tv_episode","title":"Game of Thrones","season":1,"episode":1,"episodeTitle":"Winter Is Coming"}],
  ["The.Wire.S01E01.720p.BluRay.x264-SiNNERS.mkv", {"mediaType":"tv_episode","title":"The Wire","season":1,"episode":1,"quality":"720p","source":"Blu-ray","codec":"H.264","group":"SiNNERS"}],
  ["House.of.the.Dragon.S02E01.1080p.WEB.h264-ETHEL.mkv", {"mediaType":"tv_episode","title":"House of the Dragon","season":2,"episode":1,"quality":"1080p","source":"Web","codec":"H.264","group":"ETHEL"}],
  ["Better.Call.Saul.S06E13.Saul.Gone.1080p.AMC.WEB-DL.DDP5.1.H.264-NTb.mkv", {"mediaType":"tv_episode","title":"Better Call Saul","season":6,"episode":13,"episodeTitle":"Saul Gone","quality":"1080p","source":"Web","codec":"H.264","group":"NTb"}],
  ["Futurama.S01E01.Space.Pilot.3000.DVDRip.XviD.avi", {"mediaType":"tv_episode","title":"Futurama","season":1,"episode":1,"episodeTitle":"Space Pilot 3000","source":"DVD","codec":"Xvid"}],
  ["Mr.Robot.S01E01.eps1.0_hellofriend.mov.720p.WEB-DL.mkv", {"mediaType":"tv_episode","title":"Mr Robot","season":1,"episode":1,"episodeTitle":"eps1 0 hellofriend","quality":"720p","source":"Web"}],
  ["True.Detective.S01E01.The.Long.Bright.Dark.720p.HDTV.x264.mkv", {"mediaType":"tv_episode","title":"True Detective","season":1,"episode":1,"episodeTitle":"The Long Bright Dark","quality":"720p","source":"HDTV","codec":"H.264"}],
  ["The.Sopranos.S01E01.The.Sopranos.1080p.BluRay.x265.mkv", {"mediaType":"tv_episode","title":"The Sopranos","season":1,"episode":1,"episodeTitle":"The Sopranos","quality":"1080p","source":"Blu-ray","codec":"H.265"}],
  ["Breaking Bad S01E01.mkv", {"mediaType":"tv_episode","title":"Breaking Bad","season":1,"episode":1}],
  ["Loki S01E01 Glorious Purpose (1080p).mkv", {"mediaType":"tv_episode","title":"Loki","season":1,"episode":1,"episodeTitle":"Glorious Purpose","quality":"1080p"}],
  ["Its.Always.Sunny.in.Philadelphia.S16E01.1080p.WEB.H264.mkv", {"mediaType":"tv_episode","title":"Its Always Sunny in Philadelphia","season":16,"episode":1,"quality":"1080p","source":"Web","codec":"H.264"}],
  ["Star Trek - Deep Space Nine - S07E25.mkv", {"mediaType":"tv_episode","title":"Star Trek","season":7,"episode":25}],
  ["One.Piece.S01E1071.1080p.WEB.mkv", {"mediaType":"tv_episode","title":"One Piece","season":1,"episode":1071,"quality":"1080p","source":"Web"}],
  ["Friends.S01E16E17.DVDRip.XviD.avi", {"mediaType":"tv_episode","title":"Friends","season":1,"episode":16,"source":"DVD","codec":"Xvid", "episodes": [16, 17]}],
  ["Show.S01E01.S01E02.720p.mkv", {"mediaType":"tv_episode","title":"Show","season":1,"episode":1,"quality":"720p", "episodes": [1, 2]}],
  ["Seinfeld - 4x11 - The Contest.avi", {"mediaType":"tv_episode","title":"Seinfeld","season":4,"episode":11,"episodeTitle":"The Contest"}],
  ["Firefly.1x01-02.Serenity.avi", {"mediaType":"tv_episode","title":"Firefly","season":1,"episode":1,"episodeTitle":"Serenity", "episodes": [1, 2]}],
  ["The Wire Season 2 Episode 5 Undertow.avi", {"mediaType":"tv_episode","title":"The Wire","season":2,"episode":5,"episodeTitle":"Undertow"}],
  ["Late.Night.with.Seth.Meyers.2023.11.02.1080p.WEB.h264-EDITH.mkv", {"mediaType":"tv_episode","title":"Late Night with Seth Meyers","quality":"1080p","source":"Web","codec":"H.264","group":"EDITH", "airDate": "2023-11-02"}],
  ["WWE.Monday.Night.Raw.2024.02.05.720p.HDTV.x264.mkv", {"mediaType":"tv_episode","title":"WWE Monday Night Raw","quality":"720p","source":"HDTV","codec":"H.264", "airDate": "2024-02-05"}],
  ["[Erai-raws] Spy x Family - 07 [720p].mkv", {"mediaType":"tv_episode","title":"Spy x Family","episode":7,"quality":"720p","group":"Erai-raws"}],
  ["[Commie] Steins Gate - 01 [BD 720p AAC] [5E2D8F9A].mkv", {"mediaType":"tv_episode","title":"Steins Gate","episode":1,"quality":"720p","source":"Blu-ray","group":"Commie"}],
  ["Cowboy Bebop - 01 - Asteroid Blues.mkv", {"mediaType":"tv_episode","title":"Cowboy Bebop","episode":1,"episodeTitle":"Asteroid Blues"}],
  ["[Golumpa] Fullmetal Alchemist Brotherhood - 64 [FuniDub 1080p x264 AAC] [ABCD1234].mkv", {"mediaType":"tv_episode","title":"Fullmetal Alchemist Brotherhood","episode":64,"quality":"1080p","codec":"H.264","group":"Golumpa"}],
  ["Battlestar.Galactica.2003.S01E01.720p.BluRay.x264.mkv", {"mediaType":"tv_episode","title":"Battlestar Galactica","year":2003,"season":1,"episode":1,"quality":"720p","source":"Blu-ray","codec":"H.264"}],
  ["Hawaii.Five-0.2010.S01E01.720p.HDTV.mkv", {"mediaType":"tv_episode","title":"Hawaii Five-0","year":2010,"season":1,"episode":1,"quality":"720p","source":"HDTV"}],
  ["24.S01E01.720p.BluRay.x264.mkv", {"mediaType":"tv_episode","title":"24","season":1,"episode":1,"quality":"720p","source":"Blu-ray","codec":"H.264"}],
  ["30 Rock - S01E01 - Pilot.mkv", {"mediaType":"tv_episode","title":"30 Rock","season":1,"episode":1,"episodeTitle":"Pilot"}],
  ["Babylon.5.S01E01.Midnight.on.the.Firing.Line.DVDRip.avi", {"mediaType":"tv_episode","title":"Babylon 5","season":1,"episode":1,"episodeTitle":"Midnight on the Firing Line","source":"DVD"}],
  ["1883.S01E01.1883.1080p.WEB.mkv", {"mediaType":"tv_episode","title":"1883","season":1,"episode":1,"episodeTitle":"1883","quality":"1080p","source":"Web"}],
  ["Breaking.Bad.S01.720p.BluRay.mkv", {"mediaType":"tv_episode","title":"Breaking Bad","season":1,"quality":"720p","source":"Blu-ray"}],
  ["Show.Name.Ep05.mkv", {"mediaType":"tv_episode","title":"Show Name","episode":5}],
  ["06 - Pink Floyd - Comfortably Numb.flac", {"mediaType":"tv_episode","title":"Pink Floyd","episode":6,"episodeTitle":"Comfortably Numb"}],
  ["Pink Floyd - The Wall - 06 - Comfortably Numb.mp3", {"mediaType":"tv_episode","title":"Pink Floyd","episode":6,"episodeTitle":"Comfortably Numb"}],
  ["Queen - Bohemian Rhapsody (Remastered 2011).flac", {"mediaType":"movie","title":"Queen","year":2011}],
  ["02 Breathe (In the Air).flac", {"mediaType":"tv_episode","title":"Breathe","episode":2,"group":"In the Air"}],
  ["Raiders.of.the.Lost.Ark.1981.REMASTERED.1080p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"Raiders of the Lost Ark","year":1981,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["The.Prestige.2006.1080p.BluRay.x264.DTS-WiKi.mkv", {"mediaType":"movie","title":"The Prestige","year":2006,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"WiKi"}],
  ["Moonrise.Kingdom.2012.720p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"Moonrise Kingdom","year":2012,"quality":"720p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["Jaws.1975.1080p.BluRay.x264-AMIABLE.mkv", {"mediaType":"movie","title":"Jaws","year":1975,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"AMIABLE"}],
  ["Lawrence.of.Arabia.1962.Restored.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Lawrence of Arabia","year":1962,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["Your.Name.2016.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Your Name","year":2016,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX.mkv", {"mediaType":"movie","title":"Inside Out 2","year":2024,"quality":"1080p","source":"Web","codec":"H.264","group":"FLUX"}],
  ["Godzilla.Minus.One.2023.JAPANESE.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Godzilla Minus One","year":2023,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["Alien.Romulus.2024.1080p.WEB.mkv", {"mediaType":"movie","title":"Alien Romulus","year":2024,"quality":"1080p","source":"Web"}],
  ["The.Hunger.Games.Mockingjay.Part.2.2015.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"The Hunger Games Mockingjay","year":2015,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["Rocky.IV.1985.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Rocky IV","year":1985,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["Kingsman.The.Secret.Service.2014.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Kingsman The Secret Service","year":2014,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["Edge.of.Tomorrow.2014.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Edge of Tomorrow","year":2014,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["The.Fly.1986.720p.BluRay.x264.mkv", {"mediaType":"movie","title":"The Fly","year":1986,"quality":"720p","source":"Blu-ray","codec":"H.264"}],
  ["amelie_2001_720p.mkv", {"mediaType":"movie","title":"amelie","year":2001,"quality":"720p"}],
  ["Prisoners.2013.1080p.BluRay.x264-SPARKS.mkv", {"mediaType":"movie","title":"Prisoners","year":2013,"quality":"1080p","source":"Blu-ray","codec":"H.264","group":"SPARKS"}],
  ["Chernobyl.S01E01.1.23.45.720p.HDTV.x264-AVS.mkv", {"mediaType":"tv_episode","title":"Chernobyl","season":1,"episode":1,"episodeTitle":"1 23 45","quality":"720p","source":"HDTV","codec":"H.264","group":"AVS"}],
  ["Ozark.S04E14.A.Hard.Way.to.Go.1080p.NF.WEB-DL.mkv", {"mediaType":"tv_episode","title":"Ozark","season":4,"episode":14,"episodeTitle":"A Hard Way to Go","quality":"1080p","source":"Web"}],
  ["Silo.S02E01.1080p.ATVP.WEB-DL.mkv", {"mediaType":"tv_episode","title":"Silo","season":2,"episode":1,"quality":"1080p","source":"Web"}],
  ["The.White.Lotus.S02E07.Arrivederci.1080p.WEB.mkv", {"mediaType":"tv_episode","title":"The White Lotus","season":2,"episode":7,"episodeTitle":"Arrivederci","quality":"1080p","source":"Web"}],
  ["Only.Murders.in.the.Building.S04E10.1080p.WEB.mkv", {"mediaType":"tv_episode","title":"Only Murders in the Building","season":4,"episode":10,"quality":"1080p","source":"Web"}],
  ["Parks.and.Recreation.S07E12.One.Last.Ride.720p.WEB-DL.mkv", {"mediaType":"tv_episode","title":"Parks and Recreation","season":7,"episode":12,"episodeTitle":"One Last Ride","quality":"720p","source":"Web"}],
  ["Modern Family - 11x18 - Finale.mkv", {"mediaType":"tv_episode","title":"Modern Family","season":11,"episode":18,"episodeTitle":"Finale"}],
  ["Doctor.Who.2023.S01E01.1080p.WEB.mkv", {"mediaType":"tv_episode","title":"Doctor Who","year":2023,"season":1,"episode":1,"quality":"1080p","source":"Web"}],
  ["The Simpsons - S01E01 - Simpsons Roasting on an Open Fire.avi", {"mediaType":"tv_episode","title":"The Simpsons","season":1,"episode":1,"episodeTitle":"Simpsons Roasting on an Open Fire"}],
  ["Sherlock.Holmes.2009.1080p.BluRay.x264.mkv", {"mediaType":"movie","title":"Sherlock Holmes","year":2009,"quality":"1080p","source":"Blu-ray","codec":"H.264"}],
  ["[HorribleSubs] Boku no Hero Academia - 88 [1080p].mkv", {"mediaType":"tv_episode","title":"Boku no Hero Academia","episode":88,"quality":"1080p","group":"HorribleSubs"}],
  ["Death Note - 37 - New World.mkv", {"mediaType":"tv_episode","title":"Death Note","episode":37,"episodeTitle":"New World"}],
  ["Real.Time.with.Bill.Maher.2024.11.08.1080p.WEB.h264.mkv", {"mediaType":"tv_episode","title":"Real Time with Bill Maher","quality":"1080p","source":"Web","codec":"H.264", "airDate": "2024-11-08"}],
  ["Cosmos.A.Spacetime.Odyssey.S01E01.1080p.BluRay.mkv", {"mediaType":"tv_episode","title":"Cosmos A Spacetime Odyssey","season":1,"episode":1,"quality":"1080p","source":"Blu-ray"}],
  ["Westworld (2016) - S01E01 - The Original.mkv", {"mediaType":"tv_episode","title":"Westworld","year":2016,"season":1,"episode":1,"episodeTitle":"The Original"}],
  ["Halo.S02E01.1080p.WEB.mkv", {"mediaType":"tv_episode","title":"Halo","season":2,"episode":1,"quality":"1080p","source":"Web"}],
  ["The Matrix (1999) [Bluray-1080p].mkv", {"mediaType":"movie","title":"The Matrix","year":1999,"quality":"1080p","source":"Blu-ray"}],
  ["Dune Part Two (2024) [Bluray-2160p][DV HDR10][TrueHD Atmos 7.1][x265]-FraMeSToR.mkv", {"mediaType":"movie","title":"Dune","year":2024,"quality":"2160p","source":"Ultra HD Blu-ray","codec":"H.265","group":"FraMeSToR"}],
  ["Doctor Who (2005) - S01E01 - Rose [Bluray-720p].mkv", {"mediaType":"tv_episode","title":"Doctor Who","year":2005,"season":1,"episode":1,"episodeTitle":"Rose","quality":"720p","source":"Blu-ray"}],
  ["Frieren - Beyond Journey's End (2023) - S01E01 - The Journey's End [WEBDL-1080p].mkv", {"mediaType":"tv_episode","title":"Frieren","year":2023,"season":1,"episode":1,"episodeTitle":"The Journey's End","quality":"1080p","source":"Web"}],
  ["Movie Title (2020) [Directors Cut].mkv", {"mediaType":"movie","title":"Movie Title","year":2020}],
  ["Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS.mkv", {"mediaType": "movie", "title": "Blade Runner 2049", "year": 2017, "quality": "1080p", "source": "Blu-ray", "codec": "H.264", "group": "SPARKS"}],
  ["1917 (2019).mkv", {"mediaType": "movie", "title": "1917", "year": 2019}],
  ["Breaking.Bad.S01E01E02.720p.HDTV.mkv", {"mediaType": "tv_episode", "title": "Breaking Bad", "season": 1, "episode": 1, "quality": "720p", "source": "HDTV", "episodes": [1, 2]}],
  ["Breaking.Bad.S01E01-E02.720p.HDTV.mkv", {"mediaType": "tv_episode", "title": "Breaking Bad", "season": 1, "episode": 1, "quality": "720p", "source": "HDTV", "episodes": [1, 2]}],
  ["Game of Thrones - 1x01 - Winter Is Coming.mkv", {"mediaType": "tv_episode", "title": "Game of Thrones", "season": 1, "episode": 1, "episodeTitle": "Winter Is Coming"}],
  ["Breaking Bad Season 1 Episode 2.mkv", {"mediaType": "tv_episode", "title": "Breaking Bad", "season": 1, "episode": 2}],
  ["The.Daily.Show.2023.05.12.720p.WEB.h264.mkv", {"mediaType": "tv_episode", "title": "The Daily Show", "quality": "720p", "source": "Web", "codec": "H.264", "airDate": "2023-05-12"}],
  ["[SubsPlease] Jujutsu Kaisen - 05 [1080p].mkv", {"mediaType": "tv_episode", "title": "Jujutsu Kaisen", "episode": 5, "quality": "1080p", "group": "SubsPlease"}],
  ["Doctor Who (2005) - S01E01 - Rose.mkv", {"mediaType": "tv_episode", "title": "Doctor Who", "year": 2005, "season": 1, "episode": 1, "episodeTitle": "Rose"}],
  ["S.W.A.T.S05E01.720p.HDTV.x264-SYNCOPY.mkv", {"mediaType": "tv_episode", "title": "S.W.A.T.", "season": 5, "episode": 1, "quality": "720p", "source": "HDTV", "codec": "H.264", "group": "SYNCOPY"}],
  ["The.Office.US.S02E01.The.Dundies.720p.WEB-DL.mkv", {"mediaType": "tv_episode", "title": "The Office", "season": 2, "episode": 1, "episodeTitle": "The Dundies", "quality": "720p", "source": "Web"}],
  ["Breaking Bad - 101 - Pilot.mkv", {"mediaType": "tv_episode", "title": "Breaking Bad", "season": 1, "episode": 1, "episodeTitle": "Pilot"}],
  ["01 - Title.mp3", {"mediaType": "tv_episode", "title": "Title", "episode": 1}],
  ["Pink Floyd - Comfortably Numb.flac", {"mediaType": "movie", "title": "Pink Floyd"}],
  ["The Matrix (1999) {imdb-tt0133093} [Bluray-1080p].mkv", {"mediaType": "movie", "title": "The Matrix", "year": 1999, "quality": "1080p", "source": "Blu-ray", "group": "imdb-tt0133093"}],
  ["Inception (2010) [1080p] [BluRay] [YTS.MX].mp4", {"mediaType": "movie", "title": "Inception", "year": 2010, "quality": "1080p", "source": "Blu-ray", "group": "YTS.MX"}],
  ["Oppenheimer.2023.1080p.WEBRip.x264.AAC5.1-YTS.MX.mp4", {"mediaType": "movie", "title": "Oppenheimer", "year": 2023, "quality": "1080p", "source": "Web", "codec": "H.264", "group": "YTS.MX"}],
  ["The.Dark.Knight.2008.2160p.UHD.BluRay.x265.HDR-TERMINAL.mkv", {"mediaType": "movie", "title": "The Dark Knight", "year": 2008, "quality": "2160p", "source": "Ultra HD Blu-ray", "codec": "H.265", "group": "TERMINAL"}],
  ["The.Godfather.Part.II.1974.1080p.BluRay.x264-CiNEFiLE.mkv", {"mediaType": "movie", "title": "The Godfather", "year": 1974, "quality": "1080p", "source": "Blu-ray", "codec": "H.264", "group": "CiNEFiLE"}],
  ["Show.Name.S2023E05.720p.WEB.mkv", {"mediaType": "tv_episode", "title": "Show Name", "year": 2023, "season": 2023, "episode": 5, "quality": "720p", "source": "Web"}],
  ["[SubsPlease] One Piece - 1071 (1080p) [ABCDEF12].mkv", {"mediaType": "tv_episode", "title": "One Piece", "episode": 1071, "quality": "1080p", "group": "SubsPlease"}],
  // Probed directly with guessit (not in the corpus file).
  ["Apollo 13.mkv", { mediaType: "tv_episode", title: "Apollo", episode: 13 }],
  ["Toy Story 3.mkv", { mediaType: "movie", title: "Toy Story 3" }],
  ["12 Angry Men.mkv", { mediaType: "tv_episode", title: "Angry Men", episode: 12 }],
  ["Show.105.720p.HDTV.mkv", { mediaType: "tv_episode", title: "Show", season: 1, episode: 5, quality: "720p", source: "HDTV" }],
  ["Movie.2010.PDTV.mkv", { mediaType: "movie", title: "Movie", year: 2010, source: "Digital TV" }],
  ["Movie.2010.1280x720.mkv", { mediaType: "movie", title: "Movie", year: 2010, quality: "720p" }],
  ["Movie.1919.mkv", { mediaType: "tv_episode", title: "Movie", season: 19, episode: 19 }],
  ["Movie.2029.mkv", { mediaType: "movie", title: "Movie", year: 2029 }],
  ["Show.Name.12.05.2019.mkv", { mediaType: "tv_episode", title: "Show Name" , "airDate": "2019-05-12"}],
  ["The.French.Connection.1971.mkv", { mediaType: "movie", title: "The French Connection", year: 1971 }],
  ["The.Extended.Family.mkv", { mediaType: "movie", title: "The Extended Family" }],
  ["Show.Name.S01E01-GRP.mkv", { mediaType: "tv_episode", title: "Show Name", season: 1, episode: 1, episodeTitle: "GRP" }],
];

describe("GuessItParser parity with guessit", () => {
  const parser = new GuessItParser();

  it.each(GUESSIT_CASES)("%s", (filename, expected) => {
    // Edition, audio, and HDR are checked in releaseDetails.test.ts.
    const { edition: _e, audioCodec: _a, audioChannels: _c, hdr: _h, ...info } = parser.parse(filename);
    expect(info).toEqual({ ...expected, rawFilename: filename });
  });

  it("covers a broad slice of the corpus", () => {
    expect(GUESSIT_CASES.length).toBeGreaterThanOrEqual(60);
  });
});

/**
 * Cases where guessit is clearly wrong and the TypeScript parser deliberately
 * differs. The guessit value is noted in each comment.
 */
const DELIBERATE_DIFFERENCES: Array<[string, Partial<ParsedInfo>]> = [
  // guessit: title "" ("Us" read as a country code)
  ["Us.2019.1080p.BluRay.x264-SPARKS.mkv", { mediaType: "movie", title: "Us", year: 2019 }],
  // guessit: title "The Last of"
  ["The.Last.of.Us.S01E03.Long.Long.Time.2160p.HMAX.WEB-DL.x265.10bit.HDR.DDP5.1-SMURF.mkv", { title: "The Last of Us", season: 1, episode: 3 }],
  // guessit: tv_episode with episodeTitle "Final Cut" and no season/episode
  ["Blade.Runner.1982.Final.Cut.1080p.BluRay.x264-SPARKS.mkv", { mediaType: "movie", title: "Blade Runner", year: 1982 }],
  // guessit: title "Mob Psycho", episode 100
  ["Mob Psycho 100 - 01 [1080p].mkv", { mediaType: "tv_episode", title: "Mob Psycho 100", episode: 1 }],
  // guessit: title "", year 1923
  ["1923.S01E01.720p.WEB.mkv", { title: "1923", season: 1, episode: 1 }],
  // guessit: title "22", group "Catch"
  ["Catch-22.S01E01.720p.HULU.WEB.mkv", { title: "Catch-22", season: 1, episode: 1 }],
  // guessit: title ""
  ["X2.2003.1080p.BluRay.x264.mkv", { mediaType: "movie", title: "X2", year: 2003 }],
  // guessit: tv_episode "Blade Runner" S2017E2049
  ["Blade Runner 2049 (2017) {imdb-tt1856101} [Remux-2160p].mkv", { mediaType: "movie", title: "Blade Runner 2049", year: 2017 }],
  // guessit: title "Charlotte's", source "Web"
  ["Charlotte's Web (2006).mkv", { mediaType: "movie", title: "Charlotte's Web", year: 2006 }],
];

describe("GuessItParser deliberate differences from guessit", () => {
  const parser = new GuessItParser();

  it.each(DELIBERATE_DIFFERENCES)("%s", (filename, expected) => {
    expect(parser.parse(filename)).toMatchObject(expected);
  });
});

describe("GuessItParser edge cases", () => {
  const parser = new GuessItParser();

  it("always records the raw filename", () => {
    expect(parser.parse("anything.mkv").rawFilename).toBe("anything.mkv");
  });

  it("handles an empty filename", () => {
    expect(parser.parse("")).toEqual({ title: "", mediaType: "movie", rawFilename: "" });
  });

  it("keeps an unknown extension as part of the name", () => {
    expect(parser.parse("Some.Movie.2010.xyz")).toMatchObject({ title: "Some Movie", year: 2010 });
  });

  it("omits absent fields instead of setting them to undefined", () => {
    const result = parser.parse("Coco.mkv");
    expect(Object.keys(result).sort()).toEqual(["mediaType", "rawFilename", "title"]);
  });

  it("is JSON round-trippable", () => {
    const result = parser.parse("Breaking.Bad.S05E16.Felina.1080p.WEB-DL.DD5.1.H.264-BS.mkv");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("takes the first episode of a multi-episode file", () => {
    for (const name of ["Show.S02E03E04.mkv", "Show.S02E03-E04.mkv", "Show.S02E03-04.mkv", "Show.2x03-04.mkv"]) {
      expect(parser.parse(name)).toMatchObject({ title: "Show", season: 2, episode: 3 });
    }
  });

  it("treats lowercase country codes as countries only in all-lowercase names", () => {
    expect(parser.parse("the.office.us.s01e01.mkv").title).toBe("the office");
    expect(parser.parse("The.Office.US.S01E01.mkv").title).toBe("The Office");
  });
});
