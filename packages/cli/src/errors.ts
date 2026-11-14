/** Errors the CLI raises for itself, each mapped to an exit code in `runCli`. */

/** Exit codes. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Bad command-line usage (Click's exit code for usage errors). */
export const EXIT_USAGE = 2;
/** Interrupted by Ctrl+C (128 + SIGINT). */
export const EXIT_CANCELLED = 130;

/** The user canceled with Ctrl+C (during a fetch or a prompt). */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** Bad command-line usage: printed as "Error: ..." and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * A confirmation read from a non-interactive stdin hit end of input.
 * Printed as "Aborted!" and exits 1, as Click does.
 */
export class PromptEofError extends Error {
  constructor() {
    super("Aborted!");
    this.name = "PromptEofError";
  }
}

/** True for the errors @inquirer/prompts throws when a prompt is interrupted. */
export function isPromptInterrupt(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ExitPromptError" ||
    error.name === "AbortPromptError" ||
    error.name === "CancelPromptError"
  );
}

/** Reject with CancelledError as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new CancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
