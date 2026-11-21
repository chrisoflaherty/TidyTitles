/**
 * Fill in album details a matched track lacks from the file's own tags, so
 * the `{album_artist}`, `{genre}`, `{track_total}`, `{disc_total}`, and
 * `{disc_multi}` placeholders have a value when the tags carry one.
 *
 * Provider values always win; tags only fill gaps.
 */

import { createArtist } from "./models";
import type { ParsedMusicInfo, Track } from "./models";

export function withTagDetails(track: Track, tags: ParsedMusicInfo): Track {
  let out = track;

  if (out.genres.length === 0 && tags.genre) {
    out = { ...out, genres: [tags.genre] };
  }

  const album = out.album;
  if (album) {
    let next = album;
    // An album built from tags has the track artist as its artist; use the
    // album artist tag instead (compilations: "Various Artists").
    if (album.provider === "local" && tags.albumArtist && tags.albumArtist !== album.artist.name) {
      next = { ...next, artist: createArtist({ id: "local", name: tags.albumArtist, provider: "local" }) };
    }
    if (next.totalTracks == null && tags.totalTracks) next = { ...next, totalTracks: tags.totalTracks };
    if (next.totalDiscs == null && tags.totalDiscs) next = { ...next, totalDiscs: tags.totalDiscs };
    if (next !== album) out = { ...out, album: next };
  }

  return out;
}
