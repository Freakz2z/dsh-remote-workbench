import { useEffect, useRef, type FormEvent, type ReactNode } from "react";

/**
 * Shared DSH-styled modal container: Escape to close, backdrop click to close
 * (unless busy), and focus restoration when unmounted.
 */
export function Modal({
  ariaLabel,
  className = "",
  busy = false,
  onClose,
  children,
  form = false,
  onSubmit,
}: {
  ariaLabel: string;
  className?: string;
  busy?: boolean;
  onClose(): void;
  children: ReactNode;
  form?: boolean;
  onSubmit?(e: FormEvent<HTMLFormElement>): void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !busy) onClose();
  };

  return (
    <div className="rw-modal-backdrop" onMouseDown={handleBackdrop}>
      {form ? (
        <form
          className={`rw-modal ${className}`.trim()}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          onSubmit={onSubmit}
        >
          {children}
        </form>
      ) : (
        <section
          className={`rw-modal ${className}`.trim()}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
        >
          {children}
        </section>
      )}
    </div>
  );
}

/**
 * DSH-styled confirmation dialog replacing native `window.confirm`. Supports
 * an optional secondary action (e.g. "保存并关闭" for dirty tabs).
 */
export function ConfirmDialog({
  title,
  description,
  confirm,
  cancel = "取消",
  danger = false,
  secondaryLabel,
  onSecondary,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
  secondaryLabel?: string;
  onSecondary?(): void | Promise<void>;
  busy?: boolean;
  onConfirm(): void | Promise<void>;
  onClose(): void;
}) {
  return (
    <Modal
      ariaLabel={title}
      className="rw-action-dialog"
      busy={busy}
      onClose={onClose}
    >
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      <footer>
        <button
          type="button"
          className="rw-button"
          disabled={busy}
          onClick={onClose}
        >
          {cancel}
        </button>
        {secondaryLabel && onSecondary && (
          <button
            type="button"
            className="rw-button primary"
            disabled={busy}
            onClick={() => void onSecondary()}
          >
            {secondaryLabel}
          </button>
        )}
        <button
          type="button"
          className={`rw-button ${danger ? "destructive" : secondaryLabel ? "" : "primary"}`}
          disabled={busy}
          autoFocus
          onClick={() => void onConfirm()}
        >
          {busy ? "处理中…" : confirm}
        </button>
      </footer>
    </Modal>
  );
}
