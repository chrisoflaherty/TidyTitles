/**
 * "Change Match": search again with other words (and, for a video file, as
 * a movie or a TV episode with corrected numbers), then give the file one
 * of the results. Main holds the search results; this dialog refers to
 * them by search id and index.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { MatchQuery, MatchQueryType, SelectableOption } from "@tidytitles/core";
import type { MatchContext } from "../../../shared/ipc";
import { getApi } from "../api";
import {
  QUERY_TYPE_LABELS,
  formFromQuery,
  lookupErrorMessage,
  noProviderMessage,
  queryFromForm,
  type FormField,
  type QueryForm,
} from "../corrections";
import { plural } from "../format";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { describeOption } from "./SelectionDialog";

type Message = { tone: "info" | "warning" | "error"; text: string };

interface SearchState {
  searchId: string;
  query: MatchQuery;
  options: SelectableOption[];
}

const UNAVAILABLE: Message = {
  tone: "error",
  text: "The list changed, so this file can’t be corrected now. Close this window and try again.",
};

export function ChangeMatchDialog({
  fileId,
  fileName,
  hasMatch,
  onClose,
  onClear,
}: {
  fileId: number;
  fileName: string;
  /** The file has a match now (offers "Clear Match"). */
  hasMatch: boolean;
  onClose: () => void;
  onClear: () => void;
}) {
  const api = getApi();
  const baseId = useId();
  const [context, setContext] = useState<MatchContext | null>(null);
  const [form, setForm] = useState<QueryForm | null>(null);
  const [invalid, setInvalid] = useState<{ field: FormField; message: string } | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [selected, setSelected] = useState(0);
  const [applyToSimilar, setApplyToSimilar] = useState(true);
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<"search" | "choose" | null>(null);
  const searchSeq = useRef(0);
  const titleRef = useRef<HTMLInputElement>(null);

  const runSearch = async (query: MatchQuery) => {
    const seq = ++searchSeq.current;
    setPending("search");
    setMessage({ tone: "info", text: "Searching…" });
    const outcome = await api.searchMatches(fileId, query);
    if (seq !== searchSeq.current) return;
    setPending(null);
    switch (outcome.kind) {
      case "results":
        setSearch({ searchId: outcome.searchId, query: outcome.query, options: outcome.options });
        setSelected(0);
        setMessage(
          outcome.options.length === 0
            ? { tone: "warning", text: `Nothing found for “${outcome.query.title}”. Try other words.` }
            : { tone: "info", text: `${plural(outcome.options.length, "result")} for “${outcome.query.title}”.` },
        );
        break;
      case "noProvider":
        setSearch(null);
        setMessage({ tone: "warning", text: noProviderMessage(outcome.mediaType) });
        break;
      case "error":
        setSearch(null);
        setMessage({ tone: "error", text: lookupErrorMessage(outcome.error) });
        break;
      case "unavailable":
        setSearch(null);
        setMessage(UNAVAILABLE);
        break;
    }
  };

  // Start with what the fetch searched for, and show its results.
  useEffect(() => {
    let live = true;
    void api.getMatchContext(fileId).then((outcome) => {
      if (!live) return;
      if (outcome.kind !== "ok") {
        setMessage(UNAVAILABLE);
        return;
      }
      setContext(outcome.context);
      setForm(formFromQuery(outcome.context.query));
      if (outcome.context.query.title.trim()) void runSearch(outcome.context.query);
    });
    return () => {
      live = false;
      searchSeq.current += 1;
    };
    // Once per dialog (runSearch only uses state setters and refs).
  }, [api, fileId]);

  useEffect(() => {
    if (context) titleRef.current?.focus();
  }, [context]);

  const update = (fields: Partial<QueryForm>) => {
    setForm((f) => (f ? { ...f, ...fields } : f));
    setInvalid(null);
  };

  const submitSearch = () => {
    if (!form) return;
    const parsed = queryFromForm(form);
    if (!parsed.ok) {
      setInvalid({ field: parsed.field, message: parsed.message });
      return;
    }
    void runSearch(parsed.query);
  };

  const option = search?.options[selected];
  const isShow = option?.kind === "show";
  const similar = context?.similarCount ?? 0;

  const choose = async (index = selected) => {
    const option = search?.options[index];
    if (!search || !option || pending) return;
    const isShow = option.kind === "show";
    const options: { applyToSimilar: boolean; season?: number; episode?: number } = {
      applyToSimilar: isShow && similar > 0 && applyToSimilar,
    };
    if (isShow && form?.mediaType === "tv_episode") {
      const parsed = queryFromForm(form);
      if (!parsed.ok) {
        setInvalid({ field: parsed.field, message: parsed.message });
        return;
      }
      if (parsed.query.mediaType === "tv_episode") {
        if (parsed.query.season !== undefined) options.season = parsed.query.season;
        if (parsed.query.episode !== undefined) options.episode = parsed.query.episode;
      }
    }
    setPending("choose");
    const outcome = await api.chooseMatch(search.searchId, index, options);
    setPending(null);
    switch (outcome.kind) {
      case "applied":
        onClose();
        return;
      case "episodeNotFound":
        setMessage({
          tone: "warning",
          text: `${option.title} has no season ${outcome.season}, episode ${outcome.episode}. Check the numbers.`,
        });
        return;
      case "needsEpisode":
        setInvalid({ field: form?.season.trim() ? "episode" : "season", message: "Enter the season and episode numbers." });
        return;
      case "error":
        setMessage({ tone: "error", text: lookupErrorMessage(outcome.error) });
        return;
      case "unavailable":
        setMessage(UNAVAILABLE);
        return;
    }
  };

  // Enter in a search field searches; elsewhere it uses the selected match.
  const onFieldsKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") {
      event.preventDefault();
      submitSearch();
    }
  };

  const field = (
    key: "title" | "year" | "season" | "episode" | "artist" | "album",
    label: string,
    options: { numeric?: boolean; wide?: boolean } = {},
  ) => {
    const id = `${baseId}-${key}`;
    const error = invalid?.field === key ? invalid.message : undefined;
    return (
      <div className={`match-field${options.wide ? " match-field-wide" : ""}`}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          ref={key === "title" ? titleRef : undefined}
          type="text"
          inputMode={options.numeric ? "numeric" : undefined}
          value={form?.[key] ?? ""}
          onChange={(event) => update({ [key]: event.target.value })}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          spellCheck={false}
          autoComplete="off"
          data-testid={`match-${key}`}
        />
        {error && (
          <span id={`${id}-error`} className="tone-text-error form-hint" data-testid="match-field-error">
            {error}
          </span>
        )}
      </div>
    );
  };

  const types: MatchQueryType[] = context?.queryTypes ?? [];
  const mediaType = form?.mediaType;

  return (
    <Dialog
      title="Change Match"
      className="dialog-match"
      onCancel={onClose}
      onSubmit={() => void choose()}
      testId="match-dialog"
      footer={
        <>
          {hasMatch && (
            <button type="button" className="btn" onClick={onClear} disabled={pending !== null} data-testid="match-clear">
              Clear Match
            </button>
          )}
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!option || pending !== null}
            data-testid="match-use"
          >
            Use This Match
          </button>
        </>
      }
    >
      <p className="selection-intro">
        Search again for <strong className="selection-file" title={fileName}>{fileName}</strong> with other words, then pick
        the right result.
      </p>

      {form && (
        <div className="match-form" onKeyDown={onFieldsKey} role="search" aria-label="Search for a match">
          {types.length > 1 && (
            <div className="match-field">
              <label htmlFor={`${baseId}-type`}>Search as</label>
              <select
                id={`${baseId}-type`}
                value={mediaType}
                onChange={(event) => update({ mediaType: event.target.value as MatchQueryType })}
                data-testid="match-type"
              >
                {types.map((t) => (
                  <option key={t} value={t}>
                    {QUERY_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {field("title", mediaType === "tv_episode" ? "Show" : "Title", { wide: true })}
          {mediaType !== "music" && field("year", "Year", { numeric: true })}
          {mediaType === "tv_episode" && field("season", "Season", { numeric: true })}
          {mediaType === "tv_episode" && field("episode", "Episode", { numeric: true })}
          {mediaType === "music" && field("artist", "Artist")}
          {mediaType === "music" && field("album", "Album")}
          <div className="match-field match-field-button">
            <button
              type="button"
              className="btn"
              onClick={submitSearch}
              disabled={pending === "choose"}
              data-testid="match-search"
            >
              <Icon name="search" size={14} />
              <span>Search</span>
            </button>
          </div>
        </div>
      )}

      <p
        className={`match-message${message ? ` tone-text-${message.tone}` : ""}`}
        role="status"
        aria-live="polite"
        data-testid="match-message"
      >
        {message?.text ?? ""}
      </p>

      {search && search.options.length > 0 && (
        <fieldset className="option-list" aria-label="Results" data-testid="match-results">
          {search.options.map((result, i) => {
            const text = describeOption(result);
            const id = `${baseId}-option-${i}`;
            return (
              <label
                key={`${search.searchId}-${i}`}
                className={`option${selected === i ? " option-selected" : ""}`}
                htmlFor={id}
                onDoubleClick={() => {
                  setSelected(i);
                  void choose(i);
                }}
                data-testid="match-option"
              >
                <input
                  id={id}
                  type="radio"
                  name={`${baseId}-options`}
                  checked={selected === i}
                  onChange={() => setSelected(i)}
                />
                <span className="option-text">
                  <span className="option-title">{text.title}</span>
                  {text.details.length > 0 && <span className="option-details">{text.details.join(" · ")}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {isShow && similar > 0 && (
        <label className="check" data-testid="match-apply-similar">
          <input type="checkbox" checked={applyToSimilar} onChange={(event) => setApplyToSimilar(event.target.checked)} />
          <span>
            Also use this show for the {plural(similar, "other file")} named “{context!.parsedTitle}”
          </span>
        </label>
      )}
    </Dialog>
  );
}
