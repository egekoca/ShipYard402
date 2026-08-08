export function SiteHeader({
  homeHref,
  showTryApp = true,
}: Readonly<{
  homeHref: string;
  /** Hide on the page the button would just link back to itself (the /app page). */
  showTryApp?: boolean;
}>) {
  return (
    <header className="nav-bar">
      <div className="nav-shell">
        <a className="brand" href={homeHref} aria-label="Shipyard402 home">
          <span className="brand-mark">
            {/* biome-ignore lint/performance/noImgElement: static asset, no next/image config needed for a 42px mark */}
            <img src="/logo-mark.png" alt="" className="brand-mark-icon" />
          </span>
          <span>SHIPYARD402</span>
        </a>
        <div className="nav-actions">
          <div className="network-pill">
            <span /> GOAT TESTNET3
          </div>
          {showTryApp && (
            <a className="try-app-button" href="/app">
              Try the app
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
