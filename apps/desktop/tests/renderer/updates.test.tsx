// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/App";
import { SettingsDialog } from "../../src/renderer/src/components/SettingsDialog";
import { UpdateDialog, type UpdateDialogProps } from "../../src/renderer/src/components/UpdateDialog";
import { UpdateIndicator, type UpdateIndicatorProps } from "../../src/renderer/src/components/UpdateIndicator";
import { dialogStatus, updateSummary } from "../../src/renderer/src/updates";
import { EVENTS, type UpdateState } from "../../src/shared/ipc";
import { appState, createFakeApi, file, updateState } from "./fixtures";

const NEW = "0.2.0-beta.3";

function indicator(state: UpdateState | null, over: Partial<UpdateIndicatorProps> = {}) {
  const props: UpdateIndicatorProps = {
    state,
    busy: false,
    dialogOpen: false,
    dismissedCheckId: 0,
    onRestart: vi.fn(),
    onOpenReleasePage: vi.fn(),
    onShowDetails: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  render(<UpdateIndicator {...props} />);
  return props;
}

function dialog(state: UpdateState, over: Partial<UpdateDialogProps> = {}) {
  createFakeApi();
  const props: UpdateDialogProps = {
    state,
    sinceCheckId: 0,
    busy: false,
    onClose: vi.fn(),
    onRestart: vi.fn(),
    onOpenReleasePage: vi.fn(),
    onCheckAgain: vi.fn(),
    ...over,
  };
  render(<UpdateDialog {...props} />);
  return props;
}

describe("UpdateIndicator (status bar)", () => {
  it("shows nothing while idle or for automatic checks", () => {
    const { container } = render(
      <UpdateIndicator state={updateState({ status: { kind: "checking" }, checkId: 1 })} busy={false} dialogOpen={false} dismissedCheckId={0} onRestart={() => {}} onOpenReleasePage={() => {}} onShowDetails={() => {}} onDismiss={() => {}} />,
    );
    expect(container.textContent).toBe("");
    indicator(updateState());
    expect(screen.queryByTestId("update-indicator")).toBeNull();
  });

  it("shows download progress and opens the details", async () => {
    const props = indicator(updateState({ status: { kind: "downloading", version: NEW, percent: 42 } }));
    const el = screen.getByTestId("update-indicator");
    expect(el.textContent).toContain("Downloading update");
    expect(el.textContent).toContain("42%");
    await userEvent.click(el);
    expect(props.onShowDetails).toHaveBeenCalled();
  });

  it("offers Restart to Update when ready, disabled while a task runs", async () => {
    const props = indicator(updateState({ status: { kind: "ready", version: NEW } }));
    expect(screen.getByTestId("update-indicator").textContent).toContain("Update ready");
    await userEvent.click(screen.getByTestId("update-indicator-restart"));
    expect(props.onRestart).toHaveBeenCalledTimes(1);
  });

  it("disables the restart while busy", () => {
    indicator(updateState({ status: { kind: "ready", version: NEW } }), { busy: true });
    const button = screen.getByTestId("update-indicator-restart") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/when the current task finishes/);
  });

  it("offers Download when this copy cannot install the update", async () => {
    const props = indicator(updateState({ status: { kind: "unsupported", version: NEW, reason: "unsigned" }, capability: { kind: "manual", reason: "unsigned" } }));
    expect(screen.getByTestId("update-indicator").textContent).toContain(`TidyTitles ${NEW} is available`);
    await userEvent.click(screen.getByTestId("update-indicator-download"));
    expect(props.onOpenReleasePage).toHaveBeenCalled();
  });

  it("shows the outcome of a manual check until it is dismissed", async () => {
    const upToDate = updateState({ status: { kind: "upToDate" }, manual: true, checkId: 3 });
    const props = indicator(upToDate, { dismissedCheckId: 2 });
    expect(screen.getByTestId("update-indicator").textContent).toContain("TidyTitles 0.2.0-beta.2 is up to date");
    await userEvent.click(screen.getByTestId("update-dismiss"));
    expect(props.onDismiss).toHaveBeenCalled();
  });

  it("hides a manual outcome that was dismissed or is shown in the dialog", () => {
    indicator(updateState({ status: { kind: "upToDate" }, manual: true, checkId: 3 }), { dismissedCheckId: 3 });
    expect(screen.queryByTestId("update-indicator")).toBeNull();
    indicator(updateState({ status: { kind: "error", error: "offline" }, manual: true, checkId: 4 }), { dialogOpen: true });
    expect(screen.queryByTestId("update-indicator")).toBeNull();
  });

  it("explains a failed manual check through Details", async () => {
    const props = indicator(updateState({ status: { kind: "error", error: "offline" }, manual: true, checkId: 1 }));
    expect(screen.getByTestId("update-indicator").textContent).toContain("Couldn’t check for updates");
    await userEvent.click(screen.getByTestId("update-indicator-details"));
    expect(props.onShowDetails).toHaveBeenCalled();
  });
});

describe("UpdateDialog", () => {
  it("shows checking until the check it started reports", () => {
    // An old result (checkId 1) while the dialog waits for check 2.
    dialog(updateState({ status: { kind: "upToDate" }, manual: true, checkId: 1 }), { sinceCheckId: 1 });
    expect(screen.getByTestId("update-dialog").textContent).toContain("Checking for updates…");
  });

  it("says when TidyTitles is up to date, with the current version", () => {
    dialog(updateState({ status: { kind: "upToDate" }, manual: true, checkId: 2 }), { sinceCheckId: 1 });
    const text = screen.getByTestId("update-dialog").textContent!;
    expect(text).toContain("TidyTitles is up to date.");
    expect(text).toContain("You have version 0.2.0-beta.2");
  });

  it("shows download progress", () => {
    dialog(updateState({ status: { kind: "downloading", version: NEW, percent: 7 }, checkId: 1 }), { sinceCheckId: 1 });
    expect(screen.getByTestId("update-dialog").textContent).toContain(`Downloading TidyTitles ${NEW}…`);
    expect(screen.getByTestId("update-percent").textContent).toBe("7%");
  });

  it("restarts when ready, and only when idle", async () => {
    const props = dialog(updateState({ status: { kind: "ready", version: NEW }, checkId: 1 }));
    await userEvent.click(screen.getByTestId("update-restart"));
    expect(props.onRestart).toHaveBeenCalled();
  });

  it("waits for the current task before restarting", () => {
    dialog(updateState({ status: { kind: "ready", version: NEW }, checkId: 1 }), { busy: true });
    expect((screen.getByTestId("update-restart") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("update-dialog").textContent).toContain("You can restart when the current task finishes.");
  });

  it("explains why this copy cannot update itself and offers Download", async () => {
    const props = dialog(
      updateState({ status: { kind: "unsupported", version: NEW, reason: "unsigned" }, capability: { kind: "manual", reason: "unsigned" }, checkId: 2 }),
      { sinceCheckId: 1 },
    );
    const text = screen.getByTestId("update-dialog").textContent!;
    expect(text).toContain(`TidyTitles ${NEW} is available.`);
    expect(text).toContain("isn’t signed with an Apple Developer ID");
    await userEvent.click(screen.getByTestId("update-download"));
    expect(props.onOpenReleasePage).toHaveBeenCalled();
  });

  it("reports a failed check in plain words, with the releases page and Try Again", async () => {
    const props = dialog(updateState({ status: { kind: "error", error: "offline" }, manual: true, checkId: 2 }), { sinceCheckId: 1 });
    const text = screen.getByTestId("update-dialog").textContent!;
    expect(text).toContain("Couldn’t check for updates.");
    expect(text).toContain("Check your internet connection");
    expect(text).not.toMatch(/net::|ERR_|Error:/);
    await userEvent.click(screen.getByTestId("update-download"));
    expect(props.onOpenReleasePage).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("update-retry"));
    expect(props.onCheckAgain).toHaveBeenCalled();
  });

  it("says when updates are off", () => {
    dialog(updateState({ capability: { kind: "off", reason: "development" }, manual: true }));
    expect(screen.getByTestId("update-dialog").textContent).toContain("This is a development build.");
  });
});

describe("update wording", () => {
  it("picks what the dialog shows", () => {
    expect(dialogStatus(updateState({ checkId: 4, status: { kind: "upToDate" } }), 4)).toEqual({ kind: "checking" });
    expect(dialogStatus(updateState({ checkId: 5, status: { kind: "upToDate" } }), 4)).toEqual({ kind: "upToDate" });
    expect(dialogStatus(updateState({ checkId: 4, status: { kind: "ready", version: NEW } }), 4)).toEqual({ kind: "ready", version: NEW });
    expect(dialogStatus(updateState({ capability: { kind: "off", reason: "test" } }), 0)).toEqual({ kind: "off" });
  });

  it("summarizes the state for the settings tab", () => {
    expect(updateSummary(updateState())).toMatch(/download in the background/);
    expect(updateSummary(updateState({ capability: { kind: "manual", reason: "notAppImage" } }))).toMatch(/AppImage/);
    expect(updateSummary(updateState({ status: { kind: "downloading", version: NEW, percent: 1234 } }))).toContain("1,234%");
  });
});

describe("App: update flow", () => {
  async function renderApp(over: Parameters<typeof appState>[0] = {}, updates = updateState()) {
    const { api, emit } = createFakeApi(appState(over), updates);
    render(<App />);
    await screen.findByTestId("status-message");
    await waitFor(() => expect(api.getUpdateState).toHaveBeenCalled());
    return { api, emit };
  }

  it("opens the dialog from the menu, starts a manual check, and follows the state", async () => {
    const { api, emit } = await renderApp();
    act(() => emit(EVENTS.menuCommand, "checkForUpdates"));
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("update-dialog").textContent).toContain("Checking for updates…");

    act(() => emit(EVENTS.updateState, updateState({ status: { kind: "checking" }, manual: true, checkId: 1 })));
    act(() => emit(EVENTS.updateState, updateState({ status: { kind: "downloading", version: NEW, percent: 30 }, manual: true, checkId: 1 })));
    expect(screen.getByTestId("update-percent").textContent).toBe("30%");
    // The status bar shows the download too.
    expect(screen.getByTestId("update-indicator").dataset.status).toBe("downloading");

    act(() => emit(EVENTS.updateState, updateState({ status: { kind: "ready", version: NEW }, manual: true, checkId: 1 })));
    await userEvent.click(screen.getByTestId("update-restart"));
    expect(api.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it("confirms before restarting when files are in the list", async () => {
    const { api } = await renderApp({ files: [file(1, "The.Matrix.1999.mkv")] }, updateState({ status: { kind: "ready", version: NEW } }));
    await userEvent.click(screen.getByTestId("update-indicator-restart"));
    expect(api.restartToUpdate).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("confirm-restart");
    expect(confirm.textContent).toContain("The file list will be cleared.");
    await userEvent.click(screen.getByTestId("confirm"));
    expect(api.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not offer a restart while a fetch runs", async () => {
    await renderApp({ busy: "fetching", files: [file(1, "a.mkv")] }, updateState({ status: { kind: "ready", version: NEW } }));
    expect((screen.getByTestId("update-indicator-restart") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a manual check in the status bar when another dialog is open", async () => {
    const { api, emit } = await renderApp();
    act(() => emit(EVENTS.menuCommand, "settings"));
    await screen.findByTestId("settings-dialog");
    act(() => emit(EVENTS.menuCommand, "checkForUpdates"));
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("update-dialog")).toBeNull();
    act(() => emit(EVENTS.updateState, updateState({ status: { kind: "upToDate" }, manual: true, checkId: 1 })));
    expect(screen.getByTestId("update-indicator").dataset.status).toBe("upToDate");
  });

  it("opens the release page from Download", async () => {
    const { api } = await renderApp({}, updateState({ status: { kind: "unsupported", version: NEW, reason: "unsigned" }, capability: { kind: "manual", reason: "unsigned" } }));
    await userEvent.click(screen.getByTestId("update-indicator-download"));
    expect(api.openReleasePage).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsDialog: Updates tab", () => {
  it("saves Check for updates automatically with the other settings", async () => {
    const { api } = createFakeApi();
    const onSaved = vi.fn();
    render(<SettingsDialog updates={updateState({ autoCheck: true })} onClose={() => {}} onSaved={onSaved} />);
    await userEvent.click(await screen.findByTestId("settings-tab-updates"));
    expect(screen.getByTestId("current-version").textContent).toBe("0.2.0-beta.2");
    const box = screen.getByTestId("auto-update") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(api.setAutoCheckForUpdates).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setAutoCheckForUpdates).toHaveBeenCalledWith(false);
  });

  it("leaves the setting alone when it did not change, and disables it when updates are off", async () => {
    const { api } = createFakeApi();
    const onSaved = vi.fn();
    render(<SettingsDialog updates={updateState({ capability: { kind: "off", reason: "development" } })} onClose={() => {}} onSaved={onSaved} />);
    await userEvent.click(await screen.findByTestId("settings-tab-updates"));
    expect((screen.getByTestId("auto-update") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("update-summary").textContent).toContain("development build");
    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setAutoCheckForUpdates).not.toHaveBeenCalled();
  });
});
