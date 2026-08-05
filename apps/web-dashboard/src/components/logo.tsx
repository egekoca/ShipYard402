/**
 * Shipyard402's mark: a gantry crane over a hull — a shipyard, not just a boat.
 * Pure inline SVG (transparent by construction, no external asset, fits the CSP as-is)
 * and uses currentColor so it inherits gold/ink from whichever context renders it.
 */
export function LogoMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M9 29H39L32 40H16L9 29Z" fill="currentColor" />
      <rect x="21" y="7" width="4" height="24" fill="currentColor" />
      <rect x="21" y="7" width="17" height="4" fill="currentColor" />
      <rect x="10" y="7" width="9" height="4" fill="currentColor" />
    </svg>
  );
}

export function LogoWatermark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 220 220" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M40 132H180L156 178H64L40 132Z" stroke="currentColor" strokeWidth="1.5" />
      <rect x="98" y="34" width="6" height="98" fill="currentColor" />
      <rect x="98" y="34" width="78" height="6" fill="currentColor" />
      <rect x="52" y="34" width="40" height="6" fill="currentColor" />
      <line x1="168" y1="46" x2="168" y2="86" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="168" cy="90" r="4" fill="currentColor" />
      <line x1="18" y1="192" x2="202" y2="192" stroke="currentColor" strokeWidth="1.5" opacity=".5" />
      <line x1="30" y1="204" x2="190" y2="204" stroke="currentColor" strokeWidth="1.5" opacity=".28" />
    </svg>
  );
}
