/** Which naming preset the edited templates equal (pure; mirrors core's `matchPreset`). */

import type { NamingPreset } from "@tidytitles/core";
import type { TemplateSet } from "../../shared/ipc";

export const CUSTOM_PRESET_ID = "custom";

/** The preset whose three templates equal these, or undefined for "Custom". */
export function presetFor(templates: TemplateSet, presets: readonly NamingPreset[]): NamingPreset | undefined {
  return presets.find(
    (p) => p.templates.movie === templates.movie && p.templates.tv === templates.tv && p.templates.music === templates.music,
  );
}
