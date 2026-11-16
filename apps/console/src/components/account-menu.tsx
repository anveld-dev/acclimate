import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { ChevronDown, ChevronUp, LogOut, UserRound } from 'lucide-react';
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
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './copy-button';
import { clearPendingOperations, listenForPendingPurge } from '../lib/pending-operation';
import type { AccessState } from '../server/access-core';
import { signInHref } from '../lib/return-destination';

export function AccountMenu({
  access,
  returnTo,
  compact = false,
  iconOnly = false,
  suppressTooltip = false,
}: {
  access: AccessState;
  returnTo?: string;
  compact?: boolean;
  iconOnly?: boolean;
  suppressTooltip?: boolean;
}) {
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const userId = access.ok ? (access.actorScope ?? access.identity?.userId) : undefined;
  const actorKnown = access.ok;
  useEffect(() => {
    try {
      return listenForPendingPurge();
    } catch {
      return;
    }
  }, []);
  useEffect(() => {
    if (!actorKnown) return;
    try {
      const prior = sessionStorage.getItem('acclimate.pending-account');
      if (prior && prior !== (userId ?? '')) clearPendingOperations();
      if (userId) sessionStorage.setItem('acclimate.pending-account', userId);
    } catch {
      /* Pending writes already fail closed when browser storage is unavailable. */
    }
  }, [userId, actorKnown]);
  if (!access.ok || !access.identity) {
    const signIn = (
      <Button
        asChild
        variant="outline"
        size={iconOnly ? 'icon' : compact ? 'sm' : 'default'}
        className={
          iconOnly ? 'workspace-rail-control' : compact ? 'justify-start' : 'w-full justify-start'
        }
      >
        <a href={signInHref(returnTo)} aria-label="Sign in">
          {iconOnly && <UserRound aria-hidden="true" className="size-[18px]" />}
          <span className={iconOnly ? 'sr-only' : undefined}>Sign in</span>
        </a>
      </Button>
    );
    return iconOnly ? (
      <Tooltip>
        <TooltipTrigger asChild data-slot="button">
          {signIn}
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10}>
          Sign in
        </TooltipContent>
      </Tooltip>
    ) : (
      signIn
    );
  }
  const trigger = (
    <DialogTrigger asChild data-slot="button">
      <Button
        ref={returnFocusRef}
        variant="ghost"
        size={iconOnly ? 'icon' : compact ? 'sm' : 'default'}
        className={
          iconOnly
            ? 'workspace-account-trigger workspace-rail-control'
            : compact
              ? 'workspace-account-trigger justify-start gap-2'
              : 'h-10 w-full justify-start gap-3'
        }
        aria-label="Account"
      >
        <span
          className={
            iconOnly
              ? 'workspace-rail-account-icon'
              : `flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ${compact ? 'size-6' : 'size-7'}`
          }
        >
          <UserRound aria-hidden="true" className={iconOnly ? 'size-[18px]' : 'size-4'} />
        </span>
        <span className={iconOnly ? 'sr-only' : undefined}>Account</span>
        {!iconOnly &&
          (compact ? (
            <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronUp aria-hidden="true" className="ml-auto size-3.5 text-muted-foreground" />
          ))}
      </Button>
    </DialogTrigger>
  );
  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild data-slot="button">
            {trigger}
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={10} hidden={dialogOpen || suppressTooltip}>
            Account
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DialogContent returnFocusRef={returnFocusRef} className="account-dialog">
        <DialogHeader>
          <DialogTitle>Your account</DialogTitle>
          <DialogDescription className="sr-only">
            Sign-in identity and account actions.
          </DialogDescription>
        </DialogHeader>
        <div className="account-identity">
          <p className="account-identity-name">
            {access.identity.displayName?.trim() || 'Signed in'}
          </p>
          <p className="account-identity-guidance">
            Ask a workspace administrator to invite your sign-in email.
          </p>
        </div>
        <Disclosure className="account-details">
          <DisclosureTrigger className="account-details-trigger">Sign-in details</DisclosureTrigger>
          <DisclosureContent>
            <dl className="account-details-list">
              <div className="account-details-row">
                <dt>User ID</dt>
                <dd>
                  <code tabIndex={0} className="account-details-value break-all select-all">
                    {access.identity.userId}
                  </code>
                  <CopyButton value={access.identity.userId} label="Copy ID" iconOnly />
                </dd>
              </div>
              <div className="account-details-row">
                <dt>Subject</dt>
                <dd>
                  <code tabIndex={0} className="account-details-value break-all select-all">
                    {access.identity.subject}
                  </code>
                  <CopyButton value={access.identity.subject} label="Copy subject" iconOnly />
                </dd>
              </div>
              <div className="account-details-row">
                <dt>Issuer</dt>
                <dd>
                  <code tabIndex={0} className="account-details-value break-all select-all">
                    {access.identity.issuer}
                  </code>
                  <CopyButton value={access.identity.issuer} label="Copy issuer" iconOnly />
                </dd>
              </div>
            </dl>
          </DisclosureContent>
        </Disclosure>
        <form
          action="/auth/logout"
          method="post"
          onSubmit={() => {
            try {
              clearPendingOperations();
            } catch {
              /* A disabled store has no retained text to purge. */
            }
          }}
        >
          <Button type="submit" variant="outline" className="w-full">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
