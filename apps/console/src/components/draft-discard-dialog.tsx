import type { RefObject } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

export function DraftDiscardDialog({
  target,
  error,
  busy,
  pending,
  returnFocusRef,
  fallbackFocusRef,
  onClose,
  onDiscard,
}: {
  target: { id: string; generation: number } | null;
  error: string;
  busy: boolean;
  pending: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = returnFocusRef.current;
          const focus =
            trigger?.isConnected &&
            !trigger.matches(':disabled, [aria-disabled="true"]') &&
            trigger.getClientRects().length
              ? trigger
              : fallbackFocusRef.current;
          (focus || document.getElementById('main'))?.focus({ preventScroll: true });
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Discard saved draft?</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            Discard draft {target?.id}, generation {target?.generation}, and any browser edits. The
            published release remains unchanged.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
            {pending &&
              ' Close this dialog to check the result or retry the exact request in Draft recovery details.'}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep draft</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || pending}
            onClick={(event) => {
              event.preventDefault();
              onDiscard();
            }}
          >
            {busy ? 'Discarding…' : 'Discard saved draft'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
