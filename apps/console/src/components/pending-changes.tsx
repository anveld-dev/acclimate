import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from '@tanstack/react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type PendingContext = {
  hasPendingChanges: boolean;
  discardVersion: number;
  setPendingChanges: (pending: boolean) => void;
  confirmDiscard: (action: () => void) => void;
};
const Context = createContext<PendingContext | null>(null);

function invokingControl(element: HTMLElement): HTMLElement {
  // A menu item disappears when it launches the confirmation. Return to its
  // persistent trigger instead of retaining a detached item as the focus target.
  const menu = element.closest('[role="menu"][aria-labelledby]');
  const triggerId = menu?.getAttribute('aria-labelledby')?.split(/\s+/)[0];
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  return trigger instanceof HTMLElement ? trigger : element;
}

export function PendingChangesProvider({ children }: { children: ReactNode }) {
  const [pending, setPendingChanges] = useState(false);
  const [discardVersion, setDiscardVersion] = useState(0);
  const [action, setAction] = useState<(() => void) | null>(null);
  const invokingElement = useRef<HTMLElement | null>(null);
  const blocker = useBlocker({
    shouldBlockFn: () => {
      if (pending && document.activeElement instanceof HTMLElement)
        invokingElement.current = invokingControl(document.activeElement);
      return pending;
    },
    enableBeforeUnload: pending,
    withResolver: true,
  });
  const confirmDiscard = useCallback(
    (next: () => void) => {
      if (pending) {
        if (document.activeElement instanceof HTMLElement)
          invokingElement.current = invokingControl(document.activeElement);
        setAction(() => next);
      } else next();
    },
    [pending],
  );
  function cancel() {
    setAction(null);
    if (blocker.status === 'blocked') blocker.reset();
  }
  function proceed() {
    setDiscardVersion((value) => value + 1);
    setPendingChanges(false);
    setAction(null);
    if (blocker.status === 'blocked') blocker.proceed();
    else action?.();
  }
  return (
    <Context.Provider
      value={{ setPendingChanges, confirmDiscard, discardVersion, hasPendingChanges: pending }}
    >
      {children}
      <AlertDialog
        open={Boolean(action) || blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            const element = invokingElement.current;
            invokingElement.current = null;
            event.preventDefault();
            if (
              element?.isConnected &&
              element.getClientRects().length &&
              !element.matches(':disabled')
            ) {
              element.focus();
            } else document.getElementById('main')?.focus({ preventScroll: true });
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Leave current edits?</AlertDialogTitle>
            <AlertDialogDescription>Unsaved bundle setup text will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                proceed();
              }}
            >
              Leave editor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Context.Provider>
  );
}
export function usePendingChanges() {
  const context = useContext(Context);
  if (!context) throw new Error('Pending changes provider is missing');
  return context;
}
