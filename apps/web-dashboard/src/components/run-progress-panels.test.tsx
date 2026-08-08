// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { AttestationResponse, EvidenceResponse, PlanResponse, RunResponse } from '@shipyard402/public-api-client';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunProgressPanels } from './run-progress-panels';

const { useStepDurationStats } = vi.hoisted(() => ({ useStepDurationStats: vi.fn() }));

vi.mock('../hooks/use-run-progress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-run-progress')>();
  return { ...actual, useStepDurationStats };
});

function baseRun(
  runOverrides: Partial<RunResponse['run']> = {},
  paymentOverrides: Partial<RunResponse['payment']> = {},
): RunResponse {
  return {
    run: {
      id: 'run_1',
      status: 'PAYMENT_REQUIRED',
      revision: 1,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      ...runOverrides,
    },
    payment: {
      status: 'PENDING',
      mode: 'ERC20_DIRECT',
      nextAction: 'AWAIT_PAYMENT_RECONCILIATION',
      ...paymentOverrides,
    },
  };
}

const REQUIRED_PROPS = { runId: 'run_1', plan: null, evidence: null, attestation: null, isTerminal: false };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RunProgressPanels', () => {
  it('shows a preparing state on the payment panel before a challenge exists', () => {
    useStepDurationStats.mockReturnValue(null);
    render(<RunProgressPanels {...REQUIRED_PROPS} run={baseRun()} activeStep={-1} />);
    expect(screen.getByText('Preparing the payment challenge…')).toBeInTheDocument();
  });

  it('renders the wallet-pay panel once a payment challenge is issued', () => {
    useStepDurationStats.mockReturnValue(null);
    const run = baseRun(undefined, {
      paymentRequired: {
        x402Version: 1,
        resource: { url: 'https://example.com/paid' },
        accepts: [
          {
            scheme: 'exact',
            network: 'goat-testnet3',
            amount: '1500000',
            asset: '0xaaaa',
            payTo: '0xbbbb',
            maxTimeoutSeconds: 60,
          },
        ],
      },
    });
    render(<RunProgressPanels {...REQUIRED_PROPS} run={run} activeStep={-1} />);
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Pay to')).toBeInTheDocument();
  });

  it('shows the confirmed payment tx link once payment is ready', () => {
    useStepDurationStats.mockReturnValue(null);
    const run = baseRun(undefined, {
      status: 'PAID',
      transactionHash: '0xdeadbeef00000000000000000000000000000000000000000000000000000001',
      chainId: 48816,
    });
    render(<RunProgressPanels {...REQUIRED_PROPS} run={run} activeStep={0} />);
    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'view payment tx ↗' })).toHaveAttribute(
      'href',
      'https://explorer.testnet3.goat.network/tx/0xdeadbeef00000000000000000000000000000000000000000000000000000001',
    );
  });

  it('shows the AI risk plan once compiled', () => {
    useStepDurationStats.mockReturnValue(null);
    const plan: PlanResponse = {
      runId: 'run_1',
      riskLevel: 'MEDIUM',
      scenarios: ['payment-proof-replay', 'unpaid-access-denial'],
      toolBudgetAtomic: '150',
      rationale: 'Standard replay coverage for a first-party demo target.',
    };
    render(<RunProgressPanels {...REQUIRED_PROPS} run={baseRun()} plan={plan} activeStep={1} />);
    expect(screen.getByText('MEDIUM risk · 2 scenarios')).toBeInTheDocument();
  });

  it('shows the terminal verdict banner once the run is done', () => {
    useStepDurationStats.mockReturnValue(null);
    const run = baseRun({ status: 'DELIVERED_PASS' });
    render(<RunProgressPanels {...REQUIRED_PROPS} run={run} activeStep={5} isTerminal />);
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.getByText(/reached a terminal state/)).toBeInTheDocument();
  });

  it('expands a ready panel on click but leaves a pending panel non-interactive', async () => {
    useStepDurationStats.mockReturnValue(null);
    const attestation: AttestationResponse = {
      runId: 'run_1',
      registryAddress: '0xcccc000000000000000000000000000000000000000000000000000000000ccc',
      chainId: 48816,
      transactionHash: '0xdddd000000000000000000000000000000000000000000000000000000000ddd',
      attestor: '0xeeee000000000000000000000000000000000000000000000000000000000eee',
      expiresAt: '2026-09-01T00:00:00.000Z',
      submittedAt: '2026-08-05T00:10:00.000Z',
    };
    const user = userEvent.setup();
    render(<RunProgressPanels {...REQUIRED_PROPS} run={baseRun()} attestation={attestation} activeStep={0} />);

    const attestationToggle = screen.getByRole('button', { name: /ON-CHAIN ATTESTATION/ });
    expect(attestationToggle).not.toBeDisabled();
    await user.click(attestationToggle);
    expect(screen.getByText('Registry')).toBeInTheDocument();

    const planToggle = screen.getByRole('button', { name: /AI RISK PLAN/ });
    expect(planToggle).toBeDisabled();
  });

  it('shows an evidence FAIL result with the failing tone', () => {
    useStepDurationStats.mockReturnValue(null);
    const evidence: EvidenceResponse = {
      runId: 'run_1',
      evidenceRoot: '0xffff000000000000000000000000000000000000000000000000000000000fff',
      toolReceiptRoot: '0x1111000000000000000000000000000000000000000000000000000000001111',
      uri: 'ipfs://bafybeigd',
      contentHash: '0x2222000000000000000000000000000000000000000000000000000000002222',
      builtAt: '2026-08-05T00:12:00.000Z',
      publicManifest: {
        runId: 'run_1',
        targetServiceId: 'service:x402-demo-target',
        targetVersionHash: '0x3333000000000000000000000000000000000000000000000000000000003333',
        policyHash: '0x4444000000000000000000000000000000000000000000000000000000004444',
        riskLevel: 'MEDIUM',
        rationale: 'test',
        toolBudgetAtomic: '150',
        scenarios: ['payment-proof-replay'],
        scenarioTraces: [],
        result: 'FAIL',
        toolReceipts: [],
      },
    };
    render(<RunProgressPanels {...REQUIRED_PROPS} run={baseRun()} evidence={evidence} activeStep={3} />);
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'SPAN' && element.textContent === 'FAIL · 0 paid tool checks against the target',
      ),
    ).toBeInTheDocument();
  });
});
