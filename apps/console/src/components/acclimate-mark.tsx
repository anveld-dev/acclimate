// The Acclimate mark: a surveyor's bench mark, an upward arrow under the level line that records
// a measured height.
export function AcclimateMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      className={className ? `acclimate-mark ${className}` : 'acclimate-mark'}
    >
      <path
        d="M7.5 7.5H32.5"
        className="acclimate-mark-level"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M7.5 32.5L20 15L32.5 32.5M20 15V32.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
