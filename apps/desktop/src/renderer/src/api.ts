import type { TidyTitlesApi } from "../../shared/ipc";

declare global {
  interface Window {
    /** Exposed by the preload script. */
    readonly tidytitles: TidyTitlesApi;
  }
}

/** The preload API. Tests replace `window.tidytitles` with a fake. */
export function getApi(): TidyTitlesApi {
  return window.tidytitles;
}
