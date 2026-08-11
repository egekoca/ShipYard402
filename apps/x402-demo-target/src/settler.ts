import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { settlementArgs, type ExactEvmPayload } from '@shipyard402/x402-payments';

/**
 * Submits a verified x402 payment on-chain. This is the settlement leg the resource server relies
 * on: `verifyExactEvmPayment` proves the signature and terms are good, `settle` actually moves the
 * tokens by calling `transferWithAuthorization` on the EIP-3009 asset. The token consumes the
 * authorization nonce on success, so a replayed payment's settlement reverts here.
 */
export interface X402Settler {
  settle(payload: ExactEvmPayload, signal?: AbortSignal): Promise<Readonly<{ transactionHash: `0x${string}` }>>;
}

export type SettlementFailureCode = 'ALREADY_SETTLED' | 'SETTLEMENT_REVERTED' | 'SETTLEMENT_UNAVAILABLE';

/**
 * A settlement that did not move funds. `ALREADY_SETTLED` specifically means the token rejected the
 * authorization as already used -- the on-chain replay guard firing -- which the server maps to a
 * distinct 409 so a replayed payment reads differently from a merely broken one.
 */
export class SettlementError extends Error {
  readonly code: SettlementFailureCode;

  constructor(code: SettlementFailureCode, message: string) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  // The token's custom errors must be in this ABI or viem cannot decode a revert's name -- and
  // without the name, an already-used authorization (the replay signal) is indistinguishable from
  // any other revert. Keep these in sync with ShipyardTestToken.
  { type: 'error', name: 'AuthorizationAlreadyUsed', inputs: [] },
  { type: 'error', name: 'AuthorizationNotYetValid', inputs: [] },
  { type: 'error', name: 'AuthorizationExpired', inputs: [] },
  { type: 'error', name: 'InvalidAuthorizationSignature', inputs: [] },
] as const;

export type ViemSettlerDependencies = Readonly<{
  publicClient: PublicClient;
  walletClient: WalletClient;
  settlerAccount: Account;
  chain: Chain;
  tokenAddress: `0x${string}`;
}>;

/**
 * The real settler: simulates the call first so a would-be revert (an already-used nonce, an
 * insufficient payer balance) is classified into a `SettlementError` instead of a raw send failure,
 * then submits and waits for the receipt. Simulating before sending also means the server never
 * burns gas broadcasting a transfer the token would reject.
 */
export function createViemSettler(deps: ViemSettlerDependencies): X402Settler {
  return {
    async settle(payload): Promise<Readonly<{ transactionHash: `0x${string}` }>> {
      const args = settlementArgs(payload);
      const callArgs = [
        args.from,
        args.to,
        args.value,
        args.validAfter,
        args.validBefore,
        args.nonce,
        args.signature,
      ] as const;

      try {
        await deps.publicClient.simulateContract({
          address: deps.tokenAddress,
          abi: TRANSFER_WITH_AUTHORIZATION_ABI,
          functionName: 'transferWithAuthorization',
          args: callArgs,
          account: deps.settlerAccount,
        });
      } catch (error) {
        throw classifySettlementError(error);
      }

      const hash = await deps.walletClient.writeContract({
        address: deps.tokenAddress,
        abi: TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: 'transferWithAuthorization',
        args: callArgs,
        account: deps.settlerAccount,
        chain: deps.chain,
      });
      const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new SettlementError('SETTLEMENT_REVERTED', `Settlement transaction ${hash} reverted`);
      }
      return { transactionHash: hash };
    },
  };
}

/**
 * Maps a viem revert to a settlement failure code. The token's `AuthorizationAlreadyUsed()` custom
 * error is the replay signal; anything else is a generic revert. We match on the error name because
 * the demo token's ABI is compiled separately from this call's minimal ABI, so the decoded name is
 * the stable contract, not a selector we would have to keep in sync by hand.
 */
function classifySettlementError(error: unknown): SettlementError {
  if (error instanceof BaseError) {
    const revert = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name === 'AuthorizationAlreadyUsed') {
        return new SettlementError('ALREADY_SETTLED', 'Payment authorization was already settled');
      }
      return new SettlementError('SETTLEMENT_REVERTED', `Settlement reverted: ${name ?? revert.shortMessage}`);
    }
  }
  return new SettlementError('SETTLEMENT_UNAVAILABLE', 'Settlement could not be submitted');
}
