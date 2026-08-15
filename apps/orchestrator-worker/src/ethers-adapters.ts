import { toolReceiptDomain, TOOL_RECEIPT_TYPES, type UnsignedToolReceipt } from '@shipyard402/evidence-sdk';
import { acquireExactEvmPayment } from '@shipyard402/x402-payments';
import {
  Contract,
  type Wallet,
  getAddress,
  type InterfaceAbi,
  type JsonRpcProvider,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';

import {
  ATTESTATION_TYPED_DATA_TYPES,
  attestationTypedDataValue,
  registryDomain,
  RESULT_INDEX,
} from './registry-eip712.js';
import type { RefundSender, RegistryAttestor, RunAttestationInput, ToolReceiptSigner, X402PayerPort } from './ports.js';

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

export class EthersX402Payer implements X402PayerPort {
  readonly payerAddress: `0x${string}`;
  readonly #wallet: Wallet;
  readonly #fetchImpl: typeof fetch;

  constructor(wallet: Wallet, fetchImpl: typeof fetch) {
    this.#wallet = wallet;
    this.#fetchImpl = fetchImpl;
    this.payerAddress = getAddress(wallet.address) as `0x${string}`;
  }

  async acquire(input: Parameters<X402PayerPort['acquire']>[0]) {
    return acquireExactEvmPayment({
      ...input,
      from: this.payerAddress,
      fetchImpl: this.#fetchImpl,
      signTypedData: async (args) =>
        (await this.#wallet.signTypedData(
          args.domain as TypedDataDomain,
          args.types as unknown as Record<string, TypedDataField[]>,
          args.message,
        )) as `0x${string}`,
    });
  }
}

export class EthersErc20RefundSender implements RefundSender {
  readonly #wallet: Wallet;
  readonly #provider: JsonRpcProvider;

  constructor(wallet: Wallet, provider: JsonRpcProvider) {
    this.#wallet = wallet;
    this.#provider = provider;
  }

  async reserveNonce(): Promise<number> {
    return this.#wallet.getNonce('pending');
  }

  async isNonceConsumed(nonce: number): Promise<boolean> {
    return (await this.#provider.getTransactionCount(this.#wallet.address, 'pending')) > nonce;
  }

  async sendRefund(
    input: Readonly<{ tokenAddress: `0x${string}`; toAddress: `0x${string}`; valueAtomic: bigint; nonce: number }>,
  ): Promise<`0x${string}`> {
    if (input.valueAtomic <= 0n) throw new Error('Refund amount must be positive');
    const token = new Contract(getAddress(input.tokenAddress), ERC20_TRANSFER_ABI, this.#wallet);
    const tx = await token['transfer']!(getAddress(input.toAddress), input.valueAtomic, { nonce: input.nonce });
    const receipt = await tx.wait(1);
    if (receipt?.status !== 1) {
      throw new Error(`Refund transaction did not confirm successfully: ${tx.hash}`);
    }
    return receipt.hash as `0x${string}`;
  }
}

export class EthersToolReceiptSigner implements ToolReceiptSigner {
  readonly address: `0x${string}`;
  readonly #wallet: Wallet;

  constructor(wallet: Wallet) {
    this.#wallet = wallet;
    this.address = getAddress(wallet.address) as `0x${string}`;
  }

  async sign(receipt: UnsignedToolReceipt): Promise<`0x${string}`> {
    const signature = await this.#wallet.signTypedData(toolReceiptDomain(receipt.chainId), TOOL_RECEIPT_TYPES, receipt);
    return signature as `0x${string}`;
  }
}

export class EthersRegistryAttestor implements RegistryAttestor {
  readonly address: `0x${string}`;
  readonly registryAddress: `0x${string}`;
  readonly chainId: number;
  readonly #wallet: Wallet;
  readonly #contract: Contract;

  constructor(wallet: Wallet, registryAddress: `0x${string}`, chainId: number, abi: InterfaceAbi) {
    this.#wallet = wallet;
    this.address = getAddress(wallet.address) as `0x${string}`;
    this.registryAddress = getAddress(registryAddress) as `0x${string}`;
    this.chainId = chainId;
    this.#contract = new Contract(this.registryAddress, abi, wallet);
  }

  async submit(attestation: RunAttestationInput): Promise<`0x${string}`> {
    const submitted = await this.#withChainSafeCompletionTime(attestation);
    const signature = await this.#wallet.signTypedData(
      registryDomain(this.chainId, this.registryAddress),
      ATTESTATION_TYPED_DATA_TYPES,
      attestationTypedDataValue(submitted),
    );
    // The contract's `result` field is a Solidity enum (uint8) — the on-chain call needs its
    // numeric index, unlike the EIP-712 signature above which hashes the outcome as a string.
    const callData = { ...submitted, result: RESULT_INDEX[submitted.result] };
    const tx = await this.#contract['recordRun']!(callData, signature);
    const receipt = await tx.wait(1);
    if (receipt?.status !== 1) {
      throw new Error(`Attestation transaction did not confirm successfully: ${tx.hash}`);
    }
    return receipt.hash as `0x${string}`;
  }

  /**
   * The registry rejects `completedAt > block.timestamp`. The run's completion time comes from the
   * orchestrator's wall clock, which sits ahead of the newest block whenever a chain has not
   * produced one in the last second or two -- on a slow block, a perfectly valid attestation
   * reverts with InvalidCompletionTime and burns a retry. Clamping to the chain's own clock keeps
   * the claim truthful (a completion can only be reported as already having happened) and makes
   * the submission deterministic instead of dependent on block timing. `expiresAt` is left alone:
   * lowering `completedAt` only widens the window the contract requires it to satisfy.
   */
  async #withChainSafeCompletionTime(attestation: RunAttestationInput): Promise<RunAttestationInput> {
    const latestBlock = await this.#wallet.provider?.getBlock('latest');
    if (!latestBlock) return attestation;
    return chainSafeCompletionTime(attestation, Number(latestBlock.timestamp));
  }
}

/** Pure half of the clamp above, kept separate so the rule itself is testable without a chain. */
export function chainSafeCompletionTime(
  attestation: RunAttestationInput,
  chainNowSeconds: number,
): RunAttestationInput {
  if (attestation.completedAt <= chainNowSeconds) return attestation;
  return { ...attestation, completedAt: chainNowSeconds };
}
