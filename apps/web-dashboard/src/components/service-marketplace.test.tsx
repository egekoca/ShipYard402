// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { MarketplaceService } from '@shipyard402/public-api-client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceMarketplace, monogram, shortenUrl } from './service-marketplace';

const { listMarketplaceServices } = vi.hoisted(() => ({ listMarketplaceServices: vi.fn() }));

vi.mock('@shipyard402/public-api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shipyard402/public-api-client')>();
  return {
    ...actual,
    ShipyardApiClient: class {
      listMarketplaceServices = listMarketplaceServices;
    },
  };
});

const GOAT_DEMO: MarketplaceService = {
  organizationId: 'b6b9ef3b-5528-4dd6-b3e7-cb79440db30a',
  targetServiceId: 'service:x402-demo-target:testnet3-real-merchant',
  targetAgentId: 'agent:shipyard402-selftest',
  targetVersionHash: '0xd7a58f3393a3ce108484d3fe83c2a65a870c99cb1be072363b9cc26f1f5ec176',
  policyHash: '0x46a763af460addd917b0bb04976aee3544dbfe1e5d8cfe89808247091351c490',
  x402Endpoint: 'https://demo.shipyard402.dev/paid/resource',
  openApiUrl: 'https://demo.shipyard402.dev/openapi.json',
  name: 'GOAT Testnet Paid API',
  description: 'Shipyard’s own x402 reference service.',
  logoUrl: '/logo-mark.png',
  version: '1.0.0',
  chainId: 48816,
  listedAt: '2026-08-13T00:00:00.000Z',
};

const ACME: MarketplaceService = {
  ...GOAT_DEMO,
  organizationId: '11111111-2222-3333-4444-555555555555',
  targetServiceId: 'service:acme-weather',
  targetAgentId: 'agent:service:acme-weather',
  x402Endpoint: 'https://api.acme.com/paid/weather',
  name: 'Acme Weather',
  description: null,
  logoUrl: null,
  version: '2.1.0',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const BNB_TARGET: MarketplaceService = {
  ...GOAT_DEMO,
  organizationId: '22222222-3333-4444-5555-666666666666',
  targetServiceId: 'service:bnb-weather',
  targetAgentId: 'agent:service:bnb-weather',
  x402Endpoint: 'https://api.bnb.example/paid/weather',
  name: 'BNB Weather',
  description: null,
  logoUrl: null,
  version: '1.0.0',
  chainId: 56,
};

const BOT_TARGET: MarketplaceService = {
  ...GOAT_DEMO,
  organizationId: '33333333-4444-5555-6666-777777777777',
  targetServiceId: 'service:botchain-paid-api',
  targetAgentId: 'agent:service:botchain-paid-api',
  x402Endpoint: 'https://api.bot.example/paid/resource',
  name: 'BOT Chain Paid API',
  description: 'A controlled BOT Chain testnet target.',
  logoUrl: null,
  version: '0.1.0',
  chainId: 968,
};

describe('ServiceMarketplace', () => {
  it('renders one selectable card per listed service', async () => {
    listMarketplaceServices.mockResolvedValue([GOAT_DEMO, ACME]);

    render(<ServiceMarketplace selectedServiceId="" canRegister onSelect={vi.fn()} onRegisterOwn={vi.fn()} />);

    expect(await screen.findByText('GOAT Testnet Paid API')).toBeInTheDocument();
    expect(screen.getByText('Acme Weather')).toBeInTheDocument();
  });

  it('filters the directory by chain via the toggle tabs', async () => {
    listMarketplaceServices.mockResolvedValue([GOAT_DEMO, BNB_TARGET]);
    const user = userEvent.setup();

    render(<ServiceMarketplace selectedServiceId="" canRegister onSelect={vi.fn()} onRegisterOwn={vi.fn()} />);

    // Default lands on GOAT (which has a listing); the BNB target is hidden.
    expect(await screen.findByText('GOAT Testnet Paid API')).toBeInTheDocument();
    expect(screen.queryByText('BNB Weather')).not.toBeInTheDocument();

    // Toggling to BNB shows only the BNB target and hides the GOAT one.
    await user.click(screen.getByRole('tab', { name: /BNB/ }));
    expect(await screen.findByText('BNB Weather')).toBeInTheDocument();
    expect(screen.queryByText('GOAT Testnet Paid API')).not.toBeInTheDocument();

    // BOT Chain has no listing -> a per-chain empty state, never a blank grid.
    await user.click(screen.getByRole('tab', { name: /BOT Chain/ }));
    expect(await screen.findByText(/No BOT Chain targets listed yet/)).toBeInTheDocument();
  });

  it('opens on a chain that actually has listings instead of an empty default tab', async () => {
    // Only a BNB target exists; the directory must not open on an empty GOAT tab.
    listMarketplaceServices.mockResolvedValue([BNB_TARGET]);

    render(<ServiceMarketplace selectedServiceId="" canRegister onSelect={vi.fn()} onRegisterOwn={vi.fn()} />);

    expect(await screen.findByText('BNB Weather')).toBeInTheDocument();
  });

  it('merges the BOT catalog and preserves its backend route when selected', async () => {
    listMarketplaceServices.mockResolvedValue([GOAT_DEMO, BOT_TARGET]);
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(<ServiceMarketplace selectedServiceId="" canRegister onSelect={onSelect} onRegisterOwn={vi.fn()} />);
    await user.click(await screen.findByRole('tab', { name: /BOT Chain/ }));
    await user.click(await screen.findByText('BOT Chain Paid API'));

    expect(onSelect).toHaveBeenCalledWith({ ...BOT_TARGET, apiBackend: 'bot-chain' });
  });

  it('hands the full catalog identity of the clicked service to the parent', async () => {
    listMarketplaceServices.mockResolvedValue([GOAT_DEMO, ACME]);
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(<ServiceMarketplace selectedServiceId="" canRegister onSelect={onSelect} onRegisterOwn={vi.fn()} />);
    await user.click(await screen.findByText('Acme Weather'));

    // The whole point of the directory: one click yields every identifier a quote binds against,
    // so nothing is left for a person to hand-type.
    expect(onSelect).toHaveBeenCalledWith({ ...ACME, apiBackend: 'goat' });
  });

  it('marks the service the form is currently targeting as selected', async () => {
    listMarketplaceServices.mockResolvedValue([GOAT_DEMO, ACME]);

    render(
      <ServiceMarketplace
        selectedServiceId={GOAT_DEMO.targetServiceId}
        canRegister
        onSelect={vi.fn()}
        onRegisterOwn={vi.fn()}
      />,
    );

    const selected = await screen.findByRole('button', { pressed: true });
    expect(selected).toHaveTextContent('GOAT Testnet Paid API');
    expect(screen.getByRole('button', { name: /Acme Weather/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('degrades to a note instead of an error when the directory cannot be reached', async () => {
    listMarketplaceServices.mockRejectedValue(new Error('network down'));

    render(<ServiceMarketplace selectedServiceId="" canRegister onSelect={vi.fn()} onRegisterOwn={vi.fn()} />);

    expect(await screen.findByText(/directory is unreachable/)).toBeInTheDocument();
  });

  it('points at registration when nothing is listed yet', async () => {
    listMarketplaceServices.mockResolvedValue([]);

    render(<ServiceMarketplace selectedServiceId="" canRegister onSelect={vi.fn()} onRegisterOwn={vi.fn()} />);

    expect(await screen.findByText(/No services have been listed publicly yet/)).toBeInTheDocument();
  });

  it('disables registration until a wallet is connected, since a listing is wallet-owned', async () => {
    listMarketplaceServices.mockResolvedValue([GOAT_DEMO]);
    const onRegisterOwn = vi.fn();
    const user = userEvent.setup();

    render(
      <ServiceMarketplace selectedServiceId="" canRegister={false} onSelect={vi.fn()} onRegisterOwn={onRegisterOwn} />,
    );

    const register = screen.getByRole('button', { name: 'Connect a wallet to add your API' });
    await user.click(register);
    await waitFor(() => expect(onRegisterOwn).not.toHaveBeenCalled());
  });
});

describe('monogram', () => {
  it('takes initials from the first two words', () => {
    expect(monogram('GOAT Testnet Paid API')).toBe('GT');
  });

  it('falls back to the first two letters of a single word', () => {
    expect(monogram('Acme')).toBe('AC');
  });

  it('splits identifier-style names on their separators', () => {
    expect(monogram('service:acme-weather')).toBe('SA');
  });

  it('survives a name with nothing alphanumeric in it', () => {
    expect(monogram('  ---  ')).toBe('?');
  });
});

describe('shortenUrl', () => {
  it('keeps the host and a short path intact', () => {
    expect(shortenUrl('https://api.acme.com/paid')).toBe('api.acme.com/paid');
  });

  it('drops a bare root path rather than showing a dangling slash', () => {
    expect(shortenUrl('https://api.acme.com/')).toBe('api.acme.com');
  });

  it('truncates a long path so it cannot overflow the card', () => {
    expect(shortenUrl('https://api.acme.com/very/long/path/that/keeps/going/forever')).toBe(
      'api.acme.com/very/long/path/that/…',
    );
  });

  it('returns an unparseable value unchanged instead of throwing', () => {
    expect(shortenUrl('not a url')).toBe('not a url');
  });
});
