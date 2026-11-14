#!/usr/bin/env node
/** Entry point: run the CLI with the real process streams, environment, and prompts. */

import path from "node:path";
import { EXIT_CANCELLED } from "./errors";
import { runCli } from "./program";
import { createRealPrompter } from "./prompts";

const argv = process.argv.slice(2);

// Prompts (@inquirer/prompts) read NO_COLOR themselves.
if (argv.includes("--no-color")) process.env.NO_COLOR = "1";

// First Ctrl+C: cancel cleanly (exit 130 once the current step stops).
// Second Ctrl+C: exit at once.
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(EXIT_CANCELLED);
  controller.abort();
});

const invokedAs = path.basename(process.argv[1] ?? "");
const programName = invokedAs === "file-renamer" ? "file-renamer" : "tidytitles";

const code = await runCli(argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTTY: process.stdout.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  stdinIsTTY: process.stdin.isTTY === true,
  columns: process.stderr.columns || process.stdout.columns || 80,
  env: process.env,
  prompter: createRealPrompter({
    stdin: process.stdin,
    stderr: process.stderr,
    stdinIsTTY: process.stdin.isTTY === true,
  }),
  signal: controller.signal,
  programName,
});

// Exit explicitly so a canceled in-flight request does not keep the process alive,
// but only after stdout has drained (large --json output into a pipe).
process.exitCode = code;
process.stdout.write("", () => process.exit(code));
