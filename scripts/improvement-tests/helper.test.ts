import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { helperObserved } from '../../examples/self-improvement/repair/observed.js';

test('helper preflight parses without executing submissions and rejects unsafe primitives', () => {
  const inspect = (source: string) =>
    JSON.parse(
      execFileSync('python3', ['examples/self-improvement/repair/inspect_helper.py'], {
        input: source,
        encoding: 'utf8',
      }),
    );
  assert.equal(inspect('import json, sys\nprint(json.dumps({"decisions": []}))\n').valid, true);
  for (const source of [
    'import socket\n',
    'eval("1+1")\n',
    'open("local", "w")\n',
    'from pathlib import Path\nPath("local").write_text("bad")\n',
    'import json\nopen("/private/secret")\n',
  ])
    assert.equal(inspect(source).valid, false);
});
test('adoption requires a successful helper invocation returning every requested id', () => {
  const command = 'python3 .agents/skills/payment-triage/scripts/triage.py task.json';
  const output = JSON.stringify({ decisions: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(helperObserved([{ command, output, exitCode: 0 }], ['a', 'b']), true);
  assert.equal(
    helperObserved(
      [
        {
          command: 'cat task.json && ' + command,
          output: 'inspected task\n' + output + '\n',
          exitCode: 0,
        },
      ],
      ['a', 'b'],
    ),
    true,
  );
  assert.equal(
    helperObserved(
      [
        {
          command: 'python3 -c "print(\".agents/skills/payment-triage/scripts/triage.py\")"',
          output,
          exitCode: 0,
        },
      ],
      ['a', 'b'],
    ),
    false,
  );
  assert.equal(
    helperObserved(
      [{ command: command.replace('python3', 'cat'), output, exitCode: 0 }],
      ['a', 'b'],
    ),
    false,
  );
  assert.equal(helperObserved([{ command, output, exitCode: 1 }], ['a', 'b']), false);
  assert.equal(
    helperObserved([{ command, output: 'print("decisions")', exitCode: 0 }], ['a', 'b']),
    false,
  );
  assert.equal(
    helperObserved(
      [{ command, output: JSON.stringify({ decisions: [{ id: 'a' }, { id: 'a' }] }), exitCode: 0 }],
      ['a', 'b'],
    ),
    false,
  );
});
