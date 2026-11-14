import { useId, useState } from "react";
import type { SelectableOption } from "@tidytitles/core";
import type { SelectionRequest } from "../../../shared/ipc";
import { formatDuration, formatReleaseDate } from "../format";
import { Dialog } from "./Dialog";

export interface OptionText {
  title: string;
  details: string[];
}

/** The text shown for one match. */
export function describeOption(option: SelectableOption): OptionText {
  switch (option.kind) {
    case "movie": {
      const details: string[] = [];
      const date = formatReleaseDate(option.releaseDate);
      if (date) details.push(`Released ${date}`);
      if (option.originalTitle && option.originalTitle !== option.title) details.push(`Original title: ${option.originalTitle}`);
      if (option.genres.length) details.push(option.genres.slice(0, 3).join(", "));
      return { title: `${option.title}${option.year ? ` (${option.year})` : ""}`, details };
    }
    case "show": {
      const details: string[] = [];
      if (option.network) details.push(option.network);
      if (option.status) details.push(option.status);
      if (option.originalTitle && option.originalTitle !== option.title) details.push(`Original title: ${option.originalTitle}`);
      return { title: `${option.title}${option.year ? ` (${option.year})` : ""}`, details };
    }
    case "track": {
      const artist = option.artist?.name || "Unknown Artist";
      const details: string[] = [];
      details.push(option.album ? `${option.album.title}${option.album.year ? ` (${option.album.year})` : ""}` : "Unknown Album");
      const duration = formatDuration(option.durationMs);
      if (duration) details.push(duration);
      if (option.artist?.disambiguation) details.push(option.artist.disambiguation);
      return { title: `${artist} – ${option.title}`, details };
    }
  }
}

const KIND_NOUN = { movie: "movies", show: "TV shows", track: "recordings" } as const;

export function SelectionDialog({
  request,
  onSelect,
  onSkip,
  onCancelAll,
}: {
  request: SelectionRequest;
  onSelect: (index: number) => void;
  onSkip: () => void;
  onCancelAll: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const descId = useId();
  const name = `selection-${request.id}`;

  return (
    <Dialog
      title="Choose the Right Match"
      className="dialog-selection"
      describedBy={descId}
      onCancel={onSkip}
      onSubmit={() => onSelect(selected)}
      testId="selection-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancelAll} data-testid="selection-cancel-all">
            Cancel All
          </button>
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onSkip} data-testid="selection-skip">
            Skip This File
          </button>
          <button type="submit" className="btn btn-primary" data-testid="selection-select">
            Select
          </button>
        </>
      }
    >
      <p id={descId} className="selection-intro">
        Several {KIND_NOUN[request.kind]} match <strong className="selection-file" title={request.filename}>{request.filename}</strong>.
        Pick one, or skip this file to leave it unchanged.
      </p>
      <fieldset className="option-list" aria-label="Matches">
        {request.options.map((option, i) => {
          const text = describeOption(option);
          const id = `${name}-${i}`;
          return (
            <label
              key={id}
              className={`option${selected === i ? " option-selected" : ""}`}
              htmlFor={id}
              onDoubleClick={() => onSelect(i)}
              data-testid="selection-option"
            >
              <input
                id={id}
                type="radio"
                name={name}
                checked={selected === i}
                onChange={() => setSelected(i)}
                autoFocus={i === 0}
              />
              <span className="option-text">
                <span className="option-title">{text.title}</span>
                {text.details.length > 0 && <span className="option-details">{text.details.join(" · ")}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
    </Dialog>
  );
}
