/** Small stroke icons (16px grid), drawn inline so the CSP needs no image sources. */

export type IconName =
  | "file-plus"
  | "folder-plus"
  | "trash"
  | "gear"
  | "undo"
  | "search"
  | "stop"
  | "rename"
  | "check"
  | "user-check"
  | "alert"
  | "x"
  | "info"
  | "dot"
  | "minus"
  | "film"
  | "music"
  | "subtitle"
  | "doc"
  | "image"
  | "eye"
  | "eye-off"
  | "drop"
  | "external"
  | "download"
  | "restart"
  | "folder-out"
  | "history";

const PATHS: Record<IconName, string> = {
  "file-plus": "M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5ZM9 1.5v4h4M8 7.5v5M5.5 10h5",
  "folder-plus": "M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.6h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4ZM8 6.8v4.4M5.8 9h4.4",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5",
  gear: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM13.2 9.6l1.1.8-1.3 2.3-1.3-.5a5 5 0 0 1-1.3.8L10.2 14.3H7.6l-.2-1.3a5 5 0 0 1-1.3-.8l-1.3.5-1.3-2.3 1.1-.8a5 5 0 0 1 0-1.5L3.5 7.3l1.3-2.3 1.3.5a5 5 0 0 1 1.3-.8L7.6 3.4h2.6l.2 1.3a5 5 0 0 1 1.3.8l1.3-.5 1.3 2.3-1.1.8a5 5 0 0 1 0 1.5Z",
  undo: "M5 3 2 6l3 3M2.5 6H10a3.5 3.5 0 0 1 0 7H6",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM10.6 10.6 14 14",
  stop: "M4 4h8v8H4z",
  rename: "M2 13.5h3l8-8-3-3-8 8v3ZM8.5 4l3 3",
  check: "M3 8.5 6.5 12 13 4.5",
  "user-check": "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 14a4.5 4.5 0 0 1 8.2-2.6M10 12l1.6 1.6L15 10",
  alert: "M8 1.8 15 14H1L8 1.8ZM8 6.3v3.6M8 11.6v.4",
  x: "M4 4l8 8M12 4l-8 8",
  info: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 7.2v4.3M8 4.8v.4",
  dot: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  minus: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM5 8h6",
  film: "M2.5 2.5h11v11h-11zM5 2.5v11M11 2.5v11M2.5 5.5H5M2.5 10.5H5M11 5.5h2.5M11 10.5h2.5M5 8h6",
  music: "M6 12.5V3l7.5-1.5V11M6 12.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM13.5 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  subtitle: "M1.5 3.5h13v9h-13zM4 8.5h3M8.5 8.5H12M4 10.5h5.5M11 10.5h1",
  doc: "M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5ZM9 1.5v4h4M5.5 8.5h5M5.5 11h5",
  image: "M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2L14 12M10.5 6.5h.1",
  eye: "M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  "eye-off": "M2 2l12 12M6.6 3.2A6.6 6.6 0 0 1 8 3c4.5 0 7 5 7 5a12 12 0 0 1-1.9 2.5M4.2 4.3C2.2 5.6 1 8 1 8s2.5 5 7 5a6.8 6.8 0 0 0 3-.7M6.6 6.6a2 2 0 0 0 2.8 2.8",
  drop: "M8 2v8M4.5 6.5 8 10l3.5-3.5M2 11v2.5h12V11",
  external: "M9.5 2.5h4v4M13.5 2.5 7 9M12 9.5V13a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 3 13V5a.5.5 0 0 1 .5-.5H7",
  download: "M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11",
  restart: "M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2v3h-3",
  "folder-out": "M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.6h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4ZM6 9h4.5M8.8 7.2 10.6 9l-1.8 1.8",
  history: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4",
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
