import { useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { CopyButton } from './copy-button';

/** Keep technical identities available without making every history row a form. */
export function ChangeRecordDetails({
  title,
  identity,
  description,
  fields,
  value,
  copyLabel,
  triggerLabel = title,
}: {
  title: string;
  identity?: string;
  description: string;
  fields: [string, ReactNode][];
  value: string;
  copyLabel: string;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild data-slot="button">
          <DialogTrigger asChild data-slot="button">
            <Button
              ref={trigger}
              variant="ghost"
              size="icon"
              className="change-record-details-trigger"
              aria-label={triggerLabel}
            >
              <Info aria-hidden="true" className="size-4" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          hidden={open}
          className="change-record-details-tooltip max-w-[min(20rem,var(--radix-tooltip-content-available-width))] break-all"
        >
          {triggerLabel}
        </TooltipContent>
      </Tooltip>
      <DialogContent returnFocusRef={trigger} className="change-record-details-dialog sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {title}
            {identity && <span className="sr-only"> · {identity}</span>}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <dl className="change-record-detail-fields">
          {fields.map(([label, content]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{content}</dd>
            </div>
          ))}
        </dl>
        <CopyButton value={value} label={copyLabel} />
      </DialogContent>
    </Dialog>
  );
}
