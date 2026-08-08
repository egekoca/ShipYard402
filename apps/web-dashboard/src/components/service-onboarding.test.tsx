// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { ShipyardApiError } from '@shipyard402/public-api-client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    render(<ServiceOnboarding requesterAddress={REQUESTER_ADDRESS} onOnboarded={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Test a different service instead →' })).toBeInTheDocument();
    expect(screen.queryByText('Register service')).not.toBeInTheDocument();
  });

  it('expands into the full registration form on click', async () => {
    const user = userEvent.setup();
    render(<ServiceOnboarding requesterAddress={REQUESTER_ADDRESS} onOnboarded={vi.fn()} />);
    await openForm(user);
    expect(screen.getByRole('button', { name: 'Register service' })).toBeInTheDocument();
  });

  it('blocks submission with empty fields instead of calling the API', async () => {
    const user = userEvent.setup();
    render(<ServiceOnboarding requesterAddress={REQUESTER_ADDRESS} onOnboarded={vi.fn()} />);
    await openForm(user);
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    expect(await screen.findByText('All fields are required.')).toBeInTheDocument();
    expect(ensureSession).not.toHaveBeenCalled();
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

    render(<ServiceOnboarding requesterAddress={REQUESTER_ADDRESS} onOnboarded={onOnboarded} />);
    await openForm(user);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    await waitFor(() => expect(onOnboarded).toHaveBeenCalledWith(onboarded));
    expect(await screen.findByText('service:acme-api:1.0.0')).toBeInTheDocument();
  });

  it('shows the API error code and message when onboarding is rejected', async () => {
    ensureSession.mockResolvedValue('session-token');
    onboardService.mockRejectedValue(
      new ShipyardApiError(422, 'OPENAPI_HOST_FORBIDDEN', 'That host is not allowlisted'),
    );
    const user = userEvent.setup();

    render(<ServiceOnboarding requesterAddress={REQUESTER_ADDRESS} onOnboarded={vi.fn()} />);
    await openForm(user);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Register service' }));

    expect(await screen.findByText('OPENAPI_HOST_FORBIDDEN: That host is not allowlisted')).toBeInTheDocument();
  });
});
