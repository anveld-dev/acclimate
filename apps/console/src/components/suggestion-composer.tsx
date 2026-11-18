import { useId } from 'react';
import { GitBranch, ShieldCheck } from 'lucide-react';
import type { BundlePayload, ChannelResolution } from '@acclimate/sdk';
import { EditablePaths } from './editable-paths';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

export interface SuggestionComposerProps {
  files: BundlePayload['files'];
  channel: string;
  revision: ChannelResolution['revision'];
  parentVersionId: string;
  parentDigest: string;
  hypothesis: string;
  evidence: string;
  paths: string[];
  consent: boolean;
  canEdit: boolean;
  busy: boolean;
  pending: boolean;
  blocked: boolean;
  blockedReason?: string;
  onHypothesisChange(value: string): void;
  onEvidenceChange(value: string): void;
  onPathsChange(value: string[]): void;
  onConsentChange(value: boolean): void;
  onSubmit(): void;
}

export function SuggestionComposer(props: SuggestionComposerProps) {
  const readinessId = useId();
  const missing = [
    !props.hypothesis.trim() && 'a hypothesis',
    !props.paths.length && 'an editable path',
    !props.consent && 'consent',
  ].filter(Boolean);
  const readiness = !props.canEdit
    ? 'You have read-only access.'
    : props.busy
      ? 'Waiting for the current operation…'
      : props.pending
        ? 'A previous submission is awaiting confirmation.'
        : props.blocked
          ? props.blockedReason || 'A related operation blocks this request.'
          : missing.length
            ? `Required: ${missing.join(', ')}.`
            : 'Ready to request a suggestion.';
  const disabled = props.busy || !props.canEdit;
  return (
    <section className="proposal-workspace suggestion-composer" aria-label="Suggest a change">
      <header className="suggestion-composer-header">
        <h2>Suggest a change</h2>
        <span className="suggestion-release">
          <GitBranch aria-hidden="true" /> Based on {props.channel} · revision {props.revision}
        </span>
      </header>
      <p>
        Describe the change and choose which files the provider may edit. You’ll review its
        suggestion before publishing.
      </p>
      <Disclosure className="text-muted-foreground">
        <DisclosureTrigger>Source release details</DisclosureTrigger>
        <DisclosureContent>
          <p className="mt-2 break-all">
            Published parent: {props.parentVersionId} · {props.parentDigest}
          </p>
        </DisclosureContent>
      </Disclosure>
      <div className="suggestion-composer-grid">
        <div className="suggestion-brief">
          <div>
            <Label htmlFor="proposal-hypothesis">Hypothesis</Label>
            <Textarea
              id="proposal-hypothesis"
              placeholder="What change would improve the result?"
              disabled={disabled}
              value={props.hypothesis}
              onChange={(event) => props.onHypothesisChange(event.target.value)}
            />
          </div>
          <div>
            <div className="suggestion-field-heading">
              <Label htmlFor="proposal-evidence">Authorized evidence (one item per line)</Label>
              <span id="proposal-evidence-hint">Optional</span>
            </div>
            <Textarea
              id="proposal-evidence"
              aria-describedby="proposal-evidence-hint"
              disabled={disabled}
              value={props.evidence}
              onChange={(event) => props.onEvidenceChange(event.target.value)}
            />
          </div>
        </div>
        <EditablePaths
          files={props.files}
          paths={props.paths}
          disabled={disabled}
          onPathsChange={props.onPathsChange}
        />
      </div>
      <div className="suggestion-consent">
        <h3>
          <ShieldCheck aria-hidden="true" /> Provider access
        </h3>
        <p>
          The operator-configured provider receives the whole parent bundle, including reusable
          memory, and this evidence. Editable paths restrict changes, not reading. Private session
          memory remains app-owned.
        </p>
        <Label className="flex min-h-8 min-w-0 items-start gap-2">
          <Checkbox
            aria-label="Authorize bundle disclosure"
            disabled={disabled}
            checked={props.consent}
            onCheckedChange={(checked) => props.onConsentChange(checked === true)}
          />
          <span>
            I authorize sharing the entire selected bundle and supplied evidence with the provider.
          </span>
        </Label>
      </div>
      <div className="suggestion-submit-row">
        <Button
          type="button"
          aria-describedby={readinessId}
          disabled={disabled || props.pending || props.blocked || missing.length > 0}
          onClick={props.onSubmit}
        >
          Request suggestion
        </Button>
        <p id={readinessId}>{readiness}</p>
      </div>
    </section>
  );
}
