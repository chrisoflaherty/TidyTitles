// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SettingsDialog } from "../../src/renderer/src/components/SettingsDialog";
import { presetFor } from "../../src/renderer/src/presets";
import { createFakeApi, settingsPayload } from "./fixtures";

describe("presetFor", () => {
  const { presets, settings } = settingsPayload();
  it("finds the preset whose three templates match", () => {
    expect(presetFor(settings.templates, presets)?.id).toBe("default");
    expect(presetFor({ ...presets[1]!.templates }, presets)?.id).toBe("plex");
    expect(presetFor({ ...settings.templates, tv: "{title}" }, presets)).toBeUndefined();
  });
});

describe("naming preset picker", () => {
  it("shows the preset in effect, fills the templates, and turns to Custom once edited", async () => {
    const { api } = createFakeApi();
    render(<SettingsDialog onClose={() => {}} onSaved={() => {}} />);
    const picker = (await screen.findByTestId("naming-preset")) as HTMLSelectElement;
    expect(picker.value).toBe("default");
    expect(screen.getByTestId("naming-preset-hint").textContent).toContain("TidyTitles' own default.");

    await userEvent.selectOptions(picker, "plex");
    expect(picker.value).toBe("plex");
    const movie = screen.getByTestId("template-movie") as HTMLInputElement;
    expect(movie.value).toBe("{title} ({year})/{title} ({year})");
    expect((screen.getByTestId("template-tv") as HTMLInputElement).value).toBe("{title}/Season {season2}/{title} - s{season2}e{episode2}");
    expect((screen.getByTestId("template-music") as HTMLInputElement).value).toBe("{album_artist}/{album}/{track2} - {title}");
    await waitFor(() =>
      expect(api.previewTemplates).toHaveBeenLastCalledWith(settingsPayload().presets[1]!.templates),
    );

    // The fields stay editable; an edit makes the preset "Custom".
    fireEvent.change(movie, { target: { value: "{title}" } });
    expect(picker.value).toBe("custom");
    expect(screen.getByTestId("naming-preset-hint").textContent).toContain("Custom");

    await userEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.saveSettings.mock.calls[0]![0].templates).toEqual({
      ...settingsPayload().presets[1]!.templates,
      movie: "{title}",
    });
  });

  it("lists placeholders by group with examples", async () => {
    createFakeApi();
    render(<SettingsDialog onClose={() => {}} onSaved={() => {}} />);
    const table = await screen.findByTestId("placeholder-table");
    expect(table.textContent).toContain("From the original file name");
    expect(table.textContent).toContain("{quality}");
    expect(table.textContent).toContain("1080p");
  });
});
