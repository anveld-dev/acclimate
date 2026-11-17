// Run from an application that installed @acclimate/sdk. No checkout imports.
import { readFile } from 'node:fs/promises';
import { analyzeComparison } from '@acclimate/sdk/evaluation/analysis';

const [comparisonFile, descriptorFile, bindingFile, configFile] = process.argv.slice(2);
if (!comparisonFile || !descriptorFile || !bindingFile || process.argv.length > 6) {
  process.stderr.write(
    'Usage: node analyze.mjs comparison.json descriptor.json trusted-binding.json [analysis-config.json]\n',
  );
  process.exit(1);
}
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
try {
  const [comparison, expectedDescriptor, expectedBinding, config] = await Promise.all([
    read(comparisonFile),
    read(descriptorFile),
    read(bindingFile),
    configFile ? read(configFile) : {},
  ]);
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((name) => !['metrics', 'observations', 'uncertainty'].includes(name))
  )
    throw new Error();
  const result = analyzeComparison({ ...config, comparison, expectedDescriptor, expectedBinding });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      code:
        typeof error?.code === 'string' && /^(analysis|evidence|policy)\.[a-z_]+$/.test(error.code)
          ? error.code
          : 'analysis.input_invalid',
    }) + '\n',
  );
  process.exitCode = 1;
}
