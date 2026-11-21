/**
 * The file list: a real <table role="grid"> whose body is windowed, so a list
 * of thousands of files keeps only the rows near the viewport in the DOM.
 *
 * Layout model: each file is one *group* (its row plus the associated-file
 * rows beneath it). A group's height starts as an estimate (its row count
 * times the measured height of one row) and becomes its measured height once
 * it has been rendered. Prefix sums of the group heights give each group's
 * offset; spacer rows above, between, and below the rendered groups stand in
 * for the rest, so the scrollbar reflects the full length. When a group above
 * the viewport turns out taller or shorter than assumed, the scroll position
 * is corrected in the same frame, so the visible rows do not jump.
 *
 * The tab-stop row (the selected row, or the first) is always rendered, at its
 * real position, so keyboard focus survives scrolling it out of view.
 * Assistive technology gets the full size from aria-rowcount and each
 * rendered row's position from aria-rowindex.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AssociatedFileType, PlannedOperation } from "@tidytitles/core";
import type { AppState, FileEntry } from "../../../shared/ipc";
import { destinationView, outputFolderFor } from "../destination";
import { baseName } from "../format";
import { operationStatus, type StatusView } from "../status";
import { Icon, type IconName } from "./Icon";
import { MiddleEllipsis } from "./MiddleEllipsis";
import { canCorrect, hasCustomName, rowActions, type RowAction } from "../corrections";
import { RowMenu } from "./RowMenu";

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

/** `--row-h` in styles.css; replaced by the measured height of a row once one is rendered. */
const DEFAULT_ROW_HEIGHT = 28;
/** Extra content rendered above and below the viewport, in pixels. */
const OVERSCAN_PX = 320;

export function StatusBadge({ status }: { status: StatusView }) {
  return (
    <span className={`badge tone-${status.tone}`} title={status.detail} data-testid="status-badge">
      <Icon name={status.icon} size={12} />
      <span>{status.label}</span>
    </span>
  );
}

/** The new name, relative to the file's folder; a destination elsewhere gets a folder mark and its output folder's name. */
function DestinationName({ source, destination, outputFolder }: { source: string; destination: string; outputFolder?: string }) {
  const view = destinationView(source, destination, outputFolder);
  if (!view.elsewhere) return <MiddleEllipsis text={view.text} title={destination} />;
  return (
    <span className="dest-elsewhere" data-testid="dest-elsewhere">
      <Icon name="folder-out" size={12} className="dest-mark" />
      <span className="visually-hidden">In another folder: </span>
      <MiddleEllipsis text={view.text} title={`Goes to ${destination}`} />
    </span>
  );
}

function newNameCell(op: PlannedOperation | undefined, plan: AppState["plan"], output: AppState["output"] | undefined) {
  if (!op || plan === "none") return <span className="muted">—</span>;
  if (op.destination === op.source) return <span className="muted" title="The name stays the same">Unchanged</span>;
  const name = <DestinationName source={op.source} destination={op.destination} outputFolder={outputFolderFor(op, output)} />;
  if (!hasCustomName(op)) return name;
  return (
    <span className="name-with-tag">
      {name}
      <span className="edited-tag" title="You typed this name" data-testid="name-edited">
        Edited
      </span>
    </span>
  );
}

/** One file of the list. */
interface Item {
  file: FileEntry;
  op: PlannedOperation | undefined;
  /** Rows in this group: the file's row plus its associated files. */
  rows: number;
}

/** Stable callbacks shared by every row. */
interface RowHandlers {
  click: (id: number) => void;
  focus: (id: number) => void;
  register: (id: number, el: HTMLTableRowElement | null) => void;
  /** Open the row's actions menu at a viewport position. */
  menu: (id: number, at: { x: number; y: number }) => void;
}

interface FileRowProps {
  file: FileEntry;
  op: PlannedOperation | undefined;
  plan: AppState["plan"];
  /** The output folders, to label destinations in them. */
  output?: AppState["output"];
  /** How associated files travel with the file. */
  transfer?: AppState["options"]["transferMode"];
  selected: boolean;
  tabStop: boolean;
  /** aria-rowindex of the file's row (the header is row 1). */
  rowIndex: number;
  handlers: RowHandlers;
  /** The row offers its actions (a plan is waiting and nothing else runs). */
  actionable: boolean;
}

/** A file's row and its associated-file rows. Re-renders only when its own props change. */
const FileRow = memo(function FileRow({ file, op, plan, output, transfer, selected, tabStop, rowIndex, handlers, actionable }: FileRowProps) {
  const status = operationStatus(op, plan);
  const original = op ? baseName(op.source) : file.name;
  const originalPath = op ? op.source : file.path;
  const id = file.id;
  return (
    <>
      <tr
        ref={(el) => handlers.register(id, el)}
        className={selected ? "selected" : undefined}
        data-tone={status.rowTone}
        aria-selected={selected}
        aria-rowindex={rowIndex}
        tabIndex={tabStop ? 0 : -1}
        onClick={() => handlers.click(id)}
        onFocus={() => handlers.focus(id)}
        onContextMenu={(event) => {
          if (!actionable) return;
          event.preventDefault();
          handlers.click(id);
          handlers.menu(id, { x: event.clientX, y: event.clientY });
        }}
        data-testid="file-row"
      >
        <td className="cell-type">
          <Icon name={file.kind === "audio" ? "music" : "film"} size={14} />
          <span>{file.kind === "audio" ? "Audio" : "Video"}</span>
        </td>
        <td>
          <MiddleEllipsis text={original} title={originalPath} />
        </td>
        <td className="cell-arrow" aria-hidden="true">
          {op && plan !== "none" && op.destination !== op.source ? "→" : ""}
        </td>
        <td>{newNameCell(op, plan, output)}</td>
        <td>
          <StatusBadge status={status} />
        </td>
        <td className="cell-actions">
          {actionable && (
            <button
              type="button"
              className="row-action"
              aria-label={`Actions for ${original}`}
              aria-haspopup="menu"
              title="Change the match or the new name"
              tabIndex={tabStop ? 0 : -1}
              onClick={(event) => {
                event.stopPropagation();
                handlers.click(id);
                const rect = event.currentTarget.getBoundingClientRect();
                handlers.menu(id, { x: rect.left, y: rect.bottom + 2 });
              }}
              data-testid="row-actions"
            >
              <Icon name="more" size={14} />
            </button>
          )}
        </td>
      </tr>
      {op && plan !== "none"
        ? op.associatedFiles.map((assoc, i) => (
            <tr key={assoc.source} className="assoc-row" data-tone={status.rowTone} aria-rowindex={rowIndex + 1 + i}>
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
                <DestinationName source={op.source} destination={assoc.destination} outputFolder={outputFolderFor(op, output)} />
              </td>
              <td>
                <span className="muted assoc-note">
                  {transfer === "copy" ? "Copied with the file" : transfer === "hardlink" ? "Linked with the file" : "Moves with the file"}
                </span>
              </td>
              <td />
            </tr>
          ))
        : null}
    </>
  );
});

/** Stands in for groups that are not rendered. */
function Spacer({ height }: { height: number }) {
  return (
    <tr className="spacer-row" aria-hidden="true">
      <td colSpan={6} style={{ height }} />
    </tr>
  );
}

/** The first index whose group ends below `y` (offsets has one more entry than groups). */
function groupAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const heightKey = (item: Item) => `${item.file.id}:${item.rows}`;

export interface FileTableProps {
  app: AppState;
  selectedFileId: number | null;
  onSelect: (id: number | null) => void;
  onRemove: (ids: number[]) => void;
  /** A row action (change match, edit name, ...) was chosen. */
  onAction?: (id: number, action: RowAction) => void;
}

export const FileTable = memo(function FileTable({ app, selectedFileId, onSelect, onRemove, onAction }: FileTableProps) {
  const { files, operations, plan, busy } = app;
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const focusPending = useRef(false);
  /** Measured group heights, by file id and row count. */
  const heights = useRef(new Map<string, number>());
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [heightsVersion, heightsChanged] = useReducer((n: number) => n + 1, 0);
  const [viewport, setViewport] = useState(() => ({
    top: 0,
    // Until the container is measured (and in jsdom, which has no layout), assume a window's height.
    height: typeof window === "undefined" ? 800 : window.innerHeight,
    width: 0,
  }));

  const items: Item[] = useMemo(
    () =>
      files.map((file, i) => {
        const op = operations?.[i];
        return { file, op, rows: 1 + (op && plan !== "none" ? op.associatedFiles.length : 0) };
      }),
    [files, operations, plan],
  );
  const indexById = useMemo(() => new Map(items.map((item, i) => [item.file.id, i])), [items]);

  // Forget heights of files no longer in the list.
  useEffect(() => {
    const keep = new Set(items.map(heightKey));
    for (const key of heights.current.keys()) if (!keep.has(key)) heights.current.delete(key);
  }, [items]);

  /** offsets[i]: top of group i within the body; ariaRows[i]: aria-rowindex of its file row. */
  const layout = useMemo(() => {
    const n = items.length;
    const offsets = new Float64Array(n + 1);
    const ariaRows = new Int32Array(n + 1);
    ariaRows[0] = 2;
    for (let i = 0; i < n; i++) {
      const item = items[i]!;
      offsets[i + 1] = offsets[i]! + (heights.current.get(heightKey(item)) ?? item.rows * rowHeight);
      ariaRows[i + 1] = ariaRows[i]! + item.rows;
    }
    return { offsets, ariaRows };
    // heightsVersion: the heights map (a ref) changed.
  }, [items, rowHeight, heightsVersion]);

  // The first row is reachable with Tab even before anything is selected.
  const tabStopId = selectedFileId ?? items[0]?.file.id ?? null;
  const tabStopIndex = tabStopId === null ? -1 : (indexById.get(tabStopId) ?? -1);

  // The row that has keyboard focus (it may differ from the tab stop after Escape).
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const focusedIndex = focusedId === null ? -1 : (indexById.get(focusedId) ?? -1);

  // Groups to render: those near the viewport, plus the tab stop and the focused row.
  const headerHeight = headRef.current?.offsetHeight ?? DEFAULT_ROW_HEIGHT;
  const bodyTop = viewport.top - headerHeight;
  const start = groupAt(layout.offsets, Math.max(0, bodyTop - OVERSCAN_PX));
  const end = Math.min(items.length, groupAt(layout.offsets, bodyTop + viewport.height + OVERSCAN_PX) + 1);
  const pinned = [...new Set([tabStopIndex, focusedIndex])].filter((i) => i >= 0 && (i < start || i >= end));
  pinned.sort((a, b) => a - b);
  const rendered: number[] = [...pinned.filter((i) => i < start)];
  for (let i = start; i < end; i++) rendered.push(i);
  rendered.push(...pinned.filter((i) => i >= end));

  // The open actions menu.
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const actionable = canCorrect(app) && onAction !== undefined;
  useEffect(() => {
    if (!actionable) setMenu(null);
  }, [actionable]);

  // Latest values for the stable callbacks.
  const latest = useRef({ selectedFileId, onSelect });
  latest.current = { selectedFileId, onSelect };
  const handlers = useMemo<RowHandlers>(
    () => ({
      click: (id) => latest.current.onSelect(id),
      focus: (id) => {
        setFocusedId(id);
        if (latest.current.selectedFileId === null) latest.current.onSelect(id);
      },
      register: (id, el) => {
        if (el) rowRefs.current.set(id, el);
        else rowRefs.current.delete(id);
      },
      menu: (id, at) => setMenu({ id, ...at }),
    }),
    [],
  );

  // Track the viewport.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    setViewport((v) => (v.top === top ? v : { ...v, top }));
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => {
      const height = el.clientHeight;
      const width = el.clientWidth;
      if (height > 0) setViewport((v) => (v.height === height && v.width === width ? v : { ...v, height, width }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Measure what was rendered; keep the visible rows still if groups above them changed size.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const viewTop = el.getBoundingClientRect().top + (headRef.current?.offsetHeight ?? 0);
    let changed = false;
    let shift = 0;
    let firstRow = 0;
    for (const i of rendered) {
      const item = items[i]!;
      const tr = rowRefs.current.get(item.file.id);
      if (!tr) continue;
      const rect = tr.getBoundingClientRect();
      if (rect.height <= 0) continue; // not laid out (e.g. jsdom)
      if (firstRow === 0) firstRow = rect.height;
      let height = rect.height;
      let bottom = rect.bottom;
      let row: Element | null = tr;
      for (let r = 1; r < item.rows; r++) {
        row = row?.nextElementSibling ?? null;
        if (!row) break;
        const assocRect = row.getBoundingClientRect();
        height += assocRect.height;
        bottom = assocRect.bottom;
      }
      const key = heightKey(item);
      const assumed = heights.current.get(key) ?? item.rows * rowHeight;
      if (Math.abs(height - assumed) > 0.5) {
        changed = true;
        // A group entirely above the viewport pushed the visible rows down (or up).
        if (bottom <= viewTop) shift += height - assumed;
      }
      heights.current.set(key, height);
    }
    if (shift !== 0) el.scrollTop += shift;
    if (firstRow > 0 && Math.abs(firstRow - rowHeight) > 0.5) setRowHeight(firstRow);
    else if (changed) heightsChanged();
  });

  // Focus the newly selected row once it is rendered (it may have been off-screen).
  useEffect(() => {
    if (focusPending.current && selectedFileId !== null) {
      rowRefs.current.get(selectedFileId)?.focus();
      focusPending.current = false;
    }
  }, [selectedFileId]);

  const move = (delta: number | "start" | "end") => {
    if (items.length === 0) return;
    const index = selectedFileId === null ? -1 : (indexById.get(selectedFileId) ?? -1);
    let next: number;
    if (delta === "start") next = 0;
    else if (delta === "end") next = items.length - 1;
    else next = index < 0 ? 0 : Math.min(items.length - 1, Math.max(0, index + delta));
    const id = items[next]!.file.id;
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
        if (selectedFileId !== null && busy === null) {
          const index = indexById.get(selectedFileId) ?? -1;
          const neighbor = items[index + 1] ?? items[index - 1];
          onRemove([selectedFileId]);
          focusPending.current = true;
          onSelect(neighbor ? neighbor.file.id : null);
        }
        break;
      case "Escape":
        onSelect(null);
        return;
      case "Enter":
      case "F2":
      case "ContextMenu":
      case "F10": {
        // Keys on the row itself (not on its actions button).
        const row = event.target as HTMLElement;
        if (row.tagName !== "TR" || !actionable || selectedFileId === null) return;
        if (event.key === "F10" && !event.shiftKey) return;
        if (event.key === "Enter") onAction!(selectedFileId, "changeMatch");
        else if (event.key === "F2") {
          if (!rowActions(items[indexById.get(selectedFileId) ?? -1]?.op).find((a) => a.action === "editName")?.enabled) return;
          onAction!(selectedFileId, "editName");
        } else {
          const button = row.querySelector(".row-action");
          const rect = (button ?? row).getBoundingClientRect();
          setMenu({ id: selectedFileId, x: rect.left, y: rect.bottom + 2 });
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  // Rendered groups, with spacers for the gaps. A spacer is keyed by the group
  // after it, so keyed children always stay in list order and React never
  // moves a row in the DOM (moving the focused row would blur it).
  const body: ReactNode[] = [];
  let cursor = 0;
  for (const i of rendered) {
    const gap = layout.offsets[i]! - layout.offsets[cursor]!;
    if (gap > 0) body.push(<Spacer key={`gap-${i}`} height={gap} />);
    const item = items[i]!;
    body.push(
      <FileRow
        key={`f${item.file.id}`}
        file={item.file}
        op={item.op}
        plan={plan}
        output={app.output}
        transfer={app.options.transferMode}
        selected={item.file.id === selectedFileId}
        tabStop={item.file.id === tabStopId}
        rowIndex={layout.ariaRows[i]!}
        handlers={handlers}
        actionable={actionable}
      />,
    );
    cursor = i + 1;
  }
  const rest = layout.offsets[items.length]! - layout.offsets[cursor]!;
  if (rest > 0) body.push(<Spacer key="gap-end" height={rest} />);

  return (
    <div className="table-scroll" data-testid="file-table" ref={scrollRef} onScroll={onScroll}>
      <table
        className="file-table"
        role="grid"
        aria-readonly="true"
        aria-label="Files"
        aria-rowcount={layout.ariaRows[items.length]! - 1}
      >
        <colgroup>
          <col className="col-type" />
          <col className="col-name" />
          <col className="col-arrow" />
          <col className="col-name" />
          <col className="col-status" />
          <col className="col-actions" />
        </colgroup>
        <thead ref={headRef}>
          <tr aria-rowindex={1}>
            <th scope="col">Type</th>
            <th scope="col">Original name</th>
            <th scope="col" aria-label="becomes" />
            <th scope="col">New name</th>
            <th scope="col">Status</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
          }}
        >
          {body}
        </tbody>
      </table>
      {menu && actionable && (() => {
        const item = items[indexById.get(menu.id) ?? -1];
        if (!item) return null;
        const close = (refocus: boolean) => {
          setMenu(null);
          if (refocus) rowRefs.current.get(menu.id)?.focus();
        };
        return (
          <RowMenu
            items={rowActions(item.op)}
            x={menu.x}
            y={menu.y}
            label={`Actions for ${item.file.name}`}
            onClose={close}
            onAction={(action) => {
              close(true);
              onAction!(menu.id, action);
            }}
          />
        );
      })()}
    </div>
  );
});
