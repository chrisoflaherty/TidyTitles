/**
 * Terminal output: results to stdout, progress and prompts to stderr,
 * colors only where they belong.
 */

import Table from "cli-table3";
import pc from "picocolors";

/** Anything with a `write(string)` method (process.stdout, a test buffer). */
export interface Writer {
  write(chunk: string): unknown;
}

export type Colors = ReturnType<typeof pc.createColors>;

export interface UiOptions {
  stdout: Writer;
  stderr: Writer;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  /** False for --no-color. */
  color: boolean;
  env: Record<string, string | undefined>;
  /** Terminal width for the progress line. Default 80. */
  columns?: number;
}

/**
 * Whether to color a stream: never with --no-color or NO_COLOR (any
 * non-empty value); always with FORCE_COLOR (other than "0"); otherwise
 * only on a terminal.
 */
export function colorEnabled(
  streamIsTTY: boolean,
  flag: boolean,
  env: Record<string, string | undefined>,
): boolean {
  if (!flag) return false;
  if (env.NO_COLOR) return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  return streamIsTTY;
}

export class Ui {
  readonly stdout: Writer;
  readonly stderr: Writer;
  /** Colors for text written to stdout. */
  readonly c: Colors;
  /** Colors for text written to stderr. */
  readonly ec: Colors;
  readonly progress: Progress;

  constructor(options: UiOptions) {
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.c = pc.createColors(colorEnabled(options.stdoutIsTTY, options.color, options.env));
    this.ec = pc.createColors(colorEnabled(options.stderrIsTTY, options.color, options.env));
    this.progress = new Progress(
      options.stderr,
      options.stderrIsTTY,
      this.ec,
      options.columns ?? 80,
    );
  }

  /** A line of results on stdout. */
  print(line = ""): void {
    this.progress.clear();
    this.stdout.write(line + "\n");
  }

  /** A line on stderr (errors, prompts, notes that are not results). */
  note(line = ""): void {
    this.progress.clear();
    this.stderr.write(line + "\n");
  }

  /** "Error: message" on stderr. */
  error(message: string): void {
    this.note(`${this.ec.red("Error:")} ${message}`);
  }

  /** Pretty JSON on stdout. */
  json(value: unknown): void {
    this.progress.clear();
    this.stdout.write(JSON.stringify(value, null, 2) + "\n");
  }
}

/**
 * A single updating status line on stderr, shown only when stderr is a
 * terminal. Every other write clears it first.
 */
export class Progress {
  private active = false;

  constructor(
    private readonly stream: Writer,
    private readonly enabled: boolean,
    private readonly colors: Colors,
    private readonly columns: number,
  ) {}

  /** Show a status message, with a "[current/total]" counter when total > 0. */
  update(message: string, current?: number, total?: number): void {
    if (!this.enabled) return;
    const counter = total ? `[${current ?? 0}/${total}] ` : "";
    let text = counter + message;
    const max = Math.max(10, this.columns - 1);
    if (text.length > max) text = text.slice(0, max - 1) + "…";
    this.stream.write(`\r\x1b[2K${this.colors.cyan(text)}`);
    this.active = true;
  }

  /** A `(current, total, message)` callback that updates this line. */
  callback(): (current: number, total: number, message: string) => void {
    return (current, total, message) => this.update(message, current, total);
  }

  /** Remove the status line. */
  clear(): void {
    if (!this.active) return;
    this.stream.write("\r\x1b[2K");
    this.active = false;
  }
}

/** A table with box-drawing borders and no built-in colors (we color cells ourselves). */
export function makeTable(head: string[], colors: Colors): Table.Table {
  return new Table({
    head: head.map((h) => colors.bold(h)),
    style: { head: [], border: [], compact: true },
    wordWrap: false,
  });
}
