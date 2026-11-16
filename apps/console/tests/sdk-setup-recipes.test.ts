import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { deliveryRecipes } from '../src/components/sdk-setup-recipes';

test('copied TS and Python recipes parse and retain observed-start newline semantics', () => {
  const recipes = deliveryRecipes({ projectId: 'p', bundleId: 'b', channel: 'stable' });
  const result = ts.transpileModule(recipes.typescript, {
    fileName: 'delivery-check.mts',
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.deepEqual(
    result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error),
    [],
  );
  assert(recipes.typescript.includes("output.includes('app started\\n')"));
  const python = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: recipes.python,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ifError(python.error);
  assert.equal(python.status, 0, python.stderr);
});
