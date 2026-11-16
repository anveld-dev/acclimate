import type { ComponentProps } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { buttonVariants } from './button';

/** Compact application composition of the shadcn Collapsible primitives. */
function Disclosure(props: ComponentProps<typeof Collapsible>) {
  return <Collapsible data-slot="disclosure" {...props} />;
}

function DisclosureTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="disclosure-trigger"
      className={cn(
        buttonVariants({ variant: 'ghost' }),
        'group/disclosure-trigger h-auto min-h-8 max-w-full justify-start gap-2 px-0 py-1 text-left whitespace-normal',
        className,
      )}
      {...props}
    >
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/disclosure-trigger:rotate-90"
      />
      <span className="min-w-0">{children}</span>
    </CollapsibleTrigger>
  );
}

function DisclosureContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      forceMount
      data-slot="disclosure-content"
      className={cn('min-w-0', className)}
      {...props}
    />
  );
}

export { Disclosure, DisclosureTrigger, DisclosureContent };
