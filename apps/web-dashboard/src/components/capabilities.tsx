import { BadgeCheck, Boxes, FileSignature, Repeat2, ShieldHalf, Waypoints } from 'lucide-react';

import AnimatedContent from './AnimatedContent';
import SpotlightCard from './SpotlightCard';

type Capability = Readonly<{
  icon: typeof BadgeCheck;
  title: string;
  body: string;
  /** Honest maturity tag so nothing reads as more proven than it is. */
  tag?: 'live' | 'beta';
}>;

/**
 * What the engine actually does today, in plain benefit terms. The `beta` tags on the cross-chain
 * capabilities are deliberate: the code path is real and tested, but a proven mainnet bridge run is
 * still ahead, so these are not presented as battle-tested production features.
 */
const CAPABILITIES: readonly Capability[] = [
  { icon: BadgeCheck, title: 'Pays your API for real', body: 'A real on-chain x402 payment.', tag: 'live' },
  { icon: ShieldHalf, title: 'Attacks the payment logic', body: 'Replay, unpaid, forged receipts.', tag: 'live' },
  {
    icon: FileSignature,
    title: 'Signs the verdict on-chain',
    body: 'Public, verifiable, no trust in us.',
    tag: 'live',
  },
  { icon: Waypoints, title: 'Pays across chains', body: 'GOAT funds reach a BNB target.', tag: 'beta' },
  { icon: Repeat2, title: 'Bridges the currency', body: 'Handled in the background.', tag: 'beta' },
  { icon: Boxes, title: 'Version-scoped', body: 'One proof, per release.', tag: 'live' },
];

export function Capabilities() {
  return (
    <section className="capabilities" aria-label="What Shipyard402 can do">
      <AnimatedContent distance={24} duration={0.72} threshold={0.16} animateOpacity={false}>
        <div className="section-heading">
          <div>
            <span className="eyebrow">WHAT WE DO</span>
            <h2>Proof a paid API holds.</h2>
          </div>
        </div>
      </AnimatedContent>

      <div className="capabilities-grid">
        {CAPABILITIES.map((capability, index) => {
          const Icon = capability.icon;
          return (
            <AnimatedContent
              key={capability.title}
              distance={20}
              duration={0.66}
              delay={0.05 * index}
              threshold={0.1}
              animateOpacity={false}
            >
              <SpotlightCard className="capability-card" spotlightColor="rgba(240, 196, 25, 0.13)">
                <div className="capability-card-top">
                  <Icon className="capability-icon" aria-hidden="true" strokeWidth={1.7} />
                  {capability.tag === 'beta' && <span className="capability-tag">BETA</span>}
                </div>
                <h3>{capability.title}</h3>
                <p>{capability.body}</p>
              </SpotlightCard>
            </AnimatedContent>
          );
        })}
      </div>
    </section>
  );
}
