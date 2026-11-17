import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LearningRestoreTarget } from '@acclimate/sdk';
import type { LearningRequest } from '../server/integration-core';
import { Button } from './ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import { Label } from './ui/label';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Textarea } from './ui/textarea';

export function SelectionPoliciesField({ busy }: { busy: boolean }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Development and audit selection policies (optional)</Label>
      <Textarea
        id={id}
        name="selectionPolicies"
        rows={4}
        maxLength={256_000}
        disabled={busy}
        aria-describedby={`${id}-help`}
        spellCheck={false}
        className="font-mono text-sm"
      />
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        Import a JSON object with separate <code>development</code> and <code>audit</code> policies.
        Each sets the metric, minimum mean improvement, and maximum case regression.
      </p>
    </div>
  );
}

export function SkillPermissionFields({
  busy,
  current,
}: {
  busy: boolean;
  current?: { createSkillNames: string[]; retireSkillNames: string[] };
}) {
  const id = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Skill package permissions</legend>
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        Enter one package name per line. An empty list grants no permission for that operation.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ['createSkillNames', 'Packages the learner may create'],
            ['retireSkillNames', 'Packages the learner may retire'],
          ] as const
        ).map(([name, label]) => (
          <div key={name} className="space-y-1.5">
            <Label htmlFor={`${id}-${name}`}>{label}</Label>
            <Textarea
              id={`${id}-${name}`}
              name={name}
              rows={2}
              disabled={busy}
              maxLength={8192}
              defaultValue={current?.[name].join('\n') ?? ''}
              aria-describedby={`${id}-help`}
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

type Restore = Omit<
  Extract<LearningRequest, { action: 'restore' }>,
  'action' | 'projectId' | 'integrationId'
>;

export function RestoreDelivery({
  busy,
  revision,
  targets,
  onSubmit,
}: {
  busy: boolean;
  revision: string;
  targets: LearningRestoreTarget[];
  onSubmit(input: Restore): Promise<boolean>;
}) {
  const id = useId();
  const pending = useRef<Restore | undefined>(undefined);
  const [selected, setSelected] = useState('');
  const options = targets.map((target) => ({
    value: `${target.kind}/${target.revision}/${target.versionId}`,
    target,
  }));
  const target = options.find((item) => item.value === selected)?.target;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target) return;
    const form = event.currentTarget;
    const reason = String(new FormData(form).get('reason') ?? '').trim();
    const previous = pending.current;
    if (
      !previous ||
      previous.expectedRevision !== revision ||
      previous.reason !== reason ||
      previous.target.kind !== target.kind ||
      previous.target.revision !== target.revision ||
      previous.target.versionId !== target.versionId
    ) {
      pending.current = {
        restoreId: crypto.randomUUID(),
        expectedRevision: revision,
        target,
        reason,
      };
    }
    if (await onSubmit(pending.current!)) {
      pending.current = undefined;
      setSelected('');
      form.reset();
    }
  }
  if (!targets.length) return null;
  return (
    <Disclosure>
      <DisclosureTrigger>Restore or refresh the delivery target</DisclosureTrigger>
      <DisclosureContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-3 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-target`}>Reviewed version</Label>
            <NativeSelect
              id={`${id}-target`}
              value={selected}
              required
              disabled={busy}
              onChange={(event) => setSelected(event.target.value)}
            >
              <NativeSelectOption value="" disabled>
                Choose a version
              </NativeSelectOption>
              {options.map(({ value, target }) => (
                <NativeSelectOption key={value} value={value}>
                  {target.kind === 'source' ? 'Source channel' : 'Previous delivery'} · revision{' '}
                  {target.revision} · {target.versionId}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-reason`}>Reason for changing delivery</Label>
            <Textarea
              id={`${id}-reason`}
              name="reason"
              required
              maxLength={1024}
              rows={2}
              disabled={busy}
            />
          </div>
          {target && (
            <p className="break-all text-sm">
              Future jobs on this connection will move from delivery revision {revision} to version{' '}
              <code>{target.versionId}</code>. Open candidates against the previous revision will
              close.
            </p>
          )}
          <Button type="submit" disabled={busy || !target}>
            {target?.kind === 'source'
              ? 'Apply reviewed source version'
              : 'Restore reviewed delivery'}
          </Button>
        </form>
      </DisclosureContent>
    </Disclosure>
  );
}
