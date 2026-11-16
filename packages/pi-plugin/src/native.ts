import type { PreparedPiBundle } from './index.js';

/**
 * Build and load Pi's native resource loader for a fresh session. Memory is
 * appended only when the host explicitly selects source paths in memoryPaths.
 */
export async function createPiResourceLoader(
  prepared: PreparedPiBundle,
  memoryPaths: readonly string[] = [],
): Promise<import('@earendil-works/pi-coding-agent').ResourceLoader> {
  const { DefaultResourceLoader, SettingsManager } = await import(
    '@earendil-works/pi-coding-agent'
  );
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const selectedMemory = memoryPaths.map((sourcePath) => {
    const file = prepared.memoryFiles.find((candidate) => candidate.path === sourcePath);
    if (!file) throw new Error(`Unknown prepared memory path: ${sourcePath}`);
    return file.absolutePath;
  });
  const instruction = prepared.instructionPath
    ? [
        {
          path: prepared.instructionPath,
          content: await readFile(prepared.instructionPath, 'utf8'),
        },
      ]
    : [];
  const loader = new DefaultResourceLoader({
    cwd: prepared.cwd,
    agentDir: path.join(prepared.cwd, '.acclimate', 'pi-agent'),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: prepared.skillPaths,
    agentsFilesOverride: () => ({ agentsFiles: instruction }),
    systemPromptOverride: () => undefined,
    appendSystemPrompt: selectedMemory,
  });
  await loader.reload();
  return loader;
}
