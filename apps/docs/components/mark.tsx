// The Acclimate mark: a surveyor's bench mark, an upward arrow under the level line that records
// a measured height. Colours come from .acclimate-mark in global.css, so it follows the theme.
export function AcclimateMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={`acclimate-mark ${className ?? ''}`}>
      <path d="M7.5 7.5H32.5" className="acclimate-mark-level" strokeWidth="5" strokeLinecap="round" />
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
