// The Acclimate mark, as in the console's favicon: a summit on a forest tile.
export function AcclimateMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={className}>
      <rect width="40" height="40" rx="11" fill="#253f33" />
      <path d="m8 27 9-17h6l9 17h-8l-4-8-4 8H8Z" fill="#e5eea8" />
    </svg>
  );
}
