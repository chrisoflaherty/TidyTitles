import { describe, expect, it } from "vitest";
import type { OperationSummary } from "@tidytitles/core";
import {
  TaskFeedback,
  electronProgressArgs,
  iconProgress,
  renameNotification,
  undoNotification,
  type FeedbackNotification,
  type FeedbackSink,
  type IconProgress,
} from "../../src/main/taskFeedback";
import type { BusyKind, ProgressEvent, RenameOutcome, UndoOutcome } from "../../src/shared/ipc";

class FakeSink implements FeedbackSink {
  progress: IconProgress[] = [];
  notifications: FeedbackNotification[] = [];
  attention = 0;
  focused = true;
  setProgress(progress: IconProgress): void {
    this.progress.push(progress);
  }
  isFocused(): boolean {
    return this.focused;
  }
  notify(notification: FeedbackNotification): void {
    this.notifications.push(notification);
  }
  requestAttention(): void {
    this.attention += 1;
  }
  get last(): IconProgress | undefined {
    return this.progress.at(-1);
  }
}

const progress = (phase: ProgressEvent["phase"], current: number, total: number): ProgressEvent => ({
  phase,
  current,
  total,
  message: "Working: x",
});

function summary(over: Partial<OperationSummary> = {}): OperationSummary {
  return { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0, ...over } as OperationSummary;
}

function renameDone(over: Partial<OperationSummary> = {}, associatedRenamed = 0): RenameOutcome {
  return {
    kind: "done",
    summary: summary(over),
    associatedRenamed,
    coverArtDownloaded: 0,
    coverArtAttempted: false,
    failures: [],
    historySaved: 1,
  };
}

function undoDone(over: Partial<Extract<UndoOutcome, { kind: "done" }>> = {}): UndoOutcome {
  return { kind: "done", historyFound: true, undone: 0, missing: 0, failed: 0, items: [], ...over };
}

describe("iconProgress", () => {
  it("shows nothing when idle or for quick tasks", () => {
    expect(iconProgress(null, null)).toEqual({ kind: "none" });
    for (const busy of ["adding", "saving"] as BusyKind[]) {
      expect(iconProgress(busy, progress("rename", 1, 2))).toEqual({ kind: "none" });
    }
  });

  it("is indeterminate until the first report", () => {
    for (const busy of ["fetching", "renaming", "undoing"] as BusyKind[]) {
      expect(iconProgress(busy, null)).toEqual({ kind: "indeterminate" });
      expect(iconProgress(busy, progress("rename", 0, 0))).toEqual({ kind: "indeterminate" });
    }
  });

  it("counts the items finished before the one being worked on", () => {
    expect(iconProgress("renaming", progress("rename", 1, 4))).toEqual({ kind: "fraction", value: 0 });
    expect(iconProgress("renaming", progress("rename", 3, 4))).toEqual({ kind: "fraction", value: 0.5 });
    expect(iconProgress("undoing", progress("undo", 4, 4))).toEqual({ kind: "fraction", value: 0.75 });
    expect(iconProgress("renaming", progress("coverArt", 2, 2))).toEqual({ kind: "fraction", value: 0.5 });
  });

  it("gives reading a tenth of a fetch and looking up the rest", () => {
    expect(iconProgress("fetching", progress("parse", 1, 10))).toEqual({ kind: "fraction", value: 0 });
    expect(iconProgress("fetching", progress("parse", 6, 10))).toEqual({ kind: "fraction", value: 0.05 });
    expect(iconProgress("fetching", progress("fetch", 1, 10))).toEqual({ kind: "fraction", value: 0.1 });
    const late = iconProgress("fetching", progress("fetch", 10, 10));
    expect(late.kind === "fraction" && late.value).toBeCloseTo(0.91);
  });

  it("stays within 0 and 1 for odd reports", () => {
    expect(iconProgress("renaming", progress("rename", 9, 4))).toEqual({ kind: "fraction", value: 1 });
    expect(iconProgress("renaming", progress("rename", -3, 4))).toEqual({ kind: "fraction", value: 0 });
  });
});

describe("electronProgressArgs", () => {
  it("removes the bar with a negative value", () => {
    expect(electronProgressArgs({ kind: "none" }, "darwin")).toEqual({ value: -1 });
    expect(electronProgressArgs({ kind: "none" }, "win32")).toEqual({ value: -1, mode: "none" });
  });

  it("uses Windows' indeterminate mode, and an empty bar elsewhere", () => {
    expect(electronProgressArgs({ kind: "indeterminate" }, "win32")).toEqual({ value: 2, mode: "indeterminate" });
    expect(electronProgressArgs({ kind: "indeterminate" }, "darwin")).toEqual({ value: 0 });
    expect(electronProgressArgs({ kind: "indeterminate" }, "linux")).toEqual({ value: 0 });
  });

  it("passes fractions through", () => {
    expect(electronProgressArgs({ kind: "fraction", value: 0.4 }, "darwin")).toEqual({ value: 0.4 });
    expect(electronProgressArgs({ kind: "fraction", value: 0.4 }, "win32")).toEqual({ value: 0.4, mode: "normal" });
  });
});

describe("notification text", () => {
  it("reports renamed, failed, skipped, and associated files", () => {
    expect(renameNotification(renameDone({ completed: 1 }))).toEqual({ title: "Rename Complete", body: "Renamed 1 file." });
    expect(renameNotification(renameDone({ completed: 1_204, skipped: 3 }, 2))).toEqual({
      title: "Rename Complete",
      body: "Renamed 1,204 files; 3 skipped, 2 associated files moved.",
    });
    expect(renameNotification(renameDone({ completed: 5, failed: 1, skipped: 2 }))).toEqual({
      title: "Rename Finished with Errors",
      body: "Renamed 5 files; 1 file could not be renamed, 2 skipped.",
    });
  });

  it("reports a failed rename and says nothing for refused ones", () => {
    expect(renameNotification({ kind: "error", message: "Disk full" })).toEqual({
      title: "Couldn’t Rename Files",
      body: "Disk full",
    });
    expect(renameNotification({ kind: "busy" })).toBeNull();
    expect(renameNotification({ kind: "nothing" })).toBeNull();
  });

  it("reports an undo", () => {
    expect(undoNotification(undoDone({ undone: 3 }))).toEqual({ title: "Undo Complete", body: "Restored 3 files." });
    expect(undoNotification(undoDone({ undone: 2, missing: 1, failed: 1 }))).toEqual({
      title: "Undo Finished with Errors",
      body: "Restored 2 files; 1 not found, 1 failed.",
    });
    expect(undoNotification(undoDone({ historyFound: false }))).toEqual({
      title: "Undo Complete",
      body: "There is no rename to undo.",
    });
    expect(undoNotification({ kind: "error", message: "Gone" })).toEqual({ title: "Couldn’t Undo", body: "Gone" });
    expect(undoNotification({ kind: "busy" })).toBeNull();
  });
});

describe("TaskFeedback", () => {
  it("follows a rename and clears the icon when it ends", () => {
    const sink = new FakeSink();
    const feedback = new TaskFeedback(sink);
    feedback.onState({ busy: "renaming" });
    expect(sink.last).toEqual({ kind: "indeterminate" });
    feedback.onProgress(progress("rename", 2, 3));
    expect(sink.last?.kind).toBe("fraction");
    // The controller ends every task with progress null, then state busy null.
    feedback.onProgress(null);
    feedback.onState({ busy: null });
    expect(sink.last).toEqual({ kind: "none" });
  });

  it("clears the icon when a fetch fails or is canceled, even without a final progress event", () => {
    const sink = new FakeSink();
    const feedback = new TaskFeedback(sink);
    feedback.onState({ busy: "fetching" });
    feedback.onProgress(progress("fetch", 3, 5));
    feedback.onState({ busy: null });
    expect(sink.last).toEqual({ kind: "none" });
  });

  it("does not carry one task's progress into the next", () => {
    const sink = new FakeSink();
    const feedback = new TaskFeedback(sink);
    feedback.onState({ busy: "fetching" });
    feedback.onProgress(progress("fetch", 5, 5));
    feedback.onState({ busy: "renaming" });
    expect(sink.last).toEqual({ kind: "indeterminate" });
  });

  it("only calls the sink when the shown progress changes", () => {
    const sink = new FakeSink();
    const feedback = new TaskFeedback(sink);
    feedback.onState({ busy: null });
    feedback.onState({ busy: "adding" });
    feedback.onState({ busy: null });
    expect(sink.progress).toEqual([]);
    feedback.onState({ busy: "renaming" });
    feedback.onState({ busy: "renaming" });
    expect(sink.progress).toHaveLength(1);
  });

  it("shows the current progress again for a new window", () => {
    const sink = new FakeSink();
    const feedback = new TaskFeedback(sink);
    feedback.onState({ busy: "renaming" });
    feedback.onProgress(progress("rename", 2, 3));
    feedback.reapply();
    expect(sink.progress.at(-1)).toEqual(sink.progress.at(-2));
    feedback.reset();
    expect(sink.last).toEqual({ kind: "none" });
  });

  it("notifies only when the window is not focused", () => {
    const sink = new FakeSink();
    const feedback = new TaskFeedback(sink);
    feedback.renameFinished(renameDone({ completed: 2 }));
    feedback.undoFinished(undoDone({ undone: 2 }));
    expect(sink.notifications).toEqual([]);
    sink.focused = false;
    feedback.renameFinished(renameDone({ completed: 2 }));
    feedback.undoFinished(undoDone({ undone: 2 }));
    feedback.renameFinished({ kind: "busy" });
    expect(sink.notifications.map((n) => n.body)).toEqual(["Renamed 2 files.", "Restored 2 files."]);
  });

  it("asks for attention once per question, and only in the background", () => {
    const sink = new FakeSink();
    const feedback = new TaskFeedback(sink);
    feedback.onState({ busy: "fetching" });
    feedback.onSelectionRequest("a");
    expect(sink.attention).toBe(0);
    sink.focused = false;
    feedback.onSelectionRequest("b");
    feedback.onSelectionRequest("b");
    feedback.onSelectionRequest("c");
    expect(sink.attention).toBe(2);
  });
});
