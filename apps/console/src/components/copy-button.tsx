import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Check, Copy } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/** The caller keeps the value selectable if clipboard access is unavailable. */
export function CopyButton({
  value,
  label = 'Copy',
  disabled = false,
  className,
  size = 'sm',
  iconOnly = false,
}: {
  value: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'default';
  iconOnly?: boolean;
}) {
  const [status, setStatus] = useState('');
  const currentValue = useRef(value);
  currentValue.current = value;
  useEffect(() => setStatus(''), [value]);
  useEffect(() => {
    if (status !== 'Copied.') return;
    const timeout = setTimeout(() => setStatus(''), 2500);
    return () => clearTimeout(timeout);
  }, [status]);
  const control = (
    <Button
      type="button"
      variant="outline"
      size={iconOnly ? 'icon' : size}
      className={`${iconOnly ? 'size-9 min-h-9 min-w-9' : ''} ${className ?? ''}`}
      disabled={disabled}
      aria-label={status === 'Copied.' ? `Copied — ${label}` : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          if (currentValue.current === value) setStatus('Copied.');
        } catch {
          if (currentValue.current === value)
            setStatus('Clipboard unavailable. Select and copy the text instead.');
        }
      }}
    >
      <span className={iconOnly ? 'sr-only' : undefined}>
        {status === 'Copied.' ? 'Copied' : label}
      </span>
      {status === 'Copied.' ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </Button>
  );
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild data-slot="button">
            {control}
          </TooltipTrigger>
          <TooltipContent>{status === 'Copied.' ? 'Copied' : label}</TooltipContent>
        </Tooltip>
      ) : (
        control
      )}
      <span
        role="status"
        className={status === 'Copied.' || !status ? 'sr-only' : 'text-sm text-muted-foreground'}
      >
        {status}
      </span>
    </span>
  );
}
