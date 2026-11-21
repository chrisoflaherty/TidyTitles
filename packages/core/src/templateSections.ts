/**
 * Optional sections in templates: `<...>`.
 *
 * The rule:
 *
 * 1. Text between `<` and `>` is an optional section. When none of the
 *    placeholders inside it (including nested sections) has a value, the
 *    whole section disappears, its literal text too. Otherwise the angle
 *    brackets are removed and the rest is kept.
 * 2. Inside a kept section, an empty placeholder leaves no debris: brackets
 *    left with nothing in them are removed, separators (space, `-`, `_`, `.`,
 *    `,`) next to an empty placeholder are dropped where they would touch a
 *    bracket or the edge of the section, and between two values only the
 *    separator before the empty one is kept.
 * 3. Where a section disappears, the spaces around it collapse to one, and
 *    none is left at the start or end of a file or folder name.
 *
 * Templates without `<` and `>` render exactly as before: placeholders
 * without a value become empty text, and the text around them stays. `<`
 * and `>` are invalid in file names on Windows and were always removed from
 * output, so no existing template can rely on them as literal text. A `<` or
 * `>` without a partner stays literal (and is removed by the path cleaning).
 */

import { TemplateEngine } from "./template";

/** Marks where an empty value or a dropped section was. Never in output. */
const GAP = "\uE000";
/** Separators that can be left dangling by an empty value. */
const SEP = "[\\s\\-_.,]";

type Node =
  | { kind: "text"; text: string }
  | { kind: "placeholder"; text: string }
  | { kind: "section"; children: Node[] };

/** True when the template uses optional sections. */
export function hasSections(template: string): boolean {
  return findPairs(lex(template)).size > 0;
}

/** Errors in the section syntax of a template (unmatched `<` or `>`). */
export function sectionErrors(template: string): string[] {
  const tokens = lex(template);
  const pairs = findPairs(tokens);
  const markers = tokens.filter((t) => t.kind === "open" || t.kind === "close").length;
  return markers === pairs.size * 2 ? [] : ["Mismatched < > in template"];
}

/**
 * Render a template with optional sections. `renderPlaceholders` renders a
 * piece of template text without sections (the engine's own rendering).
 */
export function renderSections(template: string, renderPlaceholders: (text: string) => string): string {
  const tree = parse(template);
  const out = renderNodes(tree, renderPlaceholders, false).text;
  return finishTopLevel(out);
}

// ---------------------------------------------------------------------------

interface Lexed {
  kind: "text" | "placeholder" | "open" | "close";
  text: string;
}

function lex(template: string): Lexed[] {
  const tokens: Lexed[] = [];
  const pushText = (text: string) => {
    for (const piece of text.split(/([<>])/)) {
      if (piece === "<") tokens.push({ kind: "open", text: piece });
      else if (piece === ">") tokens.push({ kind: "close", text: piece });
      else if (piece) tokens.push({ kind: "text", text: piece });
    }
  };
  let last = 0;
  for (const match of template.matchAll(TemplateEngine.PLACEHOLDER_PATTERN)) {
    pushText(template.slice(last, match.index));
    tokens.push({ kind: "placeholder", text: match[0] });
    last = match.index + match[0].length;
  }
  pushText(template.slice(last));
  return tokens;
}

/** Matching `<` `>` token indexes: open index -> close index. */
function findPairs(tokens: Lexed[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === "open") stack.push(i);
    else if (t.kind === "close" && stack.length) pairs.set(stack.pop()!, i);
  });
  return pairs;
}

function parse(template: string): Node[] {
  const tokens = lex(template);
  const pairs = findPairs(tokens);
  const build = (from: number, to: number): Node[] => {
    const nodes: Node[] = [];
    for (let i = from; i < to; i++) {
      const t = tokens[i]!;
      const close = t.kind === "open" ? pairs.get(i) : undefined;
      if (close !== undefined) {
        nodes.push({ kind: "section", children: build(i + 1, close) });
        i = close;
      } else if (t.kind === "placeholder") {
        nodes.push({ kind: "placeholder", text: t.text });
      } else {
        nodes.push({ kind: "text", text: t.text });
      }
    }
    return nodes;
  };
  return build(0, tokens.length);
}

interface Rendered {
  text: string;
  /** Some placeholder inside had a value. */
  hasValue: boolean;
  /** Some placeholder inside was rendered at all. */
  hasPlaceholder: boolean;
}

function renderNodes(nodes: Node[], render: (text: string) => string, inSection: boolean): Rendered {
  let text = "";
  let hasValue = false;
  let hasPlaceholder = false;
  for (const node of nodes) {
    if (node.kind === "text") {
      text += node.text;
    } else if (node.kind === "placeholder") {
      hasPlaceholder = true;
      const value = render(node.text).replaceAll(GAP, "");
      if (value) {
        hasValue = true;
        text += value;
      } else {
        // Outside sections an empty value is plain empty text, as always.
        text += inSection ? GAP : "";
      }
    } else {
      const child = renderNodes(node.children, render, true);
      if (child.hasPlaceholder) hasPlaceholder = true;
      if (child.hasValue || !child.hasPlaceholder) {
        if (child.hasValue) hasValue = true;
        text += tidySection(child.text);
      } else {
        text += GAP;
      }
    }
  }
  return { text, hasValue, hasPlaceholder };
}

/** Rule 2: remove the debris an empty value leaves inside a kept section. */
function tidySection(text: string): string {
  if (!text.includes(GAP)) return text;
  const g = `(?:${SEP}|${GAP})*${GAP}(?:${SEP}|${GAP})*`;
  let out = text;
  // Brackets with nothing but separators and gaps inside.
  out = out
    .replace(new RegExp(`\\[${g}\\]`, "gu"), GAP)
    .replace(new RegExp(`\\(${g}\\)`, "gu"), GAP)
    .replace(new RegExp(`\\{${g}\\}`, "gu"), GAP);
  // Separators between an opening bracket and an empty value, or an empty
  // value and a closing bracket.
  out = out.replace(new RegExp(`([\\[({])${g}`, "gu"), "$1");
  out = out.replace(new RegExp(`${g}([\\])}])`, "gu"), "$1");
  // Separators at the edge of the section.
  out = out.replace(new RegExp(`^${g}`, "u"), "").replace(new RegExp(`${g}$`, "u"), "");
  // Between two values: keep the separator before the gap, or else the one after.
  out = out.replace(new RegExp(`(${SEP}*)(?:${GAP})+(${SEP}*)`, "gu"), (_m, before: string, after: string) =>
    before || after,
  );
  return out;
}

/** Rule 3: collapse the spaces around dropped sections at the top level. */
function finishTopLevel(text: string): string {
  if (!text.includes(GAP)) return text;
  return text
    .replace(new RegExp(`(^|/)[ \\t]*(?:${GAP}[ \\t]*)+`, "gu"), "$1")
    .replace(new RegExp(`(?:[ \\t]*${GAP})+[ \\t]*($|/)`, "gu"), "$1")
    .replace(new RegExp(`([ \\t]*)(?:${GAP}[ \\t]*)+`, "gu"), (m: string) => (/[ \t]/.test(m) ? " " : ""))
    .replaceAll(GAP, "");
}
