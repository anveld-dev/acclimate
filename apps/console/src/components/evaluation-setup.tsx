import { useId, useRef, useState } from 'react';
import './evaluation-configuration.css';
import { ClipboardList, Check } from 'lucide-react';
import type React from 'react';
import {
  applicationEvaluatorCommand,
  type EvaluatorLanguage,
  type evaluationConfiguration,
} from '../lib/evaluation-config';
import { CodeEditor } from './code-editor';
import { Button } from './ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { NativeSelect } from './ui/native-select';

export type EvaluationSetupProps = {
  language: EvaluatorLanguage;
  customConfiguration: string;
  configuration?: ReturnType<typeof evaluationConfiguration>;
  configurationError: string;
  savedGeneration?: number;
  scopeIdentity?: { channel: string; parent?: string | null; candidate: string };
  fieldsDisabled: boolean;
  submitDisabled: boolean;
  blockedReason?: string;
  hasRequests: boolean;
  createActionRef: React.RefObject<HTMLButtonElement | null>;
  onLanguageChange(language: EvaluatorLanguage): void;
  onCustomConfigurationChange(value: string): void;
  onCreate(event: React.MouseEvent<HTMLButtonElement>): void;
};

export function EvaluationSetup({
  language,
  customConfiguration,
  configuration,
  configurationError,
  savedGeneration,
  scopeIdentity,
  fieldsDisabled,
  submitDisabled,
  blockedReason,
  hasRequests,
  createActionRef,
  onLanguageChange,
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
  const caseGroups = new Map<string, number[]>();
  for (const { caseId, repetition } of valid?.expectedCases ?? []) {
    const existing = caseGroups.get(caseId);
    if (existing) existing.push(repetition);
    else caseGroups.set(caseId, [repetition]);
  }
  const blocked = `${id}-blocked`;
  return (
    <section
      className="review-section evaluation-setup configuration-studio"
      aria-label="Create evaluation request"
    >
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
            <div className="rounded-md border p-3 space-y-2" aria-label="Evaluator prerequisites">
              <p>
                Install the Acclimate SDK alongside your agent and independent grader, then run its{' '}
                <code>describe</code> command. Export your saved cases, execution callback and
                grader from{' '}
                <code>
                  {language === 'python' ? 'application.py' : 'application.mjs or application.mts'}
                </code>
                .{' '}
                <a
                  className="underline"
                  href={`/evaluator-setup.html#${language}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Set up the {language === 'python' ? 'Python' : 'Node.js'} evaluator
                </a>
              </p>
              <p>
                Evaluation needs a dedicated workspace read/write machine principal from your
                service operator. Connections delivery credentials cannot read unpublished
                candidates or run evaluations; propose and promote access are not needed.
              </p>
              <p>
                Keep its private configuration and durable journal on the evaluator machine. Run{' '}
                <code>doctor</code> there to check access without executing a task. A valid public
                configuration does not prove the evaluator or provider is installed.
              </p>
              {savedGeneration !== undefined && (
                <p>
                  Evaluating saved generation {savedGeneration}. Later edits do not change this
                  request.
                </p>
              )}
            </div>
            <EvaluatorLanguageSelect language={language} onChange={onLanguageChange} />
            <div className="evaluation-setup-grid">
              <div className="evaluation-setup-author">
                <div className="evaluation-setup-editor">
                  <div>Public evaluator configuration (JSON)</div>
                  <CodeEditor
                    language="json"
                    aria-label="Public evaluator configuration (JSON)"
                    aria-describedby={`${instructions}${customConfiguration.trim() && configurationError ? ` ${error}` : ''}`}
                    aria-invalid={!!customConfiguration.trim() && !!configurationError}
                    value={customConfiguration}
                    disabled={fieldsDisabled}
                    onChange={onCustomConfigurationChange}
                  />
                  <p id={instructions} className="text-muted-foreground">
                    Run <code>{applicationEvaluatorCommand(language, 'describe')}</code> on the
                    evaluator machine with your application's saved cases loaded. Paste the public
                    JSON here. Keep case contents and credentials on the evaluator machine. If you
                    use the native Codex reviewer from the Acclimate checkout, run{' '}
                    <code>npm run --silent evaluate:app -- describe</code> there instead.
                  </p>
                </div>
                <p id={prerequisites} className="text-muted-foreground">
                  Your application runs its agent and independent grader on the saved versions.
                </p>
                {configurationError && customConfiguration.trim() && (
                  <p id={error} role="alert" aria-live="polite" className="text-destructive">
                    {configurationError}
                  </p>
                )}
                <Disclosure className="evaluation-prerequisites">
                  <DisclosureTrigger>Evaluator prerequisites</DisclosureTrigger>
                  <DisclosureContent className="space-y-2 pt-2">
                    <p>
                      Install your app’s evaluator and run <code>describe</code> to obtain its
                      public configuration.
                    </p>
                    <p>
                      Ask your operator for a dedicated workspace read/write machine principal.
                      Delivery credentials cannot read unpublished candidates or run evaluations.
                    </p>
                    <p>
                      Keep the private configuration and durable journal on the evaluator machine.
                      Run <code>doctor</code> there to check access before execution.
                    </p>
                  </DisclosureContent>
                </Disclosure>
              </div>
              <div className="evaluation-setup-preview" role="region" aria-label="Request preview">
                <h3>
                  <ClipboardList aria-hidden="true" />
                  Request preview
                  {valid && (
                    <span className="config-valid">
                      <Check aria-hidden="true" />
                      Valid configuration
                    </span>
                  )}
                </h3>
                {scopeIdentity && (
                  <Disclosure className="config-lineage">
                    <DisclosureTrigger>
                      <span>{scopeIdentity.channel}</span> ·{' '}
                      {scopeIdentity.parent ? (
                        <>
                          Parent <code>{scopeIdentity.parent.slice(0, 8)}</code> →{' '}
                        </>
                      ) : null}
                      Candidate <code>{scopeIdentity.candidate.slice(0, 8)}</code>
                    </DisclosureTrigger>
                    <DisclosureContent>
                      <dl>
                        {scopeIdentity.parent && (
                          <>
                            <dt>Parent version</dt>
                            <dd>{scopeIdentity.parent}</dd>
                          </>
                        )}
                        <dt>Candidate version</dt>
                        <dd>{scopeIdentity.candidate}</dd>
                      </dl>
                    </DisclosureContent>
                  </Disclosure>
                )}
                {valid ? (
                  <>
                    <p className="config-preview-identity" aria-label="Selected evaluator summary">
                      <strong>{valid.runtime.configId}</strong>
                      <span>
                        Revision {valid.runtime.configRevision} · {caseGroups.size}{' '}
                        {caseGroups.size === 1 ? 'task' : 'tasks'}
                      </span>
                    </p>
                    <dl>
                      <dt>Expected case/repetition pairs</dt>
                      <dd>{valid.expectedCases.length}</dd>
                      <dt>Dataset revision</dt>
                      <dd>{valid.datasetRevision}</dd>
                      <dt>Grader revision</dt>
                      <dd>{valid.graderRevision}</dd>
                      {valid.runtime.model && (
                        <>
                          <dt>Model</dt>
                          <dd>{valid.runtime.model}</dd>
                        </>
                      )}
                    </dl>
                    <div
                      className="config-case-manifest"
                      role="region"
                      aria-label="Expected cases"
                      tabIndex={0}
                    >
                      <table>
                        <caption className="sr-only">Expected case/repetition pairs</caption>
                        <thead>
                          <tr>
                            <th scope="col">Expected case</th>
                            <th scope="col">Repetitions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from(caseGroups, ([caseId, repetitions]) => (
                            <tr key={caseId}>
                              <th scope="row">{caseId}</th>
                              <td>{repetitions.join(', ')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Disclosure className="config-runtime">
                      <DisclosureTrigger>Public runtime settings</DisclosureTrigger>
                      <DisclosureContent>
                        <dl>
                          {Object.entries(valid.runtime).map(([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </DisclosureContent>
                    </Disclosure>
                  </>
                ) : (
                  <p>
                    {customConfiguration.trim()
                      ? 'Correct the configuration to see its preview.'
                      : 'Paste your evaluator’s public configuration to preview the request.'}
                  </p>
                )}
              </div>
            </div>
            <div className="evaluation-setup-footer">
              <p>
                Creating a request freezes the configuration and versions. Send its public handoff
                to the person running the evaluator.
              </p>
              {blockedReason && (
                <p id={blocked} className="config-blocked">
                  {blockedReason}
                </p>
              )}
              <Button
                ref={createActionRef}
                disabled={submitDisabled}
                aria-describedby={
                  [
                    prerequisites,
                    configurationError && customConfiguration.trim() && error,
                    blockedReason && blocked,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                onClick={onCreate}
              >
                Create evaluation request
              </Button>
            </div>
          </div>
        </DisclosureContent>
      </Disclosure>
      {blockedReason && !open && <p className="evaluation-setup-blocked-reason">{blockedReason}</p>}
    </section>
  );
}

export function EvaluatorLanguageSelect({
  language,
  onChange,
}: {
  language: EvaluatorLanguage;
  onChange(language: EvaluatorLanguage): void;
}) {
  return (
    <label className="evaluation-setup-profile">
      Evaluator language
      <NativeSelect
        aria-label="Evaluator language"
        value={language}
        onChange={(event) => onChange(event.target.value as EvaluatorLanguage)}
      >
        <option value="javascript">Node.js</option>
        <option value="python">Python</option>
      </NativeSelect>
    </label>
  );
}
