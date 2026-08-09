import { AppLinkButton } from './app-link-button';
import GlassSurface from './GlassSurface';

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
          <span className="brand-wordmark">SHIPYARD402</span>
        </a>
        <span className="nav-signal" aria-hidden="true">
          <i />
          <b />
          <i />
        </span>
        <div className="nav-actions">
          <GlassSurface
            width="auto"
            height={34}
            borderRadius={999}
            borderWidth={0.05}
            brightness={18}
            opacity={0.82}
            blur={7}
            displace={0.2}
            backgroundOpacity={0.08}
            saturation={1.15}
            distortionScale={-70}
            redOffset={0}
            greenOffset={0}
            blueOffset={0}
            mixBlendMode="normal"
            className="network-glass"
          >
            <div className="network-pill">
              <span /> GOAT T3
            </div>
          </GlassSurface>
          {showTryApp && <AppLinkButton className="nav-try-button">Try the app</AppLinkButton>}
        </div>
      </div>
    </header>
  );
}
