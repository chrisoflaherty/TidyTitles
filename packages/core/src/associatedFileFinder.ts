/**
 * `findAssociatedFiles` for many media files at once.
 *
 * `findAssociatedFiles` lists the media file's folder and checks every name
 * in it, so planning n files in one folder costs n listings of n names. A
 * finder lists each folder once and finds the dotted variants (movie.en.srt)
 * with a prefix search over the sorted names. Results are the same as
 * `findAssociatedFiles`, in the same order (see the test). The listing is
 * taken once per finder, so use one finder per plan.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getFileType, pathStem, pathSuffix, type AssociatedFile } from "./associatedFiles";

interface FolderIndex {
  /** Names in listing order. */
  names: string[];
  /** Indexes into `names`, sorted by the names' stems. */
  byStem: number[];
  stems: string[];
}

async function indexFolder(dir: string): Promise<FolderIndex> {
  let names: string[] = [];
  if (existsSync(dir)) {
    try {
      names = await readdir(dir);
    } catch {
      names = [];
    }
  }
  const stems = names.map((name) => pathStem(name));
  const byStem = names.map((_, i) => i).sort((a, b) => (stems[a]! < stems[b]! ? -1 : stems[a]! > stems[b]! ? 1 : a - b));
  return { names, byStem, stems };
}

export class AssociatedFileFinder {
  private readonly folders = new Map<string, Promise<FolderIndex>>();

  private folder(dir: string): Promise<FolderIndex> {
    let index = this.folders.get(dir);
    if (!index) {
      index = indexFolder(dir);
      this.folders.set(dir, index);
    }
    return index;
  }

  /** Same as `findAssociatedFiles(mediaPath, extensions)`. */
  async find(mediaPath: string, extensions: ReadonlySet<string>): Promise<AssociatedFile[]> {
    const media = path.normalize(mediaPath);
    const baseName = pathStem(media);
    const parentDir = path.dirname(media);
    const associated: AssociatedFile[] = [];

    // Files with the same base name (existence follows the filesystem's case rules).
    for (const ext of extensions) {
      const potential = path.join(parentDir, `${baseName}${ext}`);
      if (potential !== media && existsSync(potential)) {
        associated.push({ path: potential, fileType: getFileType(potential) });
      }
    }

    // Dotted variants: names whose stem starts with "<baseName>.", in listing order.
    const { names, byStem, stems } = await this.folder(parentDir);
    const prefix = `${baseName}.`;
    let lo = 0;
    let hi = byStem.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (stems[byStem[mid]!]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    const matches: number[] = [];
    for (let k = lo; k < byStem.length && stems[byStem[k]!]!.startsWith(prefix); k++) matches.push(byStem[k]!);
    matches.sort((a, b) => a - b);

    for (const i of matches) {
      const file = path.join(parentDir, names[i]!);
      if (file === media || associated.some((a) => a.path === file)) continue;
      if (extensions.has(pathSuffix(file).toLowerCase())) {
        associated.push({ path: file, fileType: getFileType(file) });
      }
    }
    return associated;
  }
}
