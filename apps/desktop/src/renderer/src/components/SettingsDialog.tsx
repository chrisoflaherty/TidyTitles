import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CONFLICT_CHOICES,
  COVER_SIZE_CHOICES,
  type EditableSettings,
  type SettingsPayload,
  type TemplatePreview,
  type TemplateSet,
} from "../../../shared/ipc";
import { getApi } from "../api";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { MiddleEllipsis } from "./MiddleEllipsis";

type TabId = "templates" | "api" | "files" | "coverArt" | "providers";
const TABS: { id: TabId; label: string }[] = [
  { id: "templates", label: "Templates" },
  { id: "api", label: "API Keys" },
  { id: "files", label: "Files" },
  { id: "coverArt", label: "Cover Art" },
  { id: "providers", label: "Providers" },
];

const TEMPLATE_LABELS: Record<keyof TemplateSet, { label: string; sample: string }> = {
  movie: { label: "Movies", sample: "The Matrix (1999), 1080p BluRay" },
  tv: { label: "TV shows", sample: "Breaking Bad S01E01 “Pilot”, 720p HDTV" },
  music: { label: "Music", sample: "Pink Floyd, The Wall (1979), disc 2 track 6" },
};

const CONFLICT_LABELS: Record<(typeof CONFLICT_CHOICES)[number], { label: string; hint: string }> = {
  skip: { label: "Skip the file", hint: "Leave the file unrenamed when its new name is taken." },
  overwrite: { label: "Replace the existing file", hint: "The file already at the new name is overwritten." },
  auto_version: { label: "Add a number", hint: "Use the next free name, such as “The Matrix (1999) (1).mkv”." },
};

const COVER_SIZE_LABELS: Record<(typeof COVER_SIZE_CHOICES)[number], string> = {
  w92: "Tiny (92 px wide)",
  w154: "Small (154 px wide)",
  w185: "Small (185 px wide)",
  w342: "Medium (342 px wide)",
  w500: "Large (500 px wide)",
  w780: "Extra large (780 px wide)",
  original: "Original size",
};

function Section({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
  return (
    <fieldset className="settings-section">
      <legend>{title}</legend>
      {description && <p className="section-description">{description}</p>}
      {children}
    </fieldset>
  );
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  link,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  link?: { href: string; text: string };
  testId?: string;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <div className="secret-input">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
        <button
          type="button"
          className="btn btn-small"
          aria-pressed={shown}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          onClick={() => setShown((s) => !s)}
        >
          <Icon name={shown ? "eye-off" : "eye"} size={14} />
          <span>{shown ? "Hide" : "Show"}</span>
        </button>
      </div>
      {link && (
        <button type="button" className="link-button form-hint" onClick={() => void getApi().openExternal(link.href)}>
          {link.text}
          <Icon name="external" size={12} />
        </button>
      )}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
  hint,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
  testId?: string;
}) {
  return (
    <label className={`check check-block${disabled ? " is-disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>
        {label}
        {hint && <span className="form-hint block">{hint}</span>}
      </span>
    </label>
  );
}

function TemplateField({
  kind,
  value,
  onChange,
  preview,
  serverErrors,
}: {
  kind: keyof TemplateSet;
  value: string;
  onChange: (value: string) => void;
  preview: TemplatePreview[keyof TemplateSet] | undefined;
  serverErrors: string[] | undefined;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const errors = serverErrors?.length ? serverErrors : (preview?.errors ?? []);
  const invalid = errors.length > 0;
  return (
    <div className="form-row template-row">
      <label htmlFor={id}>{TEMPLATE_LABELS[kind].label}</label>
      <input
        id={id}
        className="mono"
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid}
        aria-describedby={messageId}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`template-${kind}`}
      />
      <div id={messageId} className="template-message" aria-live="polite">
        {invalid ? (
          <span className="tone-text-error template-error" data-testid={`template-${kind}-error`}>
            <Icon name="alert" size={12} />
            <span>{errors.join("; ")}</span>
          </span>
        ) : (
          <span className="template-preview" data-testid={`template-${kind}-preview`}>
            <span className="muted">Preview:</span> <span className="mono selectable">{preview?.preview ?? "…"}</span>
          </span>
        )}
        <span className="form-hint block">Sample: {TEMPLATE_LABELS[kind].sample}</span>
      </div>
    </div>
  );
}

export function SettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const api = getApi();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<EditableSettings | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [tab, setTab] = useState<TabId>("templates");
  const [errors, setErrors] = useState<string[]>([]);
  const [templateErrors, setTemplateErrors] = useState<Partial<Record<keyof TemplateSet, string[]>>>({});
  const [saving, setSaving] = useState(false);
  const previewSeq = useRef(0);
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const baseId = useId();

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((p) => {
      if (!alive) return;
      setPayload(p);
      setDraft(p.settings);
      setPreview(p.preview);
    });
    return () => {
      alive = false;
    };
  }, [api]);

  // Live preview, rendered by the core template engine in main.
  const templates = draft?.templates;
  useEffect(() => {
    if (!templates || !payload) return;
    const seq = ++previewSeq.current;
    void api.previewTemplates(templates).then((result) => {
      if (seq === previewSeq.current) setPreview(result);
    });
  }, [api, payload, templates]);

  const update = (fn: (d: EditableSettings) => EditableSettings) => setDraft((d) => (d ? fn(d) : d));
  const setTemplate = (kind: keyof TemplateSet, value: string) => {
    setTemplateErrors((e) => ({ ...e, [kind]: undefined }));
    update((d) => ({ ...d, templates: { ...d.templates, [kind]: value } }));
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const result = await api.saveSettings(draft);
      if (result.ok) {
        onSaved();
        return;
      }
      setErrors(result.errors);
      setTemplateErrors(result.templateErrors ?? {});
      if (result.templateErrors && Object.keys(result.templateErrors).length > 0) setTab("templates");
    } finally {
      setSaving(false);
    }
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current.get(id)?.focus();
  };

  const hasPreviewErrors = preview ? Object.values(preview).some((p) => p.errors.length > 0) : false;

  return (
    <Dialog
      title="Settings"
      className="dialog-settings"
      onCancel={onClose}
      onSubmit={() => void save()}
      testId="settings-dialog"
      footer={
        <>
          {payload && (
            <span className="form-hint footer-path">
              <span>Saved to</span>
              <MiddleEllipsis text={payload.configFile} />
            </span>
          )}
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!draft || saving} data-testid="settings-save">
            Save
          </button>
        </>
      }
    >
      {!draft || !payload ? (
        <p className="muted">Loading settings…</p>
      ) : (
        <div className="settings-layout">
          <div className="tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el);
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${baseId}-panel`}
                tabIndex={tab === t.id ? 0 : -1}
                className="tab"
                onClick={() => setTab(t.id)}
                data-testid={`settings-tab-${t.id}`}
              >
                {t.label}
                {t.id === "templates" && hasPreviewErrors && (
                  <span className="tab-alert" aria-label="has errors">
                    <Icon name="alert" size={12} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="tab-panel" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`}>
            {payload.loadError && (
              <p className="notice tone-warning" role="alert">
                <Icon name="alert" size={14} />
                <span>config.toml could not be read, so these are the defaults. Saving replaces the file. {payload.loadError}</span>
              </p>
            )}
            {errors.length > 0 && (
              <div className="notice tone-danger" role="alert" data-testid="settings-errors">
                <Icon name="alert" size={14} />
                <span>{errors.join(" ")}</span>
              </div>
            )}

            {tab === "templates" && (
              <>
                <Section title="Naming templates" description="How renamed files are named. A “/” in the music template creates folders.">
                  {(["movie", "tv", "music"] as const).map((kind) => (
                    <TemplateField
                      key={kind}
                      kind={kind}
                      value={draft.templates[kind]}
                      onChange={(v) => setTemplate(kind, v)}
                      preview={preview?.[kind]}
                      serverErrors={templateErrors[kind]}
                    />
                  ))}
                </Section>
                <details className="reference">
                  <summary>Placeholders and formatters</summary>
                  <div className="reference-grid">
                    <table>
                      <tbody>
                        {Object.entries(payload.fields).map(([field, desc]) => (
                          <tr key={field}>
                            <td className="mono">{`{${field}}`}</td>
                            <td>{desc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <table>
                      <tbody>
                        {Object.entries(payload.formatters).map(([syntax, desc]) => (
                          <tr key={syntax}>
                            <td className="mono">{`{field|${syntax}}`}</td>
                            <td>{desc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}

            {tab === "api" && (
              <Section
                title="API keys"
                description="Movie and TV lookups need a key from TMDB or TVDB. MusicBrainz needs no key. Keys are stored in your TidyTitles config file, which the command-line tool shares."
              >
                <SecretField
                  label="TMDB API key"
                  value={draft.api.tmdbApiKey}
                  placeholder="Enter TMDB API key"
                  onChange={(v) => update((d) => ({ ...d, api: { ...d.api, tmdbApiKey: v } }))}
                  link={{ href: "https://www.themoviedb.org/settings/api", text: "Get a TMDB API key" }}
                  testId="tmdb-key"
                />
                <SecretField
                  label="TVDB API key"
                  value={draft.api.tvdbApiKey}
                  placeholder="Enter TVDB API key"
                  onChange={(v) => update((d) => ({ ...d, api: { ...d.api, tvdbApiKey: v } }))}
                  link={{ href: "https://thetvdb.com/api-information", text: "Get a TVDB API key" }}
                  testId="tvdb-key"
                />
                <SecretField
                  label="TVDB subscriber PIN"
                  value={draft.api.tvdbPin}
                  placeholder="Optional"
                  onChange={(v) => update((d) => ({ ...d, api: { ...d.api, tvdbPin: v } }))}
                />
              </Section>
            )}

            {tab === "files" && (
              <>
                <Section title="Associated files" description="Files next to a video with the same name, such as “Movie.en.srt”, can be renamed along with it.">
                  <Check
                    label="Rename associated files with the media file"
                    checked={draft.associatedFiles.enabled}
                    onChange={(v) => update((d) => ({ ...d, associatedFiles: { ...d.associatedFiles, enabled: v } }))}
                    testId="assoc-enabled"
                  />
                  <div className="indent">
                    <Check
                      label="Subtitles"
                      hint=".srt, .sub, .ass, .ssa, .vtt, .idx"
                      checked={draft.associatedFiles.subtitles}
                      disabled={!draft.associatedFiles.enabled}
                      onChange={(v) => update((d) => ({ ...d, associatedFiles: { ...d.associatedFiles, subtitles: v } }))}
                    />
                    <Check
                      label="NFO files"
                      hint=".nfo"
                      checked={draft.associatedFiles.nfo}
                      disabled={!draft.associatedFiles.enabled}
                      onChange={(v) => update((d) => ({ ...d, associatedFiles: { ...d.associatedFiles, nfo: v } }))}
                    />
                    <Check
                      label="Images"
                      hint=".jpg, .jpeg, .png, .tbn with the video's name"
                      checked={draft.associatedFiles.images}
                      disabled={!draft.associatedFiles.enabled}
                      onChange={(v) => update((d) => ({ ...d, associatedFiles: { ...d.associatedFiles, images: v } }))}
                    />
                  </div>
                </Section>
                <Section title="When the new name is taken">
                  <div role="radiogroup" aria-label="When the new name is taken" className="radio-group">
                    {CONFLICT_CHOICES.map((choice) => (
                      <label key={choice} className="check check-block">
                        <input
                          type="radio"
                          name="conflict"
                          value={choice}
                          checked={draft.conflictResolution === choice}
                          onChange={() => update((d) => ({ ...d, conflictResolution: choice }))}
                          data-testid={`conflict-${choice}`}
                        />
                        <span>
                          {CONFLICT_LABELS[choice].label}
                          <span className="form-hint block">{CONFLICT_LABELS[choice].hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </Section>
              </>
            )}

            {tab === "coverArt" && (
              <Section title="Cover art" description="Posters (movies and TV) and album covers (music) are saved next to the renamed files.">
                <Check
                  label="Download cover art by default"
                  hint="Sets the “Download cover art” option in the main window."
                  checked={draft.coverArt.enabled}
                  onChange={(v) => update((d) => ({ ...d, coverArt: { ...d.coverArt, enabled: v } }))}
                  testId="cover-enabled"
                />
                <div className="form-grid">
                  <label htmlFor={`${baseId}-poster`}>Poster file name</label>
                  <input
                    id={`${baseId}-poster`}
                    type="text"
                    className="mono"
                    value={draft.coverArt.filename}
                    onChange={(e) => update((d) => ({ ...d, coverArt: { ...d.coverArt, filename: e.target.value } }))}
                  />
                  <label htmlFor={`${baseId}-album`}>Album cover file name</label>
                  <input
                    id={`${baseId}-album`}
                    type="text"
                    className="mono"
                    value={draft.coverArt.musicFilename}
                    onChange={(e) => update((d) => ({ ...d, coverArt: { ...d.coverArt, musicFilename: e.target.value } }))}
                  />
                  <label htmlFor={`${baseId}-size`}>Poster size</label>
                  <select
                    id={`${baseId}-size`}
                    value={draft.coverArt.size}
                    onChange={(e) => update((d) => ({ ...d, coverArt: { ...d.coverArt, size: e.target.value } }))}
                  >
                    {COVER_SIZE_CHOICES.map((size) => (
                      <option key={size} value={size}>
                        {COVER_SIZE_LABELS[size]}
                      </option>
                    ))}
                  </select>
                </div>
                <Check
                  label="Replace cover art that is already there"
                  checked={draft.coverArt.overwrite}
                  onChange={(v) => update((d) => ({ ...d, coverArt: { ...d.coverArt, overwrite: v } }))}
                />
              </Section>
            )}

            {tab === "providers" && (
              <Section title="Metadata services" description="Used when the provider in the main window is set to Auto.">
                <div className="form-grid">
                  <label htmlFor={`${baseId}-tv`}>TV shows</label>
                  <select
                    id={`${baseId}-tv`}
                    value={draft.tvProvider}
                    onChange={(e) => update((d) => ({ ...d, tvProvider: e.target.value }))}
                    data-testid="tv-provider"
                  >
                    <option value="tvdb">TVDB (preferred when its key is set)</option>
                    <option value="tmdb">TMDB (preferred when its key is set)</option>
                  </select>
                  <span className="form-label">Movies</span>
                  <span>TMDB</span>
                  <span className="form-label">Music</span>
                  <span>MusicBrainz</span>
                </div>
                <p className="form-hint">If the preferred TV service has no API key, the other one is used.</p>
              </Section>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
