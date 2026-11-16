export function uniqueSkillName(files: ReadonlyArray<{ path: string }>): string {
  const occupied = new Set(
    files
      .map((file) => file.path.toLowerCase().split('/'))
      .filter((parts) => parts[0] === 'skills')
      .map((parts) => parts[1]),
  );
  let name = 'new-skill';
  for (let suffix = 2; occupied.has(name); suffix++) name = `new-skill-${suffix}`;
  return name;
}
