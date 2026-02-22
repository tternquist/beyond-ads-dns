import { createContext, useContext, useState, useCallback } from "react";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

/**
 * ConfirmContext provides a global confirm dialog for destructive or important actions.
 * Hooks and components call confirm(options) to show the dialog without prop drilling.
 */
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState({ open: false });

  const confirm = useCallback((options) => {
    setState({
      open: true,
      title: options.title ?? "Confirm",
      message: options.message ?? "",
      confirmLabel: options.confirmLabel ?? "Confirm",
      cancelLabel: options.cancelLabel ?? "Cancel",
      variant: options.variant ?? "primary",
      onConfirm: options.onConfirm,
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (state.onConfirm) state.onConfirm();
    setState({ open: false });
  }, [state.onConfirm]);

  const handleCancel = useCallback(() => {
    setState({ open: false });
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <ConfirmDialog
        open={state.open}
        title={state.title}
        message={state.message}
        confirmLabel={state.confirmLabel}
        cancelLabel={state.cancelLabel}
        variant={state.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
