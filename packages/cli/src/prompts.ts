/**
 * Prompts. The commands talk to a `Prompter`, so tests can inject answers.
 *
 * The real prompter uses @inquirer/prompts on a terminal. When stdin is not
 * a terminal, a confirmation reads one line from stdin instead (so
 * `echo y | tidytitles rename ...` works, as it did with Click), and end of
 * input counts as an abort. Match selection never prompts without a
 * terminal; the rename command decides what to do instead.
 */

import { createInterface } from "node:readline";
import { CancelledError, PromptEofError, isPromptInterrupt } from "./errors";
import type { Writer } from "./ui";

export interface SelectChoice<T> {
  name: string;
  value: T;
}

export interface Prompter {
  /** Ask a yes/no question. */
  confirm(message: string, options: { default: boolean; signal?: AbortSignal }): Promise<boolean>;
  /** Pick one of `choices` (only called when stdin is a terminal). */
  select<T>(
    message: string,
    choices: SelectChoice<T>[],
    options: { signal?: AbortSignal },
  ): Promise<T>;
  /** Ask for a line of text (only called when stdin is a terminal). */
  input(message: string, options: { default?: string; signal?: AbortSignal }): Promise<string>;
}

export interface RealPrompterOptions {
  stdin: NodeJS.ReadableStream;
  /** Prompts are drawn on stderr so stdout stays clean for results. */
  stderr: NodeJS.WritableStream & Writer;
  stdinIsTTY: boolean;
}

/** Read one line from a non-interactive stream; undefined at end of input. */
function readLine(stdin: NodeJS.ReadableStream, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdin, terminal: false });
    let settled = false;
    const finish = (value: string | undefined, error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(undefined, new CancelledError());
    signal?.addEventListener("abort", onAbort, { once: true });
    rl.once("line", (line) => finish(line));
    rl.once("close", () => finish(undefined));
  });
}

export function createRealPrompter(options: RealPrompterOptions): Prompter {
  const { stdin, stderr, stdinIsTTY } = options;

  const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (isPromptInterrupt(error)) throw new CancelledError();
      throw error;
    }
  };

  return {
    async confirm(message, { default: def, signal }) {
      if (!stdinIsTTY) {
        // Click-style: "Question? [y/N]: ", read a line, blank takes the default.
        stderr.write(`${message} ${def ? "[Y/n]" : "[y/N]"}: `);
        for (;;) {
          const line = await readLine(stdin, signal);
          if (line === undefined) {
            stderr.write("\n");
            throw new PromptEofError();
          }
          const answer = line.trim().toLowerCase();
          if (answer === "") return def;
          if (answer === "y" || answer === "yes") return true;
          if (answer === "n" || answer === "no") return false;
          stderr.write(`Error: invalid input\n${message} ${def ? "[Y/n]" : "[y/N]"}: `);
        }
      }
      const { confirm } = await import("@inquirer/prompts");
      return wrap(() =>
        confirm({ message, default: def }, { input: stdin, output: stderr, signal }),
      );
    },

    async select(message, choices, { signal }) {
      const { select } = await import("@inquirer/prompts");
      return wrap(() =>
        select(
          { message, choices: choices.map((c) => ({ name: c.name, value: c.value })) },
          { input: stdin, output: stderr, signal },
        ),
      );
    },

    async input(message, { default: def, signal }) {
      const { input } = await import("@inquirer/prompts");
      return wrap(() =>
        input({ message, ...(def ? { default: def } : {}) }, { input: stdin, output: stderr, signal }),
      );
    },
  };
}
