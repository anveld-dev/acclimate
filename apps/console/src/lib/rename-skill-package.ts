import type { BundlePayload } from '@acclimate/sdk';

/** Rename one package atomically, including its manifest, without affecting sibling packages. */
export function renameSkillPackage(
  payload: BundlePayload,
  previous: string,
  name: string,
): BundlePayload {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw Error('Use lowercase letters, digits and hyphens for skill names.');
  const prefix = `skills/${previous}/`;
  const nextPrefix = `skills/${name}/`;
  if (
    name !== previous &&
    payload.files.some((file) => file.path.toLowerCase().startsWith(nextPrefix.toLowerCase()))
  )
    throw Error('That skill package already exists. Choose another name.');
  return {
    ...payload,
    files: payload.files.map((file) =>
      file.path.startsWith(prefix)
        ? {
            ...file,
            path: nextPrefix + file.path.slice(prefix.length),
            text:
              file.path === prefix + 'SKILL.md'
                ? file.text.replace(/^name:.*$/m, `name: ${name}`)
                : file.text,
          }
        : file,
    ),
  };
}
