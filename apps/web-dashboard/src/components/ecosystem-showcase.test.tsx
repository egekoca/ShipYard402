// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EcosystemShowcase } from './ecosystem-showcase';
import { ECOSYSTEM_DIRECTORY_URL, ECOSYSTEM_SHOWCASE } from './ecosystem-showcase-data';

afterEach(cleanup);

describe('EcosystemShowcase', () => {
  it('renders each curated service as an outbound link to its own site', () => {
    render(<EcosystemShowcase />);
    for (const service of ECOSYSTEM_SHOWCASE) {
      const link = screen.getByRole('link', { name: new RegExp(service.name) });
      expect(link).toHaveAttribute('href', service.url);
      // New tab + no referrer: these are third-party sites, not part of the app.
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    }
  });

  it('links to the full external directory as the fresh source', () => {
    render(<EcosystemShowcase />);
    expect(screen.getByRole('link', { name: /Browse the full directory/ })).toHaveAttribute(
      'href',
      ECOSYSTEM_DIRECTORY_URL,
    );
  });

  it('offers no way to start a run — showcase is discovery-only', () => {
    render(<EcosystemShowcase />);
    // The whole point of the compromise: nothing here can fire an adversarial run at a
    // non-consenting operator. No buttons at all, and no "test"/"select" affordance.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/test this api/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/select/i)).not.toBeInTheDocument();
  });

  it('says plainly that these are not testable through Shipyard', () => {
    render(<EcosystemShowcase />);
    expect(screen.getByText(/aren.t testable through Shipyard/i)).toBeInTheDocument();
  });
});
