import React from "react";
import { useBoardStore } from "../state/boardStore.js";
import { CloseIcon } from "./Icons.js";

export function ToastContainer(): React.JSX.Element | null {
  const { toasts, dismissToast } = useBoardStore();

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-container" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`} role="alert">
          <span className="toast__message">{toast.message}</span>
          <div className="toast__actions">
            {toast.retry && (
              <button
                type="button"
                className="toast__retry"
                onClick={() => {
                  dismissToast(toast.id);
                  toast.retry?.();
                }}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              className="toast__close"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
