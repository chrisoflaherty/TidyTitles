// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/src/App";
import { SettingsDialog } from "../../src/renderer/src/components/SettingsDialog";
import { WatchIndicator } from "../../src/renderer/src/components/WatchIndicator";
import { watchBadge, watchHeadline } from "../../src/renderer/src/watch";
import { EVENTS } from "../../src/shared/ipc";
import { appState, createFakeApi, watchViewState } from "./fixtures";

const watching = watchViewState({
  enabled: true,
  mode: "automatic",
  folders: [{ folder: "/Users/me/Downloads", status: "ok", existing: 2, polling: false }],
  existing: 2,
});

describe("Watch settings", () => {
  it("adds and removes folders, sets the mode and the settle period, and says it runs only while the app is open", async () => {
    const { api } = createFakeApi();
    api.chooseWatchFolder.mockResolvedValueOnce("/Users/me/Downloads").mockResolvedValueOnce("/Volumes/Share/In");
    render(<SettingsDialog onClose={() => {}} onSaved={() => {}} initialTab="watch" />);
    expect(await screen.findByText(/no background service or login item/)).toBeTruthy();
    await userEvent.click(screen.getByTestId("watch-enabled"));
    await userEvent.click(screen.getByTestId("watch-add-folder"));
    await userEvent.click(screen.getByTestId("watch-add-folder"));
    await waitFor(() => expect(within(screen.getByTestId("watch-folders")).getAllByRole("listitem")).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "Stop watching /Volumes/Share/In" }));
    await userEvent.click(screen.getByTestId("watch-mode-automatic"));
    const settle = screen.getByTestId("watch-settle") as HTMLInputElement;
    await userEvent.clear(settle);
    await userEvent.type(settle, "1");
    expect(settle.getAttribute("aria-invalid")).toBe("true");
    await userEvent.clear(settle);
    await userEvent.type(settle, "30");
    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.saveSettings.mock.calls[0]![0].watch).toEqual({
      enabled: true,
      folders: ["/Users/me/Downloads"],
      recursive: true,
      mode: "automatic",
      settleSeconds: 30,
    });
  });
});

describe("Watch indicator", () => {
  it("is hidden while watching was never on", () => {
    const { container } = render(<WatchIndicator state={watchViewState()} unseen={0} onTogglePause={() => {}} onShowActivity={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("shows whether watching is on, what is arriving, and pauses", async () => {
    let paused = 0;
    render(
      <WatchIndicator state={{ ...watching, arriving: 2, waiting: 1 }} unseen={3} onTogglePause={() => (paused += 1)} onShowActivity={() => {}} />,
    );
    expect(screen.getByTestId("watch-headline").textContent).toBe("Watching · Automatic");
    expect(screen.getByTestId("watch-indicator").textContent).toContain("3 arriving");
    expect(screen.getByTestId("watch-unseen").textContent).toBe("3");
    await userEvent.click(screen.getByTestId("watch-pause"));
    expect(paused).toBe(1);
  });

  it("describes paused and missing folders", () => {
    expect(watchHeadline({ ...watching, paused: true })).toEqual({ text: "Watching paused", tone: "paused" });
    expect(watchHeadline({ ...watching, folders: [{ ...watching.folders[0]!, status: "missing" }] }).tone).toBe("problem");
    expect(watchBadge({ ...watching, retrying: 4 })).toBe("4 to retry");
  });
});

describe("main window", () => {
  it("takes waiting files only when a drop would be accepted", async () => {
    const { api, emit } = createFakeApi(appState());
    api.getWatchState.mockResolvedValue({ ...watching, waiting: 0 });
    render(<App />);
    await screen.findByTestId("watch-indicator");
    // A dialog is open: the files wait.
    act(() => emit(EVENTS.state, appState({ busy: "fetching" })));
    act(() => emit(EVENTS.watchState, { ...watching, waiting: 2 }));
    expect(api.takeWatchArrivals).not.toHaveBeenCalled();
    act(() => emit(EVENTS.state, appState({ busy: null })));
    await waitFor(() => expect(api.takeWatchArrivals).toHaveBeenCalledWith(true));
  });

  it("opens the activity log, with processing the existing files", async () => {
    const { api } = createFakeApi(appState());
    api.getWatchState.mockResolvedValue({ ...watching, activityCount: 2 });
    api.getWatchActivity.mockResolvedValue([
      { id: 2, time: Date.UTC(2026, 10, 21, 20, 5), kind: "renamed", path: "/Users/me/Downloads/Inception.2010.mkv", destination: "/Users/me/Downloads/Inception (2010).mkv", text: "Renamed to Inception (2010).mkv" },
      { id: 1, time: Date.UTC(2026, 10, 21, 20, 4), kind: "review", reason: "several_matches", path: "/Users/me/Downloads/The.Matrix.mkv", text: "Waiting for review: several matches found; choose one" },
    ]);
    api.processExistingWatchFiles.mockResolvedValue(2);
    render(<App />);
    await userEvent.click(await screen.findByTestId("watch-activity-open"));
    const dialog = await screen.findByTestId("watch-activity");
    const log = await within(dialog).findByTestId("watch-log");
    expect(within(log).getAllByRole("listitem")).toHaveLength(2);
    expect(log.textContent).toContain("Inception.2010.mkv");
    expect(log.textContent).toMatch(/Nov 21, \d{1,2}:05:00 (AM|PM)/);
    await userEvent.click(within(dialog).getByTestId("watch-filter-review"));
    expect(within(log).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(within(dialog).getByTestId("watch-process-existing"));
    expect(await within(dialog).findByTestId("watch-note")).toBeTruthy();
    expect(api.processExistingWatchFiles).toHaveBeenCalled();
  });
});
