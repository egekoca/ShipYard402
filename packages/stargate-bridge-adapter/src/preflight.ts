/**
 * Pure go/no-go evaluation for a cross-chain USDC run, kept separate from all I/O so the decision
 * logic is unit-testable and the gathering script stays a thin shell. Nothing here moves funds or
 * touches a chain; it only judges facts a read-only preflight already collected.
 */

export type PreflightStatus = 'pass' | 'fail' | 'warn' | 'skip';

export type PreflightCheck = Readonly<{
  name: string;
  status: PreflightStatus;
  detail: string;
}>;

export type PreflightFacts = Readonly<{
  /** On-chain liveness of the two Stargate USDC pools, and whether each pool's token() is the USDC we expect. */
  route: Readonly<{
    sourcePoolLive: boolean;
    sourceTokenMatches: boolean;
    destinationPoolLive: boolean;
    destinationTokenMatches: boolean;
  }>;
  /** The GOAT wallet that funds and signs the bridge. */
  goat: Readonly<{
    signerAddress: string;
    usdcBalanceAtomic: string;
    nativeGasWei: string;
  }>;
  /** How much USDC the run intends to bridge (atomic, 6 decimals). */
  bridgeAmountAtomic: string;
  /** Conservative floor for GOAT native (BTC) gas; below it, warn -- the exact LayerZero fee is quoted at send time. */
  minGoatGasWei: string;
  /** The BNB destination side. `configured: false` means cross-chain env is absent -- everything BNB is skipped. */
  bnb: Readonly<{
    configured: boolean;
    payerAddress?: string;
    nativeGasWei?: string;
    minGasWei?: string;
    endpointReachable?: boolean;
    endpointStatus?: number;
    targetAmountAtomic?: string;
    maxTargetAmountAtomic?: string;
  }>;
}>;

export type PreflightReport = Readonly<{
  ok: boolean;
  checks: readonly PreflightCheck[];
}>;

function gte(a: string, b: string): boolean {
  return BigInt(a) >= BigInt(b);
}

/**
 * Judges whether a controlled real cross-chain run is safe to attempt. `ok` is true only when no
 * check failed; warnings (e.g. thin gas) do not block, because the actual fee is quoted on-chain at
 * send time and the send itself fails closed if it is short.
 */
export function evaluateCrossChainPreflight(facts: PreflightFacts): PreflightReport {
  const checks: PreflightCheck[] = [];

  checks.push({
    name: 'Stargate source USDC pool (GOAT)',
    status: facts.route.sourcePoolLive && facts.route.sourceTokenMatches ? 'pass' : 'fail',
    detail: !facts.route.sourcePoolLive
      ? 'GOAT USDC pool has no code at the pinned address'
      : facts.route.sourceTokenMatches
        ? 'live, token() is the expected USDC'
        : 'pool is live but token() is NOT the expected USDC -- route address drift',
  });

  checks.push({
    name: 'Stargate destination USDC pool (BNB)',
    status: facts.route.destinationPoolLive && facts.route.destinationTokenMatches ? 'pass' : 'fail',
    detail: !facts.route.destinationPoolLive
      ? 'BNB USDC pool has no code at the pinned address'
      : facts.route.destinationTokenMatches
        ? 'live, token() is the expected USDC'
        : 'pool is live but token() is NOT the expected USDC -- route address drift',
  });

  checks.push({
    name: 'GOAT signer USDC balance covers the bridge amount',
    status: gte(facts.goat.usdcBalanceAtomic, facts.bridgeAmountAtomic) ? 'pass' : 'fail',
    detail: `${facts.goat.signerAddress}: has ${facts.goat.usdcBalanceAtomic}, needs ${facts.bridgeAmountAtomic} (atomic USDC)`,
  });

  checks.push({
    name: 'GOAT signer native (BTC) gas',
    status: gte(facts.goat.nativeGasWei, facts.minGoatGasWei) ? 'pass' : 'warn',
    detail: gte(facts.goat.nativeGasWei, facts.minGoatGasWei)
      ? `${facts.goat.nativeGasWei} wei, above the ${facts.minGoatGasWei} floor`
      : `${facts.goat.nativeGasWei} wei is below the ${facts.minGoatGasWei} floor -- the LayerZero fee is quoted at send time and may not be covered`,
  });

  if (!facts.bnb.configured) {
    checks.push({
      name: 'BNB destination side',
      status: 'skip',
      detail: 'cross-chain env (BNB_*, CROSS_CHAIN_PROCUREMENT_MODE, amounts) is not configured -- BNB checks skipped',
    });
    return finalize(checks);
  }

  if (facts.bnb.nativeGasWei !== undefined && facts.bnb.minGasWei !== undefined) {
    checks.push({
      name: 'BNB payer native (BNB) gas',
      status: gte(facts.bnb.nativeGasWei, facts.bnb.minGasWei) ? 'pass' : 'warn',
      detail: `${facts.bnb.payerAddress ?? 'payer'}: ${facts.bnb.nativeGasWei} wei vs ${facts.bnb.minGasWei} floor (permit2 approval + pay)`,
    });
  }

  if (facts.bnb.endpointReachable !== undefined) {
    checks.push({
      name: 'BNB x402 target answers a 402 challenge',
      status: facts.bnb.endpointReachable && facts.bnb.endpointStatus === 402 ? 'pass' : 'fail',
      detail: facts.bnb.endpointReachable
        ? `endpoint responded HTTP ${facts.bnb.endpointStatus} (expected 402)`
        : 'endpoint was unreachable',
    });
  }

  if (facts.bnb.targetAmountAtomic !== undefined && facts.bnb.maxTargetAmountAtomic !== undefined) {
    checks.push({
      name: 'BNB target payment within its ceiling',
      status: gte(facts.bnb.maxTargetAmountAtomic, facts.bnb.targetAmountAtomic) ? 'pass' : 'fail',
      detail: `pays ${facts.bnb.targetAmountAtomic}, ceiling ${facts.bnb.maxTargetAmountAtomic} (atomic)`,
    });
  }

  return finalize(checks);
}

function finalize(checks: readonly PreflightCheck[]): PreflightReport {
  return { ok: !checks.some((check) => check.status === 'fail'), checks };
}
