import type { CSSProperties } from 'react';
import { FileSignature, Target } from 'lucide-react';

import AnimatedContent from './AnimatedContent';
import { NetworkLogo } from './network-marks';

type FlowNode = Readonly<{
  key: string;
  label: string;
  sub: string;
  render: () => import('react').JSX.Element;
  colorVar: string;
}>;

/** The bridge-then-pay pipeline, left to right: funds start on GOAT, bridge to BNB, pay the target,
 * and the outcome is attested on-chain. Purely illustrative -- an honest picture of the mechanism. */
const NODES: readonly FlowNode[] = [
  {
    key: 'goat',
    label: 'GOAT · USDC',
    sub: 'funded',
    colorVar: '--goat',
    render: () => <NetworkLogo networkId="goat-mainnet" size={30} className="flow-node-logo" />,
  },
  {
    key: 'bnb',
    label: 'BNB · USDC',
    sub: 'bridged',
    colorVar: '--bnb',
    render: () => <NetworkLogo networkId="bnb" size={30} className="flow-node-logo" />,
  },
  {
    key: 'target',
    label: 'Paid endpoint',
    sub: 'paid for real',
    colorVar: '--gold',
    render: () => <Target className="flow-node-lucide" strokeWidth={1.7} aria-hidden="true" />,
  },
  {
    key: 'evidence',
    label: 'Signed on-chain',
    sub: 'verifiable',
    colorVar: '--bot-green',
    render: () => <FileSignature className="flow-node-lucide" strokeWidth={1.7} aria-hidden="true" />,
  },
];

const CONNECTOR_LABELS = ['bridge', 'pay', 'attest'] as const;

export function CrossChainFlow() {
  return (
    <section className="cross-chain-flow" aria-label="How a cross-chain run pays a target">
      <AnimatedContent distance={24} duration={0.72} threshold={0.16} animateOpacity={false}>
        <div className="section-heading">
          <div>
            <span className="eyebrow">CROSS-CHAIN, ONE RUN</span>
            <h2>Funded on GOAT. Paid on BNB.</h2>
          </div>
        </div>
      </AnimatedContent>

      <AnimatedContent distance={20} duration={0.72} delay={0.08} threshold={0.1} animateOpacity={false}>
        <ol className="flow-rail">
          {NODES.map((node, index) => (
            <li className="flow-step" key={node.key}>
              <div className="flow-node" style={{ '--flow-color': `var(${node.colorVar})` } as CSSProperties}>
                <span className="flow-node-icon">{node.render()}</span>
                <span className="flow-node-label">{node.label}</span>
                <span className="flow-node-sub">{node.sub}</span>
              </div>
              {index < NODES.length - 1 && (
                <div className="flow-connector" aria-hidden="true">
                  <span className="flow-connector-line">
                    <span className="flow-connector-pulse" style={{ '--delay': `${index * 0.5}s` } as CSSProperties} />
                  </span>
                  <span className="flow-connector-label">{CONNECTOR_LABELS[index]}</span>
                </div>
              )}
            </li>
          ))}
        </ol>
      </AnimatedContent>
    </section>
  );
}
