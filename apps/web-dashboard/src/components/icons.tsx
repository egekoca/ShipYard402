/**
 * Small line-art marks used above comparison/status cards -- same minimal, single-color style
 * as RadarMark (logo.tsx) so they read as one icon family, not a mismatched icon-pack import.
 */

export function ShieldAlertMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M24 4 L40 10 V22 C40 32.5 33 40.5 24 44 C15 40.5 8 32.5 8 22 V10 Z" stroke="currentColor" strokeWidth="2.5" opacity=".9" />
      <line x1="24" y1="15" x2="24" y2="27" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="24" cy="33" r="1.9" fill="currentColor" />
    </svg>
  );
}

export function ShieldCheckMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M24 4 L40 10 V22 C40 32.5 33 40.5 24 44 C15 40.5 8 32.5 8 22 V10 Z" stroke="currentColor" strokeWidth="2.5" opacity=".9" />
      <path d="M16 23.5 L21.5 29 L32.5 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
