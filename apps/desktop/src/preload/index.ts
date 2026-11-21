/**
 * Preload (sandboxed): exposes a narrow, typed API as `window.tidytitles`.
 * `ipcRenderer` itself is never exposed; each method maps to one channel.
 */

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { EVENTS, IPC, type EventPayloads, type TidyTitlesApi } from "../shared/ipc";

function subscribe<K extends keyof EventPayloads>(
  channel: K,
  listener: (payload: EventPayloads[K]) => void,
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: EventPayloads[K]) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: TidyTitlesApi = {
  platform: process.platform,
  getState: () => ipcRenderer.invoke(IPC.getState),
  addFilesDialog: (kind) => ipcRenderer.invoke(IPC.addFilesDialog, kind),
  addPaths: (paths) => ipcRenderer.invoke(IPC.addPaths, paths),
  takeOpenedPaths: (accept) => ipcRenderer.invoke(IPC.takeOpenedPaths, accept),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  removeFiles: (ids) => ipcRenderer.invoke(IPC.removeFiles, ids),
  clearFiles: () => ipcRenderer.invoke(IPC.clearFiles),
  setOptions: (options) => ipcRenderer.invoke(IPC.setOptions, options),
  fetch: () => ipcRenderer.invoke(IPC.fetch),
  cancelFetch: () => ipcRenderer.invoke(IPC.cancelFetch),
  answerSelection: (id, index) => ipcRenderer.invoke(IPC.answerSelection, id, index),
  rename: () => ipcRenderer.invoke(IPC.rename),
  undo: () => ipcRenderer.invoke(IPC.undo),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  previewTemplates: (templates) => ipcRenderer.invoke(IPC.previewTemplates, templates),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.saveSettings, settings),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  getUpdateState: () => ipcRenderer.invoke(IPC.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  restartToUpdate: () => ipcRenderer.invoke(IPC.restartToUpdate),
  openReleasePage: () => ipcRenderer.invoke(IPC.openReleasePage),
  setAutoCheckForUpdates: (enabled) => ipcRenderer.invoke(IPC.setAutoCheckForUpdates, enabled),
  chooseFolder: (current) => ipcRenderer.invoke(IPC.chooseFolder, current),
  getHistory: () => ipcRenderer.invoke(IPC.getHistory),
  undoEntry: (timestamp) => ipcRenderer.invoke(IPC.undoEntry, timestamp),
  getMatchContext: (fileId) => ipcRenderer.invoke(IPC.getMatchContext, fileId),
  searchMatches: (fileId, query) => ipcRenderer.invoke(IPC.searchMatches, fileId, query),
  chooseMatch: (searchId, index, options) => ipcRenderer.invoke(IPC.chooseMatch, searchId, index, options),
  clearMatch: (fileId) => ipcRenderer.invoke(IPC.clearMatch, fileId),
  getEditableName: (fileId) => ipcRenderer.invoke(IPC.getEditableName, fileId),
  setFileName: (fileId, name) => ipcRenderer.invoke(IPC.setFileName, fileId, name),
  onUpdateState: (listener) => subscribe(EVENTS.updateState, listener),
  onState: (listener) => subscribe(EVENTS.state, listener),
  onProgress: (listener) => subscribe(EVENTS.progress, listener),
  onSelectionRequest: (listener) => subscribe(EVENTS.selectionRequest, listener),
  onSelectionClosed: (listener) => subscribe(EVENTS.selectionClosed, listener),
  onMenuCommand: (listener) => subscribe(EVENTS.menuCommand, listener),
  onPathsOpened: (listener) => subscribe(EVENTS.pathsOpened, () => listener()),
  getWatchState: () => ipcRenderer.invoke(IPC.getWatchState),
  onWatchState: (listener) => subscribe(EVENTS.watchState, listener),
  takeWatchArrivals: (accept) => ipcRenderer.invoke(IPC.takeWatchArrivals, accept),
  setWatchPaused: (paused) => ipcRenderer.invoke(IPC.setWatchPaused, paused),
  processExistingWatchFiles: () => ipcRenderer.invoke(IPC.processExistingWatchFiles),
  retryWatchNow: () => ipcRenderer.invoke(IPC.retryWatchNow),
  getWatchActivity: () => ipcRenderer.invoke(IPC.getWatchActivity),
  chooseWatchFolder: (current) => ipcRenderer.invoke(IPC.chooseWatchFolder, current),
};

contextBridge.exposeInMainWorld("tidytitles", api);
