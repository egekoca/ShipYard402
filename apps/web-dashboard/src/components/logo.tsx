/**
 * Shipyard402's mark: a radar screen — matches the same radar/sweep motif
 * already used for the run-lookup loading state, so the brand and the
 * product's own "detection" visual language are the same thing.
 */
export function RadarMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="24" cy="24" r="19" stroke="currentColor" strokeWidth="2.5" opacity=".9" />
      <circle cx="24" cy="24" r="11" stroke="currentColor" strokeWidth="2" opacity=".55" />
      <line x1="24" y1="24" x2="24" y2="5" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="24" cy="24" r="3.5" fill="currentColor" />
    </svg>
  );
}

export function HeroRadar({ className }: Readonly<{ className?: string }>) {
  return (
    <div className={className} aria-hidden="true">
      <span className="hero-radar-sweep" />
    </div>
  );
}
