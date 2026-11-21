/**
 * "Edit New Name": type the name a file gets. The extension is kept and the
 * folders the template creates stay; main checks the name and re-plans the
 * list (conflicts, associated files).
 */

import { useEffect, useId, useRef, useState } from "react";
import type { EditableName } from "@tidytitles/core";
import { getApi } from "../api";
import { Dialog } from "./Dialog";

export function EditNameDialog({ fileId, fileName, onClose }: { fileId: number; fileName: string; onClose: () => void }) {
  const api = getApi();
  const id = useId();
  const [editable, setEditable] = useState<EditableName | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void api.getEditableName(fileId).then((outcome) => {
      if (!live) return;
      if (outcome.kind !== "ok") {
        setError("This file has no new name to edit right now.");
        return;
      }
      setEditable(outcome.name);
      setValue(outcome.name.name);
    });
    return () => {
      live = false;
    };
  }, [api, fileId]);

  useEffect(() => {
    if (editable) inputRef.current?.select();
  }, [editable]);

  const save = async (name: string | null) => {
    if (!editable || saving) return;
    setSaving(true);
    const outcome = await api.setFileName(fileId, name);
    setSaving(false);
    if (outcome.kind === "applied") onClose();
    else if (outcome.kind === "invalid") {
      setError(outcome.message);
      inputRef.current?.focus();
    } else setError("This file has no new name to edit right now.");
  };

  return (
    <Dialog
      title="Edit New Name"
      className="dialog-small"
      onCancel={onClose}
      onSubmit={() => void save(value)}
      testId="name-dialog"
      footer={
        <>
          {editable?.custom && (
            <button
              type="button"
              className="btn"
              onClick={() => void save(null)}
              disabled={saving}
              title={`${editable.templateName}${editable.extension}`}
              data-testid="name-reset"
            >
              Use Template Name
            </button>
          )}
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!editable || saving} data-testid="name-save">
            Set Name
          </button>
        </>
      }
    >
      <p className="selection-intro">
        The new name for <strong className="selection-file" title={fileName}>{fileName}</strong>.
      </p>
      <div className="form-row">
        <label htmlFor={id}>New name</label>
        <div className="name-input">
          <input
            id={id}
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            disabled={!editable}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            spellCheck={false}
            autoComplete="off"
            data-testid="name-input"
          />
          {editable?.extension && (
            <span className="name-ext mono">
              {editable.extension}
            </span>
          )}
        </div>
        {error && (
          <span id={`${id}-error`} className="tone-text-error form-hint" role="alert" data-testid="name-error">
            {error}
          </span>
        )}
        <span id={`${id}-hint`} className="form-hint block">
          {editable?.folder ? <>Goes in the folder {editable.folder}. </> : null}
          The extension stays the same, and subtitles and other files that go with it get the same name. The name lasts
          until you fetch metadata again.
        </span>
      </div>
    </Dialog>
  );
}
