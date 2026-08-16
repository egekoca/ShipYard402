/**
 * A small, hand-curated sample of real third-party x402 services, shown purely for discovery.
 *
 * These are NOT testable through Shipyard and deliberately carry no "run" affordance: they are
 * live production APIs on Base/Solana mainnet that never asked us to attack their payment logic,
 * and running adversarial paid scenarios against a non-consenting operator would be unauthorized
 * security testing. The showcase links out so a visitor can see the ecosystem is real; the only
 * things Shipyard actually runs against are consented targets (the onboarding form / the listed
 * directory above).
 *
 * Each entry carries only what can be stated truthfully from the source directory
 * (https://x402-list.com) -- name, networks, price band, and canonical URL. No description is
 * invented: we don't independently know what each service does, so we don't claim to.
 *
 * Curated and static on purpose: this is an illustrative sample, not a live mirror. The "browse
 * the full directory" link is the fresh, authoritative surface; a few of these may go stale, and
 * that's fine for a showcase.
 */
export type EcosystemService = Readonly<{
  name: string;
  url: string;
  networks: readonly string[];
  priceLabel: string;
}>;

export const ECOSYSTEM_DIRECTORY_URL = 'https://x402-list.com';

export const ECOSYSTEM_SHOWCASE: readonly EcosystemService[] = [
  { name: 'Strale', url: 'https://api.strale.io', networks: ['Base'], priceLabel: '$0.02–$0.22' },
  { name: 'Agent Web Access', url: 'https://web.fullyagentic.net', networks: ['Base'], priceLabel: '$0.005–$0.01' },
  { name: 'makesPDF', url: 'https://makespdf.com', networks: ['Base'], priceLabel: '$0.02' },
  {
    name: 'Japan Diet API',
    url: 'https://diet.agentic-jp.com',
    networks: ['Base', 'Polygon', 'Solana'],
    priceLabel: '$0.004–$0.012',
  },
  {
    name: 'DomainSignal',
    url: 'https://api.servocenter.com',
    networks: ['Base', 'Solana'],
    priceLabel: '$0.001–$0.01',
  },
  { name: 'AgentToll', url: 'https://agenttoll.app', networks: ['Base'], priceLabel: '$0.001–$0.005' },
  { name: 'XRPL Microstructure', url: 'https://data.tg-lw.com', networks: ['Base'], priceLabel: '$0.05–$0.75' },
  { name: 'Gondola', url: 'https://api.gondola-ai.com', networks: ['Base'], priceLabel: 'from $0.01' },
];
