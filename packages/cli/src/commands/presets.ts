/** `config presets` and `config preset <name>`: ready-made naming for media servers. */

import { CUSTOM_PRESET_NAME, NAMING_PRESETS, findPreset, matchPreset } from "@tidytitles/core";
import type { CommandContext, GlobalOptions } from "../context";
import { EXIT_ERROR, EXIT_OK } from "../errors";
import type { JsonOption } from "./config";

export async function configPresetsCommand(ctx: CommandContext, options: JsonOption): Promise<number> {
  const { ui } = ctx;
  const c = ui.c;
  const settings = await ctx.config(options).load();
  const current = matchPreset(settings.templates);

  if (options.json) {
    ui.json({
      current: current?.id ?? null,
      presets: NAMING_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        templates: { ...p.templates },
        sources: [...p.sources],
      })),
    });
    return EXIT_OK;
  }

  ui.print(c.bold("Naming presets"));
  for (const p of NAMING_PRESETS) {
    ui.print();
    const mark = p === current ? ` ${c.green("(in effect)")}` : "";
    ui.print(`${c.bold(p.id)}  ${p.name}${mark}`);
    ui.print(`  ${p.description}`);
    ui.print(`  Movie: ${p.templates.movie}`);
    ui.print(`  TV:    ${p.templates.tv}`);
    ui.print(`  Music: ${p.templates.music}`);
  }
  ui.print();
  ui.print(`In effect: ${current ? current.name : CUSTOM_PRESET_NAME}`);
  ui.print(`Apply one with: ${ctx.programName} config preset <name>`);
  return EXIT_OK;
}

export async function configPresetCommand(
  ctx: CommandContext,
  name: string,
  options: GlobalOptions,
): Promise<number> {
  const { ui } = ctx;
  const preset = findPreset(name);
  if (!preset) {
    ui.note(ui.ec.red(`Unknown preset: ${name}`));
    ui.note(`Available presets: ${NAMING_PRESETS.map((p) => p.id).join(", ")}`);
    return EXIT_ERROR;
  }
  const config = ctx.config(options);
  const settings = await config.load();
  settings.templates = { ...settings.templates, ...preset.templates };
  await config.save(settings);
  ui.print(ui.c.green(`Applied the ${preset.name} preset.`));
  ui.print(`  Movie: ${preset.templates.movie}`);
  ui.print(`  TV:    ${preset.templates.tv}`);
  ui.print(`  Music: ${preset.templates.music}`);
  return EXIT_OK;
}
