/** `config show | set-key | set-template | init`. */

import { existsSync } from "node:fs";
import { TemplateEngine, getApiKeyStatus, metadataLanguageName } from "@tidytitles/core";
import type { CommandContext, GlobalOptions } from "../context";
import { EXIT_ERROR, EXIT_OK } from "../errors";

export interface JsonOption extends GlobalOptions {
  json?: boolean;
}

/** Python bool repr, as the Python `config show` printed it. */
const pyBool = (b: boolean) => (b ? "True" : "False");

export async function configShowCommand(ctx: CommandContext, options: JsonOption): Promise<number> {
  const { ui } = ctx;
  const c = ui.c;
  const config = ctx.config(options);
  const s = await config.load();
  const keys = getApiKeyStatus(s);
  // Keys are never shown, only whether they are set.
  const keyStatus = (set: boolean) => (set ? "configured" : "not set");

  if (options.json) {
    ui.json({
      configFile: config.configFile,
      cacheDir: config.cacheDir,
      templates: { ...s.templates },
      apiKeys: { tmdb: keyStatus(keys.tmdb), tvdb: keyStatus(keys.tvdb) },
      associatedFiles: { ...s.associatedFiles },
      coverArt: { ...s.coverArt },
      behavior: {
        dryRun: s.dryRun,
        overwrite: s.overwrite,
        previewBeforeRename: s.previewBeforeRename,
        conflictResolution: s.conflictResolution,
      },
      providers: { movie: s.movieProvider, tv: s.tvProvider, music: s.musicProvider },
      tv: { episodeOrder: s.tv.episodeOrder },
      metadata: { language: s.metadata.language },
    });
    return EXIT_OK;
  }

  const status = (set: boolean) => (set ? c.green("configured") : c.red("not set"));
  ui.print(c.bold("Current Configuration"));
  ui.print();
  ui.print(`Config file: ${config.configFile}`);
  ui.print(`Cache dir: ${config.cacheDir}`);
  ui.print();
  ui.print(c.bold("Templates:"));
  ui.print(`  Movie: ${s.templates.movie}`);
  ui.print(`  TV:    ${s.templates.tv}`);
  ui.print(`  Music: ${s.templates.music}`);
  ui.print();
  ui.print(c.bold("API Keys:"));
  ui.print(`  TMDB: ${status(keys.tmdb)}`);
  ui.print(`  TVDB: ${status(keys.tvdb)}`);
  ui.print();
  ui.print(c.bold("Associated Files:"));
  const af = s.associatedFiles;
  ui.print(`  Enabled:   ${af.enabled ? c.green("enabled") : c.red("disabled")}`);
  if (af.enabled) {
    const mark = (b: boolean) => (b ? "✓" : "✗");
    ui.print(`  Subtitles: ${mark(af.subtitles)}`);
    ui.print(`  NFO files: ${mark(af.nfo)}`);
    ui.print(`  Images:    ${mark(af.images)}`);
  }
  ui.print();
  ui.print(c.bold("Behavior:"));
  ui.print(`  Conflict resolution: ${s.conflictResolution}`);
  ui.print(`  Preview before rename: ${pyBool(s.previewBeforeRename)}`);
  ui.print();
  ui.print(c.bold("Metadata:"));
  ui.print(`  Episode order: ${s.tv.episodeOrder}`);
  const languageName = metadataLanguageName(s.metadata.language);
  ui.print(
    `  Language:      ${s.metadata.language}${languageName === s.metadata.language ? "" : ` (${languageName})`}`,
  );
  return EXIT_OK;
}

export async function configSetKeyCommand(
  ctx: CommandContext,
  provider: "tmdb" | "tvdb",
  key: string,
  options: GlobalOptions,
): Promise<number> {
  const config = ctx.config(options);
  await config.load();
  await config.setApiKey(provider, key);
  ctx.ui.print(ctx.ui.c.green(`API key for ${provider.toUpperCase()} saved.`));
  return EXIT_OK;
}

export async function configSetTemplateCommand(
  ctx: CommandContext,
  type: "movie" | "tv" | "music",
  template: string,
  options: GlobalOptions,
): Promise<number> {
  const { ui } = ctx;
  const config = ctx.config(options);
  const settings = await config.load();

  const { isValid, errors } = new TemplateEngine().validateTemplate(template);
  if (!isValid) {
    ui.note(ui.ec.red("Invalid template:"));
    for (const error of errors) ui.note(`  - ${error}`);
    return EXIT_ERROR;
  }

  settings.templates[type] = template;
  await config.save(settings);
  ui.print(ui.c.green(`Template for ${type} saved.`));
  return EXIT_OK;
}

export async function configInitCommand(ctx: CommandContext, options: GlobalOptions): Promise<number> {
  const { ui } = ctx;
  const c = ui.c;
  const name = ctx.programName;
  const config = ctx.config(options);

  if (existsSync(config.configFile)) {
    const ok = await ctx.deps.prompter.confirm("Config file exists. Overwrite?", {
      default: false,
      signal: ctx.signal,
    });
    if (!ok) return EXIT_OK;
  }

  // Defaults (plus FILE_RENAMER_* environment values), as the Python `config init`.
  await config.save();
  ui.print(`${c.green("Config file created at:")} ${config.configFile}`);
  ui.print();
  ui.print("Next steps:");
  ui.print("  1. Get a TMDB API key from https://www.themoviedb.org/settings/api");
  ui.print(`  2. Run: ${name} config set-key tmdb YOUR_API_KEY`);
  ui.print("  3. (Optional) Get a TVDB API key from https://thetvdb.com/api-information");
  ui.print(`  4. Run: ${name} config set-key tvdb YOUR_API_KEY`);
  return EXIT_OK;
}
