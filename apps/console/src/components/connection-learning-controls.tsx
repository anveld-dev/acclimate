import { useId } from 'react';
import { Label } from './ui/label';
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
