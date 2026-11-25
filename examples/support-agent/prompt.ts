import type { BundlePayload } from '@acclimate/sdk';

/**
 * The learning executor renders a bundle as one system prompt: instructions, then skills, then
 * memory, each file under a `# path` heading. Build the prompt the same way in your application,
 * so the loop measures the prompt your jobs run with.
 */
export function systemPrompt(payload: BundlePayload): string {
  return (['instruction', 'skill', 'memory'] as const)
    .flatMap((kind) => payload.files.filter((file) => file.kind === kind))
    .map((file) => `# ${file.path}\n${file.text}`)
    .join('\n\n');
}
