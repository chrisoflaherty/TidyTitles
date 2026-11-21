/**
 * New file names typed by the user.
 *
 * A typed name replaces only the file name the template produced: folders
 * the template creates stay, and the extension is always the original
 * file's. A name is accepted only when it is one the app's own sanitizing
 * (`TemplateEngine.cleanPath`) would let through unchanged, and that works
 * on every OS the app runs on.
 */

import path from "node:path";
import { TemplateEngine } from "./template";

/** Why a typed name was refused. */
export type FileNameProblem =
  /** Nothing but spaces. */
  | "empty"
  /** A path separator, or a character Windows does not allow (`<>:"/\|?*`, control characters). */
  | "invalid_characters"
  /** Only dots (".", ".."). */
  | "dots_only"
  /** A Windows device name such as CON, NUL, COM1. */
  | "reserved"
  /** Ends with a dot or a space, which Windows removes. */
  | "trailing"
  /** Longer than 255 bytes with the extension. */
  | "too_long";

export type FileNameCheck =
  | { ok: true; name: string }
  | { ok: false; problem: FileNameProblem; message: string };

/** The longest file name (in UTF-8 bytes) most file systems allow. */
export const MAX_FILE_NAME_BYTES = 255;

/** TemplateEngine.INVALID_CHARS without the global flag (so `test` keeps no state). */
const INVALID = new RegExp(TemplateEngine.INVALID_CHARS.source, "u");
const DOTS_ONLY = /^[.\s]*$/u;
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

const MESSAGES: Record<FileNameProblem, string> = {
  empty: "Type a name.",
  invalid_characters: 'A name can’t contain / \\ : * ? " < > | or control characters.',
  dots_only: "A name can’t be only dots.",
  reserved: "That name is reserved by Windows. Choose another one.",
  trailing: "A name can’t end with a dot or a space.",
  too_long: "That name is too long.",
};

/**
 * Check a typed name (without its extension). Spaces around it are
 * removed, and so is the file's extension if the user typed it too.
 *
 * @param extension The file's extension with its dot (".mkv"), or "".
 */
export function checkFileName(typed: string, extension: string): FileNameCheck {
  let name = typed.trim();
  if (extension && name.toLowerCase().endsWith(extension.toLowerCase())) {
    name = name.slice(0, name.length - extension.length).trimEnd();
  }
  const fail = (problem: FileNameProblem): FileNameCheck => ({ ok: false, problem, message: MESSAGES[problem] });

  if (name === "") return fail("empty");
  if (INVALID.test(name)) return fail("invalid_characters");
  if (DOTS_ONLY.test(name)) return fail("dots_only");
  const full = name + extension;
  if (RESERVED.test(full.split(".")[0]!.trimEnd())) return fail("reserved");
  if (/[.\s]$/u.test(full)) return fail("trailing");
  if (Buffer.byteLength(full, "utf8") > MAX_FILE_NAME_BYTES) return fail("too_long");
  return { ok: true, name };
}

/**
 * Replace the file name in a rendered relative path (which may include
 * folders, as music templates do) with `name` plus `extension`.
 */
export function applyCustomName(rendered: string, name: string, extension: string): string {
  const slash = rendered.lastIndexOf("/");
  const folders = slash >= 0 ? rendered.slice(0, slash + 1) : "";
  return `${folders}${name}${extension}`;
}

/** The base name of `file` without `extension` (when it ends with it). */
export function stemWithout(file: string, extension: string): string {
  const base = path.basename(file);
  return extension && base.endsWith(extension) ? base.slice(0, base.length - extension.length) : base;
}
