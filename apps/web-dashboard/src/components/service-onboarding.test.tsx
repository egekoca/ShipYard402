// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { ShipyardApiError } from '@shipyard402/public-api-client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceOnboarding } from './service-onboarding';

const { onboardService, ensureSession } = vi.hoisted(() => ({
  onboardService: vi.fn(),
  ensureSession: vi.fn(),
}));

vi.mock('@shipyard402/public-api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shipyard402/public-api-client')>();
  return {
    ...actual,
    ShipyardApiClient: class {
      onboardService = onboardService;
    },
  };
});

vi.mock('../lib/session', () => ({
  ensureSession,
  getStoredSessionToken: () => null,
}));

const REQUESTER_ADDRESS = '0x3000000000000000000000000000000000000003';

/**
 * Open/closed lives in the parent now (the directory's "add your API" affordance opens this same
 * panel), so the tests own that state the same way ReleaseRunForm does -- exercising the real
 * controlled contract rather than a component that can no longer open itself.
 */
function ControlledOnboarding({
  onOnboarded,
}: Readonly<{ onOnboarded: ComponentProps<typeof ServiceOnboarding>['onOnboarded'] }>) {
  const [open, setOpen] = useState(false);
  return (
    <ServiceOnboarding
      requesterAddress={REQUESTER_ADDRESS}
      open={open}
      onOpenChange={setOpen}
      onOnboarded={onOnboarded}
    />
  );
}

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Test a different service instead →' }));
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Acme Inc'), 'Acme Inc');
  await user.type(screen.getByPlaceholderText('service:acme-api'), 'service:acme-api');
  await user.type(screen.getByPlaceholderText('Acme paid API'), 'Acme paid API');
  await user.type(
    screen.getByPlaceholderText('https://api.acme.com/paid/resource'),
    'https://api.acme.com/paid/resource',
  );
  await user.type(
    screen.getByPlaceholderText('https://api.acme.com/openapi.json'),
    'https://api.acme.com/openapi.json',
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ServiceOnboarding', () => {
  it('starts collapsed behind a toggle link', () => {
    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Test a different service instead →' })).toBeInTheDocument();
    expect(screen.queryByText('Register service')).not.toBeInTheDocument();
  });

  it('expands into the full registration form on click', async () => {
    const user = userEvent.setup();
    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    await openForm(user);
    expect(screen.getByRole('button', { name: 'Register service' })).toBeInTheDocument();
  });

  it('blocks submission with empty fields instead of calling the API', async () => {
    const user = userEvent.setup();
    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    await openForm(user);
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    expect(await screen.findByText('All fields except the description are required.')).toBeInTheDocument();
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it('keeps a service out of the public directory unless listing is explicitly ticked', async () => {
    ensureSession.mockResolvedValue('session-token');
    onboardService.mockResolvedValue({ targetServiceId: 'service:acme-api' });
    const user = userEvent.setup();

    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    await openForm(user);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    await waitFor(() => expect(onboardService).toHaveBeenCalled());
    expect(onboardService.mock.calls[0]?.[0]).toMatchObject({ marketplaceListed: false });
    expect(onboardService.mock.calls[0]?.[0]).not.toHaveProperty('description');
  });

  it('sends the listing opt-in and its description when the box is ticked', async () => {
    ensureSession.mockResolvedValue('session-token');
    onboardService.mockResolvedValue({ targetServiceId: 'service:acme-api' });
    const user = userEvent.setup();

    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    await openForm(user);
    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: /List this service publicly/ }));
    await user.type(screen.getByPlaceholderText(/What this paid API does/), 'Weather data, per call.');
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    await waitFor(() => expect(onboardService).toHaveBeenCalled());
    expect(onboardService.mock.calls[0]?.[0]).toMatchObject({
      marketplaceListed: true,
      description: 'Weather data, per call.',
    });
  });

  it('offers the settlement chain as a real radio group, GOAT selected by default', async () => {
    const user = userEvent.setup();

    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    await openForm(user);

    // Native radios, not buttons wearing role="radio": arrow keys, form participation and
    // screen-reader grouping all come from the browser rather than from hand-rolled ARIA.
    expect(screen.getByRole('radio', { name: /GOAT/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /BNB/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /BOT Chain/ })).not.toBeChecked();
  });

  it('onboards against the chain the operator picked, not the default', async () => {
    ensureSession.mockResolvedValue('session-token');
    onboardService.mockResolvedValue({ targetServiceId: 'service:acme-api' });
    const user = userEvent.setup();

    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    await openForm(user);
    await fillForm(user);
    await user.click(screen.getByRole('radio', { name: /BNB/ }));
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    await waitFor(() => expect(onboardService).toHaveBeenCalled());
    expect(onboardService.mock.calls[0]?.[0]).toMatchObject({ chainId: 56 });
  });

  it('registers the service and reports the result back to the parent', async () => {
    ensureSession.mockResolvedValue('session-token');
    const onboarded = {
      organizationId: 'org_1',
      targetServiceId: 'service:acme-api:1.0.0',
      targetVersionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000aaa',
      policyHash: '0xbbbb000000000000000000000000000000000000000000000000000000000bbb',
      x402Endpoint: 'https://api.acme.com/paid/resource',
      openApiUrl: 'https://api.acme.com/openapi.json',
    };
    onboardService.mockResolvedValue(onboarded);
    const onOnboarded = vi.fn();
    const user = userEvent.setup();

    render(<ControlledOnboarding onOnboarded={onOnboarded} />);
    await openForm(user);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    await waitFor(() => expect(onOnboarded).toHaveBeenCalledWith(onboarded, 'goat', 48816));
    expect(await screen.findByText('service:acme-api:1.0.0')).toBeInTheDocument();
  });

  it('shows the API error code and message when onboarding is rejected', async () => {
    ensureSession.mockResolvedValue('session-token');
    onboardService.mockRejectedValue(
      new ShipyardApiError(422, 'OPENAPI_HOST_FORBIDDEN', 'That host is not allowlisted'),
    );
    const user = userEvent.setup();

    render(<ControlledOnboarding onOnboarded={vi.fn()} />);
    await openForm(user);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    expect(await screen.findByText('OPENAPI_HOST_FORBIDDEN: That host is not allowlisted')).toBeInTheDocument();
  });
});
