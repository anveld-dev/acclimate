import { useId, useRef, useState } from 'react';
import type React from 'react';
import type { EvaluationPreset, evaluationConfiguration } from '../lib/evaluation-config';
import { CodeEditor } from './code-editor';
import { Button } from './ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { NativeSelect } from './ui/native-select';

export type EvaluationSetupProps = {
  profile: EvaluationPreset | 'custom';
  customConfiguration: string;
  configuration?: ReturnType<typeof evaluationConfiguration>;
  configurationError: string;
  fieldsDisabled: boolean;
  submitDisabled: boolean;
  blockedReason?: string;
  hasRequests: boolean;
  createActionRef: React.RefObject<HTMLButtonElement | null>;
  onProfileChange(profile: EvaluationPreset | 'custom'): void;
  onCustomConfigurationChange(value: string): void;
  onCreate(event: React.MouseEvent<HTMLButtonElement>): void;
};

export function EvaluationSetup({
  profile,
  customConfiguration,
  configuration,
  configurationError,
  fieldsDisabled,
  submitDisabled,
  blockedReason,
  hasRequests,
  createActionRef,
  onProfileChange,
  onCustomConfigurationChange,
  onCreate,
}: EvaluationSetupProps) {
  const [open, setOpen] = useState(!hasRequests);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const instructions = `${id}-instructions`;
  const error = `${id}-error`;
  const prerequisites = `${id}-prerequisites`;
  const valid = configuration && !configurationError ? configuration : undefined;
  return (
    <section className="review-section evaluation-setup" aria-label="Create evaluation request">
      <Disclosure
        open={open}
        onOpenChange={(next) => {
          if (!next && content.current?.contains(document.activeElement)) trigger.current?.focus();
          setOpen(next);
        }}
      >
        <h2>
          <DisclosureTrigger ref={trigger} className="evaluation-setup-title">
            {hasRequests ? 'Create another evaluation request' : 'Set up evaluation request'}
          </DisclosureTrigger>
        </h2>
        <DisclosureContent hidden={!open}>
          <div ref={content} className="evaluation-configuration-form">
            <p className="evaluation-step-label">
              1. Configure · 2. Run in your app · 3. Review evidence
            </p>
            <label className="evaluation-setup-profile">
              Evaluation configuration
              <NativeSelect
                aria-label="Evaluation configuration"
                value={profile}
                disabled={fieldsDisabled}
                onChange={(event) =>
                  onProfileChange(event.target.value as EvaluationPreset | 'custom')
                }
              >
                <option value="custom">My app's installed evaluator</option>
                <optgroup label="Examples from this checkout">
                  <option value="payment-retry">
                    Example: Payment retry simulator · model-free
                  </option>
                  <option value="presence-contract">
                    Example: File presence contract · model-free
                  </option>
                  <option value="codex-luna-review">Example: Native Codex review · Luna</option>
                </optgroup>
              </NativeSelect>
            </label>
            <div className="evaluation-setup-grid">
              <div className="evaluation-setup-author">
                {profile === 'custom' && (
                  <div className="evaluation-setup-editor">
                    <div>Public evaluator configuration (JSON)</div>
                    <CodeEditor
                      language="json"
                      aria-label="Public evaluator configuration (JSON)"
                      aria-describedby={`${instructions}${configurationError ? ` ${error}` : ''}`}
                      aria-invalid={!!configurationError}
                      value={customConfiguration}
                      disabled={fieldsDisabled}
                      onChange={onCustomConfigurationChange}
                    />
                    <p id={instructions} className="text-muted-foreground">
                      Paste the configuration your installed app describes: datasetRevision,
                      graderRevision, runtime (including configId/configRevision), and
                      expectedCases. Keep credentials and case contents in the app.
                    </p>
                  </div>
                )}
                <p id={prerequisites} className="text-muted-foreground">
                  {profile === 'payment-retry'
                    ? 'The simulator needs payment-policy.json data. Three scenarios × two repetitions, no model calls. This checks orchestration, not native agent quality.'
                    : profile === 'presence-contract'
                      ? 'Checks nonempty instruction and skill files. This is a delivery contract check, not a behavioral score.'
                      : profile === 'codex-luna-review'
                        ? 'The included checkout review and grader use Codex. After separate setup, that adapter requires --live and allows up to four bounded Luna turns. Creating a request makes no model call.'
                        : 'Your app runs its installed adapter and grader. The service freezes these settings and records evidence; it never executes configuration as code.'}
                </p>
                {configurationError && (
                  <p id={error} role="alert" aria-live="polite" className="text-destructive">
                    {configurationError}
                  </p>
                )}
              </div>
              <div
                className="evaluation-setup-preview"
                role="region"
                aria-label="Request preview"
                tabIndex={0}
              >
                <h3>Request preview</h3>
                {valid ? (
                  <dl>
                    <dt>Expected case/repetition pairs</dt>
                    <dd>{valid.expectedCases.length}</dd>
                    <dt>Dataset revision</dt>
                    <dd>{valid.datasetRevision}</dd>
                    <dt>Grader revision</dt>
                    <dd>{valid.graderRevision}</dd>
                    <dt>Config ID</dt>
                    <dd>{valid.runtime.configId}</dd>
                    <dt>Config revision</dt>
                    <dd>{valid.runtime.configRevision}</dd>
                    {valid.runtime.model && (
                      <>
                        <dt>Model</dt>
                        <dd>{valid.runtime.model}</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p>Correct the configuration to see its preview.</p>
                )}
              </div>
            </div>
            <div className="evaluation-setup-footer">
              <p>
                Creating a request records public intent, makes no model call and does not publish.
                Your app owns execution. Examples require separate setup and do not establish
                installation.
              </p>
              <Button
                ref={createActionRef}
                disabled={submitDisabled}
                aria-describedby={prerequisites}
                onClick={onCreate}
              >
                Create evaluation request
              </Button>
            </div>
          </div>
        </DisclosureContent>
      </Disclosure>
      {blockedReason && <p className="evaluation-setup-blocked-reason">{blockedReason}</p>}
    </section>
  );
}
