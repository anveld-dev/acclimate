import { ReceiptTime } from './receipt-time';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { Link } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import { AlertCircle, Bookmark, Code2, FileText, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { BundleFile, FileKind } from '@anveld/acclimate-sdk';
import type { ConsoleState } from '../server/channel';
import { WorkspaceMenuButton } from './workspace-chrome';
import { PageHeader } from './page-header';

export function PageTitle({
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      title={title}
      description={description}
      actions={actions}
      utility={<WorkspaceMenuButton />}
    />
  );
}
export function ConnectionNotice({ state }: { state: Exclude<ConsoleState, { status: 'ready' }> }) {
  if (state.status === 'error')
    return (
      <Alert variant="destructive" role="alert" className="connection-notice">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Could not connect</AlertTitle>
        <AlertDescription className="text-sm">
          <p>{state.message} The connection will retry automatically.</p>
          <p>
            {state.lastSuccessfulRead
              ? <>Last read at <ReceiptTime value={state.lastSuccessfulRead} />. Content is hidden until a verified refresh succeeds.</>
              : 'No successful read yet. Current state is unknown.'}
          </p>
        </AlertDescription>
      </Alert>
    );
  return (
    <Alert className="connection-notice" role="status">
      <Info aria-hidden="true" />
      <AlertTitle>Connect a workspace</AlertTitle>
      <AlertDescription className="space-y-3 text-sm">
        <p>No content selected yet. Select a workspace and bundle to view its content.</p>
        <p>
          Sign in to view your workspaces. Ask a workspace administrator for access if your
          workspace is missing.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">Open workspace setup</Link>
        </Button>
        {state.missing.length > 0 && (
          <Disclosure className="text-xs">
            <DisclosureTrigger className="cursor-pointer py-1">
              Connection requirements
            </DisclosureTrigger>
            <DisclosureContent>
              <div className="mt-2 flex flex-wrap gap-2">
                {state.missing.map((key) => (
                  <code key={key} className="id-text">
                    {key}
                  </code>
                ))}
              </div>
            </DisclosureContent>
          </Disclosure>
        )}
      </AlertDescription>
    </Alert>
  );
}
export function FileGlyph({ kind }: { kind: FileKind }) {
  const Icon = kind === 'skill' ? Code2 : kind === 'memory' ? Bookmark : FileText;
  return (
    <span className={`file-glyph file-glyph-${kind}`} aria-hidden="true">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}
export function fileTitle(file: BundleFile) {
  const parts = file.path.split('/');
  return file.kind === 'skill' && parts.at(-1) === 'SKILL.md' ? parts.at(-2)! : parts.at(-1)!;
}
/** Prefer directory boundaries while keeping the exact path copyable. */
export function PathText({ value }: { value: string }) {
  const parts = value.split('/');
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ));
}
export function KindBadge({ kind }: { kind: FileKind }) {
  return (
    <Badge variant="secondary" className="kind-badge">
      {kind === 'instruction' ? 'Instruction' : kind === 'skill' ? 'Skill' : 'Memory'}
    </Badge>
  );
}
