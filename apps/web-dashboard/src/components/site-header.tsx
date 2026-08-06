export function SiteHeader({ homeHref }: Readonly<{ homeHref: string }>) {
  return (
    <header className="nav-bar">
      <div className="nav-shell">
        <a className="brand" href={homeHref} aria-label="Shipyard402 home">
          {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no next/image config needed for a 42px mark */}
          <span className="brand-mark"><img src="/logo-mark.png" alt="" className="brand-mark-icon" /></span>
          <span>SHIPYARD402</span>
        </a>
        <div className="network-pill"><span /> GOAT TESTNET3</div>
      </div>
    </header>
  );
}
