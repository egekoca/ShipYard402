import { toolReceiptDomain, TOOL_RECEIPT_TYPES, type UnsignedToolReceipt } from '@shipyard402/evidence-sdk';
import { Contract, type Wallet, getAddress, type InterfaceAbi, type JsonRpcProvider } from 'ethers';

import {
  ATTESTATION_TYPED_DATA_TYPES,
  attestationTypedDataValue,
  registryDomain,
  RESULT_INDEX,
} from './registry-eip712.js';
import type {
  ConfirmedPayment,
  NativePaymentSender,
  RefundSender,
  RegistryAttestor,
  RunAttestationInput,
  ToolReceiptSigner,
} from './ports.js';

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

export class EthersNativePaymentSender implements NativePaymentSender {
  readonly #wallet: Wallet;
  readonly #provider: JsonRpcProvider;
  readonly #maximumValueWei: bigint;

  constructor(wallet: Wallet, provider: JsonRpcProvider, maximumValueWei: bigint) {
    this.#wallet = wallet;
    this.#provider = provider;
    this.#maximumValueWei = maximumValueWei;
  }

  async reserveNonce(): Promise<number> {
    return this.#wallet.getNonce('pending');
  }

  async isNonceConsumed(nonce: number): Promise<boolean> {
    return (await this.#provider.getTransactionCount(this.#wallet.address, 'pending')) > nonce;
  }

  async sendPayment(
    input: Readonly<{ toAddress: `0x${string}`; valueWei: bigint; nonce: number }>,
  ): Promise<`0x${string}`> {
    if (input.valueWei <= 0n || input.valueWei > this.#maximumValueWei) {
      throw new Error('Procurement payment amount is outside the configured safety bound');
    }
    const feeData = await this.#provider.getFeeData();
    const transaction = await this.#wallet.sendTransaction({
      to: input.toAddress,
      value: input.valueWei,
      nonce: input.nonce,
      ...(feeData.maxFeePerGas ? { maxFeePerGas: feeData.maxFeePerGas } : {}),
      ...(feeData.maxPriorityFeePerGas ? { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas } : {}),
    });
    return transaction.hash as `0x${string}`;
  }

  async waitForConfirmation(transactionHash: `0x${string}`, minimumConfirmations: number): Promise<ConfirmedPayment> {
    const receipt = await this.#provider.waitForTransaction(transactionHash, minimumConfirmations, 180_000);
    if (receipt?.status !== 1) {
      throw new Error(`Procurement payment transaction did not confirm successfully: ${transactionHash}`);
    }
    const currentBlock = await this.#provider.getBlockNumber();
    return { transactionHash, confirmations: currentBlock - receipt.blockNumber + 1 };
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
    const signature = await this.#wallet.signTypedData(
      registryDomain(this.chainId, this.registryAddress),
      ATTESTATION_TYPED_DATA_TYPES,
      attestationTypedDataValue(attestation),
    );
    // The contract's `result` field is a Solidity enum (uint8) — the on-chain call needs its
    // numeric index, unlike the EIP-712 signature above which hashes the outcome as a string.
    const callData = { ...attestation, result: RESULT_INDEX[attestation.result] };
    const tx = await this.#contract['recordRun']!(callData, signature);
    const receipt = await tx.wait(1);
    if (receipt?.status !== 1) {
      throw new Error(`Attestation transaction did not confirm successfully: ${tx.hash}`);
    }
    return receipt.hash as `0x${string}`;
  }
}
