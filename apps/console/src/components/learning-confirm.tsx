import { useRef, useState, type ComponentProps, type RefObject } from 'react';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';

/**
 * The confirmation for a learning action, opened by a button or, for an action in a menu,
 * by the caller. `returnFocusRef` names the control that gets focus back when it closes.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  label,
  description,
  onConfirm,
  destructive = false,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  description: string;
  onConfirm: () => void;
  destructive?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent returnFocusRef={returnFocusRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function LearningConfirm({
  label,
  description,
  onConfirm,
  disabled,
  variant = 'outline',
  size = 'default',
  destructive = false,
}: {
  label: string;
  description: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        label={label}
        description={description}
        onConfirm={onConfirm}
        destructive={destructive}
        returnFocusRef={trigger}
      />
    </>
  );
}
