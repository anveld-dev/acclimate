import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import {
  basicDeliveryRecipes,
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

test('generated delivery scripts parse as Node ES modules', () => {
  const selection = { projectId: 'p', bundleId: 'b', channel: 'stable' };
  for (const recipe of [basicDeliveryRecipes(selection), deliveryRecipes(selection)]) {
    const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: recipe.typescript,
      encoding: 'utf8',
    });
    assert.ifError(check.error);
    assert.equal(check.status, 0, check.stderr);
  }
});

test('optional observation recipes bind the project and leave start reporting to a real app event', () => {
  const code = deliveryRecipes({ projectId: 'private-project', bundleId: 'b', channel: 'stable' });
  for (const recipe of Object.values(code)) {
    assert.match(recipe, /private-project/);
    assert.match(recipe, /ACCLIMATE_RECEIPT_TOKEN/);
    assert.match(recipe, /client\.prepare/);
    assert.doesNotMatch(recipe, /spawn|subprocess/);
  }
  assert.match(code.typescript, /prepared\.reportStarted\(\)/);
  assert.match(code.python, /prepared\.report_started\(\)/);
});
