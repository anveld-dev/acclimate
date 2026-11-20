import { ReceiptTime } from './receipt-time';
import { type ReactNode } from 'react';
import type { Evaluation } from '@acclimate/sdk';
import { ArrowRight, FileJson, Terminal } from 'lucide-react';
import { CopyButton } from './copy-button';
import { EvaluationHandoffDownload } from './evaluation-handoff-download';
import { SyntaxCode } from './syntax-code';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { EvaluatorLanguageSelect } from './evaluation-setup';
import {
  applicationEvaluatorCommand,
  type EvaluatorLanguage,
  isCheckoutCodexEvaluator,
  evaluationHandoff,
  checkoutCodexRunCommand,
} from '../lib/evaluation-config';

function RecordField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
      </dd>
    </div>
  );
}

export function EvaluationRequestInspector({
  request,
  language,
  onLanguageChange,
  consoleOrigin,
  publicApiUrl,
  workspaceId,
  bundleId,
  children,
  showDownload = true,
}: {
  request: Evaluation;
  consoleOrigin: string;
  language: EvaluatorLanguage;
  onLanguageChange(value: EvaluatorLanguage): void;
  publicApiUrl: string;
  workspaceId: string;
  bundleId: string;
  children?: ReactNode;
  showDownload?: boolean;
}) {
  const handoff = evaluationHandoff(publicApiUrl, workspaceId, bundleId, request.id, request);
  const setupCommand = isCheckoutCodexEvaluator(request)
    ? checkoutCodexRunCommand(bundleId, request.id)
    : undefined;
  const requested = request.status === 'requested' && !request.comparisonId;
  const nativeRunner = isCheckoutCodexEvaluator(request);
  const runCommand = nativeRunner
    ? setupCommand
    : applicationEvaluatorCommand(language, 'compare', request.runtime.execution === 'live');
  const stateDescription =
    request.status === 'requested'
      ? 'Request created · run in your app'
      : request.status === 'interrupted'
        ? 'Recorded interruption'
        : request.status === 'abandoned'
          ? 'Abandoned · evidence never counts'
          : `App reported ${request.status}`;
  return (
    <section className="run-request-inspector" aria-label="Selected request record">
      <header className="run-request-identity">
        <h3>{stateDescription}</h3>
        <div className="run-input-pair" aria-label="Frozen input versions">
          <span>
            Parent{' '}
            <code title={request.parentVersionId}>{request.parentVersionId.slice(0, 8)}</code>
          </span>
          <ArrowRight size={13} aria-hidden="true" />
          <span>
            Candidate{' '}
            <code title={request.candidateVersionId}>{request.candidateVersionId.slice(0, 8)}</code>
          </span>
        </div>
        {(request.attemptId || request.evaluatorPrincipal) && (
          <dl className="run-attempt-facts">
            {request.attemptId && <RecordField label="Attempt" value={request.attemptId} />}
            {request.evaluatorPrincipal && (
              <RecordField label="Evaluator" value={request.evaluatorPrincipal} />
            )}
          </dl>
        )}
      </header>
      {request.error && (
        <p className="run-state-note" role="alert">
          {request.error}
        </p>
      )}
      {request.status === 'running' && (
        <p className="run-state-note">
          Check your app for current execution status. Check the original worker before retrying.
          Recording an interruption does not stop the worker or its charges.
        </p>
      )}
      {request.comparisonId && (
        <p className="run-state-note">
          Paired evidence recorded. Review the comparison before making a release decision. Outputs
          stay private to the evaluator unless exported and verified.
        </p>
      )}
      {request.status === 'abandoned' && (
        <p className="run-state-note">
          {request.abandonedBy === 'service:evaluation-expiry'
            ? 'The service abandoned this attempt after it stopped reporting.'
            : `Abandoned by ${request.abandonedBy ?? 'an evaluator'}.`}{' '}
          Its outcome is unknown and its evidence never counts. This does not prove the worker
          stopped. Start a new request for the same candidate to measure it again.
        </p>
      )}
      {!request.comparisonId &&
        !requested &&
        request.status !== 'running' &&
        request.status !== 'abandoned' && (
          <p className="run-state-note">
            No comparison was reported. Check the original app logs and journal before creating
            another request.
          </p>
        )}
      {!requested && children}
      <section
        className="run-artifact"
        aria-label={requested ? 'Runner handoff' : 'Public handoff'}
      >
        <h4>
          {requested ? (
            <Terminal size={15} aria-hidden="true" />
          ) : (
            <FileJson size={15} aria-hidden="true" />
          )}
          {requested ? 'Runner handoff' : 'Public handoff'}
        </h4>
        <code className="run-file-name">handoff.json</code>
        {requested && <p>Run in your app with the request ID and frozen public configuration.</p>}
        <div className="run-handoff-actions">
          {showDownload && <EvaluationHandoffDownload handoff={handoff} />}
          <CopyButton value={handoff} label="Copy handoff JSON" />
          <CopyButton value={request.id} label="Copy request ID" />
        </div>
        {requested && runCommand && (
          <div className="space-y-2">
            <p>
              Give the evaluator owner the downloaded handoff. Run the commands on the evaluator
              machine with its private configuration.
            </p>
            {nativeRunner ? (
              <p>
                Run the installed Codex evaluator from the Acclimate checkout with your Codex
                credentials.
              </p>
            ) : (
              <>
                <EvaluatorLanguageSelect language={language} onChange={onLanguageChange} />
                <SyntaxCode
                  code={applicationEvaluatorCommand(language, 'doctor')}
                  language="bash"
                />
              </>
            )}
            {!nativeRunner && (
              <p>
                Compare prints the parent and candidate scores. Add{' '}
                <code>--policy quality-policy.json</code> to check your release criteria in the same
                command.
              </p>
            )}
            <SyntaxCode code={runCommand} language="bash" />
            <CopyButton value={runCommand} label="Copy evaluator run command" />
            <CopyButton
              label="Copy instructions for evaluator owner"
              value={[
                `Evaluate request ${request.id}. Save the handoff JSON at the end of this message as handoff.json.`,
                ...(nativeRunner
                  ? ['Run these commands from the native Codex reviewer checkout.']
                  : [
                      `Application setup: ${consoleOrigin}/evaluator-setup.html#${language}`,
                      'Run from the application directory. Replace /absolute/private/evaluator.json with your private evaluator configuration path.',
                      applicationEvaluatorCommand(language, 'doctor'),
                    ]),
                runCommand,
                'Open the comparison in the console after completion. To report a policy verdict, run the matching policy check with your policy file.',
                '',
                handoff,
              ].join('\n')}
            />
          </div>
        )}
      </section>
      {requested && children}
      <Disclosure className="run-record-disclosure">
        <DisclosureTrigger>Request details</DisclosureTrigger>
        <DisclosureContent>
          <dl className="run-record-fields">
            <RecordField label="Request ID" value={request.id} />
            <RecordField label="Dataset" value={request.datasetRevision} />
            <RecordField label="Grader" value={request.graderRevision} />
            <div>
              <dt>Updated</dt>
              <dd>
                <ReceiptTime value={request.updatedAt} />
              </dd>
            </div>
            <RecordField label="Parent version" value={request.parentVersionId} />
            <RecordField label="Parent digest" value={request.parentDigest} />
            <RecordField label="Candidate version" value={request.candidateVersionId} />
            <RecordField label="Candidate digest" value={request.candidateDigest} />
            {request.comparisonId && (
              <RecordField label="Comparison ID" value={request.comparisonId} />
            )}
            <RecordField label="Public API" value={publicApiUrl} />
            <div>
              <dt>Completion policy</dt>
              <dd>Bound evidence required</dd>
            </div>
          </dl>
          <Disclosure>
            <DisclosureTrigger>Public handoff JSON</DisclosureTrigger>
            <DisclosureContent>
              <SyntaxCode code={handoff} language="json" aria-label="Frozen public handoff JSON" />
            </DisclosureContent>
          </Disclosure>
          <Disclosure>
            <DisclosureTrigger>Stored request JSON</DisclosureTrigger>
            <DisclosureContent>
              <SyntaxCode
                code={JSON.stringify(request, null, 2)}
                language="json"
                aria-label="Stored request JSON"
              />
            </DisclosureContent>
          </Disclosure>
        </DisclosureContent>
      </Disclosure>
      {setupCommand && (
        <Disclosure className="run-record-disclosure">
          <DisclosureTrigger>
            {request.comparisonId
              ? 'Checkout evaluator setup details'
              : 'Included checkout setup (required)'}
          </DisclosureTrigger>
          <DisclosureContent className="run-checkout-setup">
            <p>
              The public configuration matches an evaluator in this checkout. Install the checkout
              on the machine that will run it.
            </p>
            <p>
              Use a dedicated evaluator token with the Evaluate right. Workspace administrators
              issue one under Settings → Members → Evaluator tokens and can download a ready
              evaluator configuration there. Delivery credentials apply only to published content.
              Keep the credential file outside version control with mode 0600 in a private directory
              (0700).
            </p>
            <SyntaxCode
              aria-label="Private evaluator configuration template"
              code={JSON.stringify(
                {
                  schemaVersion: 1,
                  serviceUrl: publicApiUrl,
                  workspaceId,
                  evaluatorPrincipalId: 'YOUR_DEDICATED_EVALUATOR_PRINCIPAL',
                  evaluatorToken: 'YOUR_SCOPED_EVALUATOR_TOKEN',
                  journalRoot: '/absolute/private/evaluation-journals',
                },
                null,
                2,
              )}
              language="json"
            />
            <p>
              Replace the configuration path with your private file. For recovery, use the original
              service, workspace, evaluator principal and journal directory.
            </p>
            {!requested && <p>Check the original worker and journal before repeating a command.</p>}
            <CopyButton value={setupCommand} label="Copy setup-required command" />
            <SyntaxCode
              code={setupCommand}
              language="bash"
              aria-label="Installed checkout command"
            />
          </DisclosureContent>
        </Disclosure>
      )}
    </section>
  );
}
