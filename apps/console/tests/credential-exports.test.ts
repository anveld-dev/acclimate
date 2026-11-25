import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { credentialShellExports } from '../src/lib/credential-exports';

const values = {
  url: 'https://api.example.com',
  workspaceId: 'local-demo',
  bundleId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
};

test('shell exports single-quote every value and survive a quote or dollar sign in the secret', () => {
  const secret = "aci_it's $HOME `x`";
  const line = credentialShellExports({ ...values, kind: 'content-read', secret });
  assert.equal(
    line,
    `export ACCLIMATE_URL='https://api.example.com' ACCLIMATE_WORKSPACE='local-demo' ` +
      `ACCLIMATE_BUNDLE='${values.bundleId}' ACCLIMATE_CONNECTION='${values.connectionId}' ` +
      `ACCLIMATE_TOKEN='aci_it'\\''s $HOME \`x\`'`,
  );
  const shown = execFileSync('sh', [
    '-c',
    `${line}; printf '%s\\n' "$ACCLIMATE_URL" "$ACCLIMATE_WORKSPACE" "$ACCLIMATE_BUNDLE" "$ACCLIMATE_CONNECTION" "$ACCLIMATE_TOKEN"`,
  ], { encoding: 'utf8', env: {} });
  assert.deepEqual(shown.trimEnd().split('\n'), [values.url, values.workspaceId, values.bundleId, values.connectionId, secret]);
});

test('a receipt credential exports ACCLIMATE_RECEIPT_TOKEN instead of the read token', () => {
  const line = credentialShellExports({ ...values, kind: 'receipt-write', secret: 'aci_receipt' });
  assert.match(line, / ACCLIMATE_RECEIPT_TOKEN='aci_receipt'$/);
  assert.doesNotMatch(line, /ACCLIMATE_TOKEN=/);
});

test('the one-time credential dialog offers the shell exports', async () => {
  const source = await readFile(new URL('../src/components/workspace-connections.tsx', import.meta.url), 'utf8');
  assert.match(source, /label="Copy as shell exports"/);
  assert.match(source, /credentialShellExports\(\{/);
});
