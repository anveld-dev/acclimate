import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Bookmark, Check, Clipboard, Code2, FileText, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { BundleFile, FileKind } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import { WorkspaceMenuButton } from './workspace-chrome';
import { PageHeader } from './page-header';

export type ReadyConsole = Extract<ConsoleState, { status: 'ready' }>;
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
              ? `Last read at ${state.lastSuccessfulRead}. Content is hidden until a verified refresh succeeds.`
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
export function ShortId({ value }: { value: string }) {
  return (
    <code className="id-text" title={value}>
      {value.slice(0, 8)}
    </code>
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
export function fileDirectory(file: BundleFile) {
  return file.path.split('/').slice(0, -1).join('/') + '/';
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
export function SourceNote({ state }: { state: ReadyConsole }) {
  return (
    <p className="source-note">
      <Info className="size-4 shrink-0" aria-hidden="true" />
      <span>
        {state.source.kind === 'seeded-example'
          ? 'Example content'
          : state.source.kind === 'imported'
            ? 'Imported content'
            : 'Bundle content'}{' '}
        stored in PostgreSQL. Edits and releases are real; your project files are not changed.
      </span>
    </p>
  );
}
export function WorkspaceDetails({ state }: { state: ReadyConsole }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [state.resolution.version.id]);
  const [error, setError] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(state.resolution.version.id);
      setCopied(true);
      setError('');
    } catch {
      setError('Clipboard unavailable. You can select and copy the ID below.');
    }
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Workspace details
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Workspace details</DialogTitle>
          <DialogDescription>
            The service verifies the published payload before displaying its entries.
          </DialogDescription>
        </DialogHeader>
        <dl className="details-grid">
          <dt>Workspace</dt>
          <dd>{state.projectId}</dd>
          <dt>Bundle</dt>
          <dd>
            <code>{state.bundleId}</code>
          </dd>
          <dt>Channel</dt>
          <dd>{state.channel}</dd>
          <dt>Revision</dt>
          <dd>{state.resolution.revision}</dd>
          <dt>Version</dt>
          <dd>
            <code>{state.resolution.version.id}</code>
          </dd>
          <dt>SHA-256</dt>
          <dd>
            <code>{state.resolution.version.digest}</code>
          </dd>
          <dt>Origin</dt>
          <dd>
            {state.source.kind === 'seeded-example'
              ? 'Seeded example, with persisted edits'
              : state.source.kind === 'imported'
                ? 'Imported content'
                : 'Stored bundle'}
          </dd>
          <dt>Storage</dt>
          <dd>PostgreSQL</dd>
        </dl>
        <Button variant="outline" onClick={() => void copy()}>
          {copied ? <Check /> : <Clipboard />}
          {copied ? 'Copied version ID' : 'Copy version ID'}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          These paths are bundle entries. A consuming SDK creates filesystem files when it prepares
          a bundle.
        </p>
      </DialogContent>
    </Dialog>
  );
}
export function ContextStrip({ state }: { state: ReadyConsole }) {
  return (
    <div data-testid="channel-context" className="context-strip">
      <div className="min-w-0 flex-1">
        <div className="context-metadata">
          <span className="inline-flex items-center gap-2">
            <span className="connection-dot" aria-hidden="true" />
            Connected to <strong>{state.projectId}</strong>
          </span>
          <span className="text-muted-foreground">
            Channel <strong className="text-foreground">{state.channel}</strong>
          </span>
          <span className="text-muted-foreground">
            Revision <strong className="text-foreground">{state.resolution.revision}</strong>
          </span>
        </div>
        <p className="context-read-status mt-2">
          Last successful read: {state.lastSuccessfulRead ?? 'Not read yet'}. No app report
          received; delivery unknown.
        </p>
      </div>
      <WorkspaceDetails state={state} />
    </div>
  );
}
