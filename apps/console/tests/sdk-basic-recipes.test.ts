import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import {
  basicDeliveryRecipes,
  agentConnectionRecipes,
  deliveryRecipes,
} from '../src/components/sdk-setup-recipes';

test('minimal delivery recipes parse and preserve exact selected scope without code interpolation', () => {
  const selection = {
    projectId: 'project"quoted',
    bundleId: 'bundle\\path',
    channel: 'preview\n雪',
  };
  const recipes = basicDeliveryRecipes(selection);
  const result = ts.transpileModule(recipes.typescript, {
    fileName: 'delivery-check.mts',
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.deepEqual(
    result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error),
    [],
  );
  const source = ts.createSourceFile(
    'delivery-check.mts',
    recipes.typescript,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((entry) => entry.name.getText(source) === 'selection');
  assert(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer));
  const actual = Object.fromEntries(
    declaration.initializer.properties.map((property) => {
      assert(
        ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.name) &&
          ts.isStringLiteral(property.initializer),
      );
      return [property.name.text, property.initializer.text];
    }),
  );
  assert.deepEqual(actual, selection);
  const python = spawnSync(
    'python3',
    [
      '-c',
      `import ast,json,sys
module=ast.parse(sys.stdin.read())
assignment=next(node for node in module.body if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Tuple))
print(json.dumps(ast.literal_eval(assignment.value)))`,
    ],
    { input: recipes.python, encoding: 'utf8', timeout: 30000 },
  );
  assert.ifError(python.error);
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), Object.values(selection));
});

test('the basic path reports checked files without enabling reporters or claiming an agent start', () => {
  const recipes = basicDeliveryRecipes({ projectId: 'p', bundleId: 'b', channel: 'stable' });
  for (const code of Object.values(recipes)) {
    assert.doesNotMatch(
      code,
      /createReceiptReporter|DeliveryReporter|subprocess|spawn|reportStarted|report_started|ACCLIMATE_RECEIPT_TOKEN|ACCLIMATE_INTEGRATION/,
    );
    assert.match(code, /checkedFiles/);
    for (const key of [
      'ACCLIMATE_URL',
      'ACCLIMATE_TOKEN',
      'ACCLIMATE_SCOPE',
      'ACCLIMATE_CACHE',
      'ACCLIMATE_JOB_DIR',
    ])
      assert.match(code, new RegExp(key));
  }
});

test('all generated JavaScript recipes run with Node syntax and context recipes retain private result handling', () => {
  const selection = { projectId: 'p', bundleId: 'b', channel: 'stable' };
  for (const recipe of [
    basicDeliveryRecipes(selection),
    deliveryRecipes(selection),
    agentConnectionRecipes(selection),
  ]) {
    const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: recipe.typescript,
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, check.stderr);
    assert.ifError(check.error);
  }
  const context = agentConnectionRecipes(selection);
  assert.match(context.typescript, /instruction, skillFiles, approvedMemory/);
  assert.match(context.typescript, /const approvedMemory = \[\]/);
  assert.doesNotMatch(context.typescript, /fixtureResult: result/);
  const python = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: context.python,
    encoding: 'utf8',
  });
  assert.equal(python.status, 0, python.stderr);
});
