import { useEffect, useRef, type KeyboardEvent } from "react";
import type { AssociatedFileType, PlannedOperation } from "@tidytitles/core";
import type { AppState, FileEntry } from "../../../shared/ipc";
import { baseName, dirName, relativeTo } from "../format";
import { operationStatus, type StatusView } from "../status";
import { Icon, type IconName } from "./Icon";
import { MiddleEllipsis } from "./MiddleEllipsis";

const ASSOC_LABEL: Record<AssociatedFileType, string> = {
  subtitle: "Subtitle",
  nfo: "NFO",
  image: "Image",
  other: "File",
};
const ASSOC_ICON: Record<AssociatedFileType, IconName> = {
  subtitle: "subtitle",
  nfo: "doc",
  image: "image",
  other: "doc",
};

export function StatusBadge({ status }: { status: StatusView }) {
  return (
    <span className={`badge tone-${status.tone}`} title={status.detail} data-testid="status-badge">
      <Icon name={status.icon} size={12} />
      <span>{status.label}</span>
    </span>
  );
}

interface Row {
  key: string;
  file: FileEntry;
  op: PlannedOperation | undefined;
  status: StatusView;
}

function newNameCell(op: PlannedOperation | undefined, plan: AppState["plan"]) {
  if (!op || plan === "none") return <span className="muted">—</span>;
  if (op.destination === op.source) return <span className="muted" title="The name stays the same">Unchanged</span>;
  const shown = relativeTo(dirName(op.source), op.destination);
  return <MiddleEllipsis text={shown} title={op.destination} />;
}

export interface FileTableProps {
  app: AppState;
  selectedFileId: number | null;
  onSelect: (id: number | null) => void;
  onRemove: (ids: number[]) => void;
}

export function FileTable({ app, selectedFileId, onSelect, onRemove }: FileTableProps) {
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const focusPending = useRef(false);

  const rows: Row[] = app.files.map((file, i) => {
    const op = app.operations?.[i];
    return { key: `f${file.id}`, file, op, status: operationStatus(op, app.plan) };
  });

  useEffect(() => {
    if (focusPending.current && selectedFileId !== null) {
      rowRefs.current.get(selectedFileId)?.focus();
      focusPending.current = false;
    }
  }, [selectedFileId]);

  const move = (delta: number | "start" | "end") => {
    if (rows.length === 0) return;
    const index = rows.findIndex((r) => r.file.id === selectedFileId);
    let next: number;
    if (delta === "start") next = 0;
    else if (delta === "end") next = rows.length - 1;
    else next = index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta));
    const id = rows[next]!.file.id;
    focusPending.current = true;
    onSelect(id);
    rowRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        move("start");
        break;
      case "End":
        move("end");
        break;
      case "PageDown":
        move(10);
        break;
      case "PageUp":
        move(-10);
        break;
      case "Delete":
      case "Backspace":
        if (selectedFileId !== null && app.busy === null) {
          const index = rows.findIndex((r) => r.file.id === selectedFileId);
          const neighbor = rows[index + 1] ?? rows[index - 1];
          onRemove([selectedFileId]);
          focusPending.current = true;
          onSelect(neighbor ? neighbor.file.id : null);
        }
        break;
      case "Escape":
        onSelect(null);
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  // The first row is reachable with Tab even before anything is selected.
  const tabStopId = selectedFileId ?? rows[0]?.file.id ?? null;

  return (
    <div className="table-scroll" data-testid="file-table">
      <table className="file-table" role="grid" aria-readonly="true" aria-label="Files">
        <colgroup>
          <col className="col-type" />
          <col className="col-name" />
          <col className="col-arrow" />
          <col className="col-name" />
          <col className="col-status" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Original name</th>
            <th scope="col" aria-label="becomes" />
            <th scope="col">New name</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {rows.map((row) => {
            const selected = row.file.id === selectedFileId;
            const original = row.op ? baseName(row.op.source) : row.file.name;
            const originalPath = row.op ? row.op.source : row.file.path;
            return [
              <tr
                key={row.key}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.file.id, el);
                  else rowRefs.current.delete(row.file.id);
                }}
                className={selected ? "selected" : undefined}
                data-tone={row.status.rowTone}
                aria-selected={selected}
                tabIndex={row.file.id === tabStopId ? 0 : -1}
                onClick={() => onSelect(row.file.id)}
                onFocus={() => {
                  if (!selected && selectedFileId === null) onSelect(row.file.id);
                }}
                data-testid="file-row"
              >
                <td className="cell-type">
                  <Icon name={row.file.kind === "audio" ? "music" : "film"} size={14} />
                  <span>{row.file.kind === "audio" ? "Audio" : "Video"}</span>
                </td>
                <td>
                  <MiddleEllipsis text={original} title={originalPath} />
                </td>
                <td className="cell-arrow" aria-hidden="true">
                  {row.op && app.plan !== "none" && row.op.destination !== row.op.source ? "→" : ""}
                </td>
                <td>{newNameCell(row.op, app.plan)}</td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
              </tr>,
              ...(row.op && app.plan !== "none"
                ? row.op.associatedFiles.map((assoc) => (
                    <tr key={`${row.key}-${assoc.source}`} className="assoc-row" data-tone={row.status.rowTone}>
                      <td className="cell-type">
                        <span className="assoc-branch" aria-hidden="true">
                          └
                        </span>
                        <Icon name={ASSOC_ICON[assoc.fileType]} size={14} />
                        <span>{ASSOC_LABEL[assoc.fileType]}</span>
                      </td>
                      <td>
                        <MiddleEllipsis text={baseName(assoc.source)} title={assoc.source} />
                      </td>
                      <td className="cell-arrow" aria-hidden="true">
                        →
                      </td>
                      <td>
                        <MiddleEllipsis text={relativeTo(dirName(row.op!.source), assoc.destination)} title={assoc.destination} />
                      </td>
                      <td>
                        <span className="muted assoc-note">Moves with the file</span>
                      </td>
                    </tr>
                  ))
                : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
