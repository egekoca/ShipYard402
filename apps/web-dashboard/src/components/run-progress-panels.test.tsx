// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { AttestationResponse, EvidenceResponse, PlanResponse, RunResponse } from '@shipyard402/public-api-client';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePaymentChainId, RunProgressPanels } from './run-progress-panels';

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
  it('keeps a pending BOT Chain payment on chain 968 before reconciliation', () => {
    expect(resolvePaymentChainId(undefined, 'eip155:968', 'bot-chain')).toBe(968);
    expect(resolvePaymentChainId(undefined, undefined, 'bot-chain')).toBe(968);
  });

  it('prefers an explicit order chain over challenge and backend fallbacks', () => {
    expect(resolvePaymentChainId(968, 'eip155:48816', 'goat')).toBe(968);
  });

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

  it('names the final step after the chain that actually received the attestation', () => {
    useStepDurationStats.mockReturnValue(null);
    const attestation: AttestationResponse = {
      runId: 'run_1',
      registryAddress: '0xcccc000000000000000000000000000000000000000000000000000000000ccc',
      chainId: 968,
      transactionHash: '0xdddd000000000000000000000000000000000000000000000000000000000ddd',
      attestor: '0xeeee000000000000000000000000000000000000000000000000000000000eee',
      expiresAt: '2026-09-01T00:00:00.000Z',
      submittedAt: '2026-08-18T00:10:00.000Z',
    };
    const run = baseRun({ status: 'DELIVERED_PASS' }, { status: 'PAID', chainId: 968 });

    render(
      <RunProgressPanels
        {...REQUIRED_PROPS}
        run={run}
        attestation={attestation}
        activeStep={5}
        isTerminal
        apiBackend="bot-chain"
      />,
    );

    expect(screen.getByText('BOT Chain attestation')).toBeInTheDocument();
    expect(screen.queryByText('GOAT attestation')).not.toBeInTheDocument();
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

  it('shows a bridged run as two ordered steps with both transaction trails', async () => {
    useStepDurationStats.mockReturnValue(null);
    const run: RunResponse = {
      ...baseRun({ status: 'EXECUTING' }, { status: 'PAID' }),
      settlementLegs: [
        {
          legIndex: 0,
          kind: 'BRIDGE',
          network: 'eip155:2345',
          assetSymbol: 'USDT',
          assetDecimals: 6,
          status: 'CONFIRMED',
          transactionHash: `0x${'11'.repeat(32)}`,
          amountAtomic: '250000',
          provider: 'STARGATE_V2_LAYERZERO',
          detail: {
            destinationNetwork: 'eip155:56',
            destinationAssetSymbol: 'USDT',
            destinationTransactionHash: `0x${'22'.repeat(32)}`,
          },
        },
        {
          legIndex: 1,
          kind: 'TARGET_PAYMENT',
          network: 'eip155:56',
          assetSymbol: 'USDT',
          assetDecimals: 18,
          status: 'CONFIRMED',
          transactionHash: `0x${'33'.repeat(32)}`,
          amountAtomic: '200000000000000000',
          provider: 'x402',
        },
      ],
    };
    const user = userEvent.setup();
    render(<RunProgressPanels {...REQUIRED_PROPS} run={run} activeStep={2} />);

    expect(screen.getAllByText('Bridging funds')).not.toHaveLength(0);
    expect(screen.getAllByText('Buying the API call')).not.toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'source tx ↗' })[0]).toHaveAttribute(
      'href',
      `https://explorer.goat.network/tx/0x${'11'.repeat(32)}`,
    );
    expect(screen.getAllByRole('link', { name: 'arrival tx ↗' })[0]).toHaveAttribute(
      'href',
      `https://bscscan.com/tx/0x${'22'.repeat(32)}`,
    );
    await user.click(screen.getByRole('button', { name: /CROSS-CHAIN PROCUREMENT/ }));
    expect(screen.getAllByText('0.2')).not.toHaveLength(0);
  });

  it('shows a prefunded run as a single purchase step, with no bridge stage invented', async () => {
    // A prefunded run genuinely never bridged; drawing a bridge stage would be a lie about it.
    useStepDurationStats.mockReturnValue(null);
    const run: RunResponse = {
      ...baseRun({ status: 'EXECUTING' }, { status: 'PAID' }),
      settlementLegs: [
        {
          legIndex: 1,
          kind: 'TARGET_PAYMENT',
          network: 'eip155:56',
          assetSymbol: 'USD1',
          assetDecimals: 18,
          status: 'CONFIRMED',
          amountAtomic: '1000000000000000',
          provider: 'x402',
        },
      ],
    };
    render(<RunProgressPanels {...REQUIRED_PROPS} run={run} activeStep={2} />);

    expect(screen.queryByText('Bridging funds')).toBeNull();
    expect(screen.getAllByText('Buying the API call')).not.toHaveLength(0);
    expect(screen.getAllByText('0.001')).not.toHaveLength(0);
  });

  it('explains a refused purchase in words rather than leaving the step spinning', async () => {
    useStepDurationStats.mockReturnValue(null);
    const run: RunResponse = {
      ...baseRun({ status: 'EXECUTING' }, { status: 'PAID' }),
      settlementLegs: [
        {
          legIndex: 1,
          kind: 'TARGET_PAYMENT',
          network: 'eip155:56',
          assetSymbol: 'USD1',
          assetDecimals: 18,
          status: 'FAILED',
          provider: 'x402',
          detail: { rejectionCodes: ['ASSET_NOT_HELD'] },
        },
      ],
    };
    render(<RunProgressPanels {...REQUIRED_PROPS} run={run} activeStep={2} />);

    expect(screen.getAllByText('Priced in a token this run does not hold')).not.toHaveLength(0);
    expect(screen.getAllByText('Refused')).not.toHaveLength(0);
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
