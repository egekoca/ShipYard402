'use client';

import type { SettlementLeg } from '@shipyard402/public-api-client';
import { ArrowRight, Check, ShoppingCart, X } from 'lucide-react';

import { networkByChainId } from '../lib/networks';
import { ExplorerTxLink } from './explorer-tx-link';
import { NetworkLogo } from './network-marks';
import { TokenMark } from './token-marks';

/**
 * Shows what a run's money is doing right now, as an ordered strip of steps.
 *
 * Every step is rendered from a recorded leg, so this never claims a stage that did not happen: a
 * prefunded run simply has no bridge step, and a step still in flight animates rather than being
 * drawn as complete. Assets carry their own marks and chains their own logos, so the shape of the
 * movement is readable before any of the text is.
 */

export function SettlementFlow({ legs }: Readonly<{ legs: readonly SettlementLeg[] }>) {
  if (legs.length === 0) return null;
  const ordered = [...legs].sort((left, right) => left.legIndex - right.legIndex);
  return (
    <ol className="settlement-flow" aria-label="Settlement steps">
      {ordered.map((leg, index) => (
        <li className="settlement-step-item" key={leg.legIndex}>
          {index > 0 && <StepConnector active={leg.status !== 'PENDING'} />}
          <SettlementStep leg={leg} />
        </li>
      ))}
    </ol>
  );
}

/** The travelling dot only animates while the step it leads into is still working. */
function StepConnector({ active }: Readonly<{ active: boolean }>) {
  return (
    <span className={active ? 'settlement-connector settlement-connector--active' : 'settlement-connector'}>
      <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

function SettlementStep({ leg }: Readonly<{ leg: SettlementLeg }>) {
  const chainId = chainIdFromCaip2(leg.network);
  const network = chainId === null ? null : networkByChainId(chainId);
  const inFlight = leg.status === 'PENDING' || leg.status === 'SUBMITTED';
  const destination = readString(leg.detail, 'destinationAssetSymbol');
  const destinationNetwork = readString(leg.detail, 'destinationNetwork');
  const destinationChainId = destinationNetwork === null ? null : chainIdFromCaip2(destinationNetwork);
  const destinationHash = readHash(leg.detail, 'destinationTransactionHash');

  return (
    <article className={`settlement-step settlement-step--${leg.status.toLowerCase()}`}>
      <header className="settlement-step-head">
        <span className="settlement-step-kind">
          {leg.kind === 'BRIDGE' ? (
            <>
              <TokenMark symbol={leg.assetSymbol} size={20} />
              <ArrowRight size={12} strokeWidth={2.5} aria-hidden="true" />
              <TokenMark symbol={destination ?? leg.assetSymbol} size={20} />
            </>
          ) : (
            <>
              <span className="settlement-step-icon">
                <ShoppingCart size={13} strokeWidth={2} aria-hidden="true" />
              </span>
              <TokenMark symbol={leg.assetSymbol} size={20} />
            </>
          )}
        </span>
        <StatusPip status={leg.status} inFlight={inFlight} />
      </header>

      <h4 className="settlement-step-title">{leg.kind === 'BRIDGE' ? 'Bridging funds' : 'Buying the API call'}</h4>
      <p className="settlement-step-sub">
        {leg.kind === 'BRIDGE'
          ? `${leg.assetSymbol} → ${destination ?? leg.assetSymbol}`
          : `x402 · exact · ${leg.assetSymbol}`}
      </p>

      <div className="settlement-step-chain">
        {network && <NetworkLogo networkId={network.id} size={16} />}
        <span>{network?.shortLabel ?? leg.network}</span>
        {leg.kind === 'BRIDGE' && destinationChainId !== null && (
          <>
            <ArrowRight size={11} strokeWidth={2} aria-hidden="true" />
            <NetworkChip chainId={destinationChainId} />
          </>
        )}
      </div>

      {leg.amountAtomic && (
        <p className="settlement-step-amount">
          {formatAtomic(leg.amountAtomic, leg.assetDecimals)} <small>{leg.assetSymbol}</small>
        </p>
      )}

      <footer className="settlement-step-foot">
        {leg.provider && <span className="settlement-step-provider">{leg.provider}</span>}
        {leg.transactionHash && chainId !== null && (
          <ExplorerTxLink chainId={chainId} txHash={leg.transactionHash}>
            source tx ↗
          </ExplorerTxLink>
        )}
        {destinationHash && destinationChainId !== null && (
          <ExplorerTxLink chainId={destinationChainId} txHash={destinationHash}>
            arrival tx ↗
          </ExplorerTxLink>
        )}
      </footer>

      {leg.status === 'FAILED' && <RejectionCodes detail={leg.detail} />}
    </article>
  );
}

function NetworkChip({ chainId }: Readonly<{ chainId: number }>) {
  const network = networkByChainId(chainId);
  if (!network) return <span>{`eip155:${chainId}`}</span>;
  return (
    <>
      <NetworkLogo networkId={network.id} size={16} />
      <span>{network.shortLabel}</span>
    </>
  );
}

function StatusPip({ status, inFlight }: Readonly<{ status: SettlementLeg['status']; inFlight: boolean }>) {
  const label = STATUS_LABEL[status];
  return (
    <span className={`settlement-pip settlement-pip--${status.toLowerCase()}`}>
      {status === 'CONFIRMED' && <Check size={11} strokeWidth={3} aria-hidden="true" />}
      {status === 'FAILED' && <X size={11} strokeWidth={3} aria-hidden="true" />}
      {inFlight && <i className="settlement-pip-spinner" aria-hidden="true" />}
      {label}
    </span>
  );
}

const STATUS_LABEL: Readonly<Record<SettlementLeg['status'], string>> = {
  PENDING: 'Working',
  SUBMITTED: 'In flight',
  CONFIRMED: 'Done',
  FAILED: 'Refused',
};

/** A refused payment says exactly what would have to change, rather than just failing. */
function RejectionCodes({ detail }: Readonly<{ detail: SettlementLeg['detail'] }>) {
  const raw = detail?.['rejectionCodes'];
  const codes = Array.isArray(raw) ? raw.filter((code): code is string => typeof code === 'string') : [];
  if (codes.length === 0) return null;
  return (
    <ul className="settlement-step-codes">
      {codes.map((code) => (
        <li key={code}>{REJECTION_COPY[code] ?? code}</li>
      ))}
    </ul>
  );
}

const REJECTION_COPY: Readonly<Record<string, string>> = {
  ASSET_NOT_HELD: 'Priced in a token this run does not hold',
  AMOUNT_ABOVE_CEILING: 'Costs more than this run is allowed to spend',
  NETWORK_NOT_ALLOWED: 'Wants payment on a chain this run is not funded on',
  TRANSFER_METHOD_UNSUPPORTED: 'Uses a signature type this payer cannot produce',
  TRANSFER_METHOD_NOT_ALLOWED: 'Uses a signature type this run does not accept',
  ASSET_DOES_NOT_SUPPORT_EIP3009: 'Offers gasless payment in a token that cannot settle it',
  SCHEME_NOT_EXACT: 'Uses a pricing scheme other than a fixed amount',
  RECIPIENT_NOT_PINNED: 'Would pay a recipient this run has not approved',
};

function chainIdFromCaip2(network: string): number | null {
  const match = /^eip155:(\d+)$/.exec(network);
  return match ? Number(match[1]) : null;
}

function readString(detail: SettlementLeg['detail'], key: string): string | null {
  const value = detail?.[key];
  return typeof value === 'string' ? value : null;
}

function readHash(detail: SettlementLeg['detail'], key: string): `0x${string}` | null {
  const value = detail?.[key];
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : null;
}

/** Atomic units to a readable figure, trimmed of trailing zeros but never rounded up. */
export function formatAtomic(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const divisor = 10n ** BigInt(decimals);
  const whole = BigInt(value) / divisor;
  const fraction = (BigInt(value) % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
