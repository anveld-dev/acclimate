/** Application-owned allowlist: no handoff/configuration value resolves executable code. */
export async function installedHarness(name) {
  switch (name) {
    case 'codex':
      return { name, prepare: (await import('@acclimate/codex-plugin')).prepare };
    case 'claude':
      return { name, prepare: (await import('@acclimate/claude-plugin')).prepare };
    case 'pi':
      return { name, prepare: (await import('@acclimate/pi-plugin')).prepare };
    case 'cursor':
      return { name, prepare: (await import('@acclimate/cursor-plugin')).prepare };
    default:
      throw new Error('native.unsupported_harness');
  }
}

/** Fresh-session options only. The app still supplies authentication, model and tools. */
export async function freshSessionInputs(name, effectiveContext) {
  switch (name) {
    case 'codex':
      return {
        sessionOptions: { workingDirectory: effectiveContext.cwd, skipGitRepoCheck: true },
        memoryFiles: effectiveContext.memoryFiles,
      };
    case 'claude':
      return {
        sessionOptions: (await import('@acclimate/claude-plugin/native')).claudeSessionOptions(
          effectiveContext,
        ),
        memoryFiles: effectiveContext.memoryFiles,
      };
    case 'cursor':
      return {
        sessionOptions: (await import('@acclimate/cursor-plugin/native')).cursorLocalOptions(
          effectiveContext,
        ),
        memoryFiles: effectiveContext.memoryFiles,
      };
    case 'pi':
      return {
        resourceLoader: await (
          await import('@acclimate/pi-plugin/native')
        ).createPiResourceLoader(
          effectiveContext,
          effectiveContext.memoryFiles.map((file) => file.path),
        ),
        memoryFiles: effectiveContext.memoryFiles,
      };
    default:
      throw new Error('native.unsupported_harness');
  }
}
