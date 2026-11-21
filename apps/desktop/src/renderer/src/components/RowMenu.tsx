/**
 * The actions menu of a file row (the "…" button, the context menu key,
 * Shift+F10, or a right-click). A menu button pattern: arrow keys move
 * between items, Enter or Space runs one, Escape and Tab close it and give
 * focus back to where it was.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RowAction, RowActionItem } from "../corrections";

export interface RowMenuProps {
  items: RowActionItem[];
  /** Viewport position of the menu's top left corner. */
  x: number;
  y: number;
  /** Accessible name, e.g. "Actions for Inception.mkv". */
  label: string;
  onAction: (action: RowAction) => void;
  /** Close without an action; `refocus` gives focus back to the row. */
  onClose: (refocus: boolean) => void;
}

export function RowMenu({ items, x, y, label, onAction, onClose }: RowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.map((item, i) => (item.enabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState(enabled[0] ?? -1);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: y + height > window.innerHeight - 4 ? Math.max(4, y - height) : y,
    });
  }, [x, y]);

  useEffect(() => {
    if (active < 0) ref.current?.focus();
    else ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[active]?.focus();
  }, [active]);

  // A click anywhere else closes the menu.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    const onBlur = () => onClose(false);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  const move = (delta: number | "first" | "last") => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    let next: number;
    if (delta === "first") next = 0;
    else if (delta === "last") next = enabled.length - 1;
    else next = (at + delta + enabled.length) % enabled.length;
    setActive(enabled[next]!);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        move("first");
        break;
      case "End":
        move("last");
        break;
      case "Escape":
        onClose(true);
        break;
      case "Tab":
        onClose(true);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="row-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
      data-testid="row-menu"
    >
      {items.map((item, i) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className="row-menu-item"
          tabIndex={i === active ? 0 : -1}
          disabled={!item.enabled}
          aria-disabled={!item.enabled}
          onClick={() => item.enabled && onAction(item.action)}
          onMouseEnter={() => item.enabled && setActive(i)}
          data-testid={`row-action-${item.action}`}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <kbd className="row-menu-shortcut" aria-hidden="true">
              {item.shortcut}
            </kbd>
          )}
        </button>
      ))}
    </div>
  );
}
