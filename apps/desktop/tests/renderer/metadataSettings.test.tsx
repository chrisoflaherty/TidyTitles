// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { effectiveTvProvider } from "../../src/renderer/src/components/MetadataSettings";
import { SettingsDialog } from "../../src/renderer/src/components/SettingsDialog";
import { operationStatus } from "../../src/renderer/src/status";
import { createFakeApi, file, op, settingsPayload } from "./fixtures";

async function openProviders() {
  render(<SettingsDialog onClose={() => {}} onSaved={vi.fn()} />);
  await screen.findByTestId("template-movie");
  await userEvent.click(screen.getByTestId("settings-tab-providers"));
}

describe("Settings: episode order and metadata language", () => {
  it("offers the orders, marking one the TV service has only for some shows", async () => {
    // The fixture has only a TMDB key, so TV lookups use TMDB.
    createFakeApi();
    await openProviders();
    const order = screen.getByTestId("episode-order") as HTMLSelectElement;
    expect([...order.options].map((o) => o.textContent)).toEqual([
      "Aired",
      "DVD (only some shows on TMDB)",
      "Absolute",
    ]);
    await userEvent.selectOptions(order, "dvd");
    expect(screen.getByTestId("episode-order-hint").textContent).toMatch(/only for shows with a DVD episode group/);
  });

  it("shows languages by name and saves the code", async () => {
    const { api } = createFakeApi();
    await openProviders();
    const language = screen.getByTestId("metadata-language") as HTMLSelectElement;
    expect([...language.options].map((o) => o.textContent)).toEqual(["English", "German", "Japanese"]);
    await userEvent.selectOptions(language, "ja-JP");
    await userEvent.selectOptions(screen.getByTestId("episode-order"), "absolute");
    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    const saved = api.saveSettings.mock.calls[0]![0];
    expect(saved.metadata).toEqual({ language: "ja-JP" });
    expect(saved.tv).toEqual({ episodeOrder: "absolute" });
  });

  it("works out which TV service Auto uses", () => {
    const settings = settingsPayload().settings;
    expect(effectiveTvProvider(settings)).toBe("tmdb");
    expect(effectiveTvProvider({ ...settings, api: { ...settings.api, tvdbApiKey: "k" } })).toBe("tvdb");
    expect(effectiveTvProvider({ ...settings, tvProvider: "tmdb", api: { ...settings.api, tvdbApiKey: "k" } })).toBe("tmdb");
  });
});

describe("status for an order the service cannot deliver", () => {
  it("says what to change", () => {
    const view = operationStatus(
      op(file(1, "Show.S01E01.mkv"), {
        status: "skipped",
        skipReason: "lookup_failed",
        lookupError: { kind: "order_unavailable", name: "EpisodeOrderUnavailableError", message: "TMDB has no DVD order for Show" },
      }),
      "planned",
    );
    expect(view.label).toBe("Order not available");
    expect(view.detail).toMatch(/TMDB has no DVD order for Show\. Choose Aired order, or TVDB/);
  });
});
