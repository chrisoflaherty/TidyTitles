import { useEffect, useId, useRef, type ReactNode } from "react";

export interface DialogProps {
  title: string;
  /** Escape key or the close request: the dialog's "cancel" meaning. */
  onCancel: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Element id to describe the dialog (for screen readers). */
  describedBy?: string;
  /** Called with the form submit (Enter in a field, or a submit button). */
  onSubmit?: () => void;
  testId?: string;
}

/**
 * A modal built on the native `<dialog>`: `showModal()` makes the rest of
 * the window inert, traps focus, and maps Escape to `cancel`.
 */
export function Dialog({ title, onCancel, children, footer, className, describedBy, onSubmit, testId }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const cancel = (event: Event) => {
      event.preventDefault();
      onCancelRef.current();
    };
    dialog.addEventListener("cancel", cancel);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={className ? `dialog ${className}` : "dialog"}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      <form
        className="dialog-form"
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </form>
    </dialog>
  );
}
