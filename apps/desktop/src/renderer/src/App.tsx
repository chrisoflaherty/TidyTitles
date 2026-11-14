import { useCallback, useEffect, useReducer, useRef, type DragEvent } from "react";
import type { MenuCommand, RunOptions } from "../../shared/ipc";
import { getApi } from "./api";
import { EmptyState } from "./components/EmptyState";
import { FileTable } from "./components/FileTable";
import { Icon } from "./components/Icon";
import { ConfirmDialog, ErrorDialog, RenameResultDialog, UndoResultDialog } from "./components/MessageDialogs";
import { SelectionDialog } from "./components/SelectionDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { OptionsBar, Toolbar } from "./components/Toolbar";
import { UpdateDialog } from "./components/UpdateDialog";
import { UpdateIndicator } from "./components/UpdateIndicator";
import { formatTimestamp, plural } from "./format";
import { availability, initialUiState, reducer } from "./state";

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function App() {
  const api = getApi();
  const [ui, dispatch] = useReducer(reducer, initialUiState);
  const uiRef = useRef(ui);
  uiRef.current = ui;

  // Main-process events.
  useEffect(() => {
    const offs = [
      api.onState((state) => dispatch({ type: "state", state })),
      api.onProgress((progress) => dispatch({ type: "progress", progress })),
      api.onSelectionRequest((request) => dispatch({ type: "selectionRequest", request })),
      api.onSelectionClosed(({ id }) => dispatch({ type: "selectionDone", id })),
      api.onUpdateState((state) => dispatch({ type: "updateState", state })),
    ];
    void api.getState().then((state) => dispatch({ type: "state", state }));
    void api.getUpdateState().then((state) => dispatch({ type: "updateState", state }));
    return () => offs.forEach((off) => off());
  }, [api]);

  useEffect(() => {
    document.documentElement.dataset.platform = api.platform;
  }, [api]);

  const showError = useCallback((title: string, message: string) => {
    dispatch({ type: "openModal", modal: { kind: "error", title, message } });
  }, []);

  // --- actions --------------------------------------------------------------

  const can = () => availability(uiRef.current.app);

  const addFiles = useCallback(() => {
    if (can().add) void api.addFilesDialog("files");
  }, [api]);
  const addFolder = useCallback(() => {
    if (can().add) void api.addFilesDialog("folder");
  }, [api]);
  const clear = useCallback(() => {
    if (can().clear) void api.clearFiles();
  }, [api]);
  const cancelFetch = useCallback(() => {
    void api.cancelFetch();
  }, [api]);
  const fetchMetadata = useCallback(async () => {
    if (!can().fetch) return;
    const outcome = await api.fetch();
    if (outcome.kind === "error") showError("Couldn’t Fetch Metadata", outcome.message);
  }, [api, showError]);
  const askRename = useCallback(() => {
    if (can().rename) dispatch({ type: "openModal", modal: { kind: "confirmRename" } });
  }, []);
  const askUndo = useCallback(() => {
    if (can().undo) dispatch({ type: "openModal", modal: { kind: "confirmUndo" } });
  }, []);
  const openSettings = useCallback(() => {
    if (can().settings) dispatch({ type: "openModal", modal: { kind: "settings" } });
  }, []);
  const setOptions = useCallback((options: Partial<RunOptions>) => void api.setOptions(options), [api]);
  // Stable, so the (memoized) file list skips renders that only change the progress.
  const selectFile = useCallback((id: number | null) => dispatch({ type: "selectFile", id }), []);
  const removeFiles = useCallback((ids: number[]) => void api.removeFiles(ids), [api]);

  // --- updates --------------------------------------------------------------

  /** "Check for Updates…": the dialog shows the outcome; behind another dialog, the status bar does. */
  const checkForUpdates = useCallback(() => {
    const { modal, selection, updates } = uiRef.current;
    if (!modal && !selection) {
      dispatch({ type: "openModal", modal: { kind: "updates", sinceCheckId: updates?.checkId ?? 0 } });
    }
    void api.checkForUpdates();
  }, [api]);
  const showUpdateDetails = useCallback(() => {
    const { modal, selection, updates } = uiRef.current;
    if (modal || selection) return;
    dispatch({ type: "openModal", modal: { kind: "updates", sinceCheckId: (updates?.checkId ?? 1) - 1 } });
  }, []);
  const closeUpdates = useCallback(() => {
    dispatch({ type: "closeModal" });
    dispatch({ type: "dismissUpdateNote" });
  }, []);
  const doRestart = useCallback(async () => {
    dispatch({ type: "closeModal" });
    await api.restartToUpdate();
  }, [api]);
  /** Restart only when idle; confirm first when the list would be cleared. */
  const askRestart = useCallback(() => {
    const { app: current, selection } = uiRef.current;
    if (!current || current.busy !== null || selection) return;
    if (current.files.length > 0) dispatch({ type: "openModal", modal: { kind: "confirmRestart" } });
    else void doRestart();
  }, [doRestart]);
  const openReleasePage = useCallback(() => void api.openReleasePage(), [api]);

  const doRename = async () => {
    dispatch({ type: "closeModal" });
    const outcome = await api.rename();
    if (outcome.kind === "done") dispatch({ type: "openModal", modal: { kind: "renameResult", outcome } });
    else if (outcome.kind === "error") showError("Couldn’t Rename Files", outcome.message);
  };

  const doUndo = async () => {
    dispatch({ type: "closeModal" });
    const outcome = await api.undo();
    if (outcome.kind === "done") dispatch({ type: "openModal", modal: { kind: "undoResult", outcome } });
    else if (outcome.kind === "error") showError("Couldn’t Undo", outcome.message);
  };

  // --- menu commands and keys -----------------------------------------------

  useEffect(() => {
    const run: Record<MenuCommand, () => void> = {
      addFiles,
      addFolder,
      clear,
      fetch: () => void fetchMetadata(),
      cancelFetch,
      rename: askRename,
      undo: askUndo,
      settings: openSettings,
      checkForUpdates,
    };
    return api.onMenuCommand((command) => {
      const { modal, selection } = uiRef.current;
      // A dialog is in front: only "stop fetching" and "check for updates" still apply.
      if ((modal || selection) && command !== "cancelFetch" && command !== "checkForUpdates") return;
      run[command]();
    });
  }, [api, addFiles, addFolder, clear, fetchMetadata, cancelFetch, askRename, askUndo, openSettings, checkForUpdates]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { modal, selection, app } = uiRef.current;
      if (event.key === "Escape" && !modal && !selection && app?.busy === "fetching") {
        event.preventDefault();
        cancelFetch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelFetch]);

  // --- drag and drop --------------------------------------------------------

  const canDrop = () => uiRef.current.app?.busy === null && !uiRef.current.modal && !uiRef.current.selection;

  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dispatch({ type: "dragEnter" });
  };
  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dispatch({ type: "dragLeave" });
  };
  // Files opened with the app (Dock, Finder's Open With, the command line)
  // follow the drop rules: main adds them when a drop would be accepted now
  // and refuses them otherwise.
  const loaded = ui.app !== null;
  useEffect(() => {
    if (!loaded) return;
    const take = () => void api.takeOpenedPaths(canDrop());
    const off = api.onPathsOpened(take);
    take();
    return off;
  }, [api, loaded]);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dispatch({ type: "dragEnd" });
    if (!canDrop()) return;
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => api.pathForFile(file))
      .filter((p) => p !== "");
    if (paths.length > 0) void api.addPaths(paths);
  };

  // --- render ---------------------------------------------------------------

  const { app } = ui;
  if (!app) return <div className="app app-loading" aria-busy="true" />;

  const ops = app.operations ?? [];
  const ready = ops.filter((op) => op.status === "pending");
  const assocCount = ready.reduce((n, op) => n + op.associatedFiles.length, 0);
  const skipped = ops.filter((op) => op.status === "skipped").length;
  const dragging = ui.dragDepth > 0;

  return (
    <div className="app" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="chrome">
        <Toolbar
          app={app}
          handlers={{
            onAddFiles: addFiles,
            onAddFolder: addFolder,
            onClear: clear,
            onSettings: openSettings,
            onUndo: askUndo,
            onFetch: () => void fetchMetadata(),
            onCancelFetch: cancelFetch,
            onRename: askRename,
            onOptions: setOptions,
          }}
        />
        <OptionsBar app={app} onOptions={setOptions} />
      </header>

      <main className="content" aria-busy={app.busy !== null}>
        {app.configError && app.files.length > 0 && (
          <p className="notice tone-danger banner" role="alert">
            <Icon name="alert" size={14} />
            <span>{app.configError}</span>
          </p>
        )}
        {app.files.length === 0 ? (
          <EmptyState app={app} onAddFiles={addFiles} onAddFolder={addFolder} onSettings={openSettings} />
        ) : (
          <FileTable
            app={app}
            selectedFileId={ui.selectedFileId}
            onSelect={selectFile}
            onRemove={removeFiles}
          />
        )}
        {dragging && (
          <div className={`drop-overlay${canDrop() ? "" : " is-blocked"}`} aria-hidden="true">
            <div className="drop-card">
              <Icon name="drop" size={28} />
              <span>{canDrop() ? "Drop files or folders to add them" : "Wait for the current task to finish"}</span>
            </div>
          </div>
        )}
      </main>

      <StatusBar
        app={app}
        progress={ui.progress}
        onCancelFetch={cancelFetch}
        updates={
          <UpdateIndicator
            state={ui.updates}
            busy={app.busy !== null}
            dialogOpen={ui.modal?.kind === "updates"}
            dismissedCheckId={ui.dismissedCheckId}
            onRestart={askRestart}
            onOpenReleasePage={openReleasePage}
            onShowDetails={showUpdateDetails}
            onDismiss={() => dispatch({ type: "dismissUpdateNote" })}
          />
        }
      />

      {ui.selection && (
        <SelectionDialog
          key={ui.selection.id}
          request={ui.selection}
          onSelect={(index) => {
            const id = ui.selection!.id;
            dispatch({ type: "selectionDone", id });
            void api.answerSelection(id, index);
          }}
          onSkip={() => {
            const id = ui.selection!.id;
            dispatch({ type: "selectionDone", id });
            void api.answerSelection(id, null);
          }}
          onCancelAll={() => {
            dispatch({ type: "selectionDone", id: ui.selection!.id });
            cancelFetch();
          }}
        />
      )}

      {ui.modal?.kind === "settings" && (
        <SettingsDialog
          updates={ui.updates}
          onClose={() => dispatch({ type: "closeModal" })}
          onSaved={() => dispatch({ type: "closeModal" })}
        />
      )}
      {ui.modal?.kind === "updates" && ui.updates && (
        <UpdateDialog
          state={ui.updates}
          sinceCheckId={ui.modal.sinceCheckId}
          busy={app.busy !== null}
          onClose={closeUpdates}
          onRestart={askRestart}
          onOpenReleasePage={openReleasePage}
          onCheckAgain={() => {
            dispatch({ type: "openModal", modal: { kind: "updates", sinceCheckId: ui.updates?.checkId ?? 0 } });
            void api.checkForUpdates();
          }}
        />
      )}
      {ui.modal?.kind === "confirmRestart" && ui.updates?.status.kind === "ready" && (
        <ConfirmDialog
          title="Restart to Update?"
          confirmLabel="Restart to Update"
          onConfirm={() => void doRestart()}
          onCancel={() => dispatch({ type: "closeModal" })}
          testId="confirm-restart"
        >
          <p>
            TidyTitles will quit, install version {ui.updates.status.version}, and open again. The file list will be
            cleared.
          </p>
          {ready.length > 0 && app.plan === "planned" && (
            <p className="muted">The new names you fetched haven’t been applied yet. Rename the files first to keep them.</p>
          )}
        </ConfirmDialog>
      )}
      {ui.modal?.kind === "confirmRename" && (
        <ConfirmDialog
          title="Rename Files?"
          confirmLabel={`Rename ${plural(ready.length, "File")}`}
          onConfirm={() => void doRename()}
          onCancel={() => dispatch({ type: "closeModal" })}
          testId="confirm-rename"
        >
          <p>
            {plural(ready.length, "file")} will get their new names
            {assocCount > 0 ? `, and ${plural(assocCount, "associated file")} will move with them` : ""}.
          </p>
          {skipped > 0 && <p className="muted">{plural(skipped, "skipped file")} will stay as they are.</p>}
          {app.options.coverArt && <p className="muted">Cover art will be downloaded afterward.</p>}
          <p className="muted small">You can undo this afterward.</p>
        </ConfirmDialog>
      )}
      {ui.modal?.kind === "confirmUndo" && app.lastRename && (
        <ConfirmDialog
          title="Undo Last Rename?"
          confirmLabel="Undo Rename"
          onConfirm={() => void doUndo()}
          onCancel={() => dispatch({ type: "closeModal" })}
          testId="confirm-undo"
        >
          <p>
            Move {plural(app.lastRename.operations, "file")}
            {app.lastRename.files > app.lastRename.operations ? ` (${plural(app.lastRename.files, "file")} including associated files)` : ""} back to
            their original names.
          </p>
          <p className="muted">Renamed {formatTimestamp(app.lastRename.timestamp)}.</p>
        </ConfirmDialog>
      )}
      {ui.modal?.kind === "renameResult" && (
        <RenameResultDialog outcome={ui.modal.outcome} onClose={() => dispatch({ type: "closeModal" })} />
      )}
      {ui.modal?.kind === "undoResult" && (
        <UndoResultDialog outcome={ui.modal.outcome} onClose={() => dispatch({ type: "closeModal" })} />
      )}
      {ui.modal?.kind === "error" && (
        <ErrorDialog title={ui.modal.title} message={ui.modal.message} onClose={() => dispatch({ type: "closeModal" })} />
      )}
    </div>
  );
}
