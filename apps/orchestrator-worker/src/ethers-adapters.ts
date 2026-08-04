import { toolReceiptDomain, TOOL_RECEIPT_TYPES, type UnsignedToolReceipt } from '@shipyard402/evidence-sdk';
import { Contract, Wallet, getAddress, type InterfaceAbi, type JsonRpcProvider } from 'ethers';

import { ATTESTATION_TYPED_DATA_TYPES, attestationTypedDataValue, registryDomain } from './registry-eip712.js';
import type { ConfirmedPayment, NativePaymentSender, RegistryAttestor, RunAttestationInput, ToolReceiptSigner } from './ports.js';

export class EthersNativePaymentSender implements NativePaymentSender {
  readonly #wallet: Wallet;
  readonly #provider: JsonRpcProvider;
  readonly #maximumValueWei: bigint;

  constructor(wallet: Wallet, provider: JsonRpcProvider, maximumValueWei: bigint) {
    this.#wallet = wallet;
    this.#provider = provider;
    this.#maximumValueWei = maximumValueWei;
  }

  async sendPayment(input: Readonly<{ toAddress: `0x${string}`; valueWei: bigint }>): Promise<`0x${string}`> {
    if (input.valueWei <= 0n || input.valueWei > this.#maximumValueWei) {
      throw new Error('Procurement payment amount is outside the configured safety bound');
    }
    const feeData = await this.#provider.getFeeData();
    const transaction = await this.#wallet.sendTransaction({
      to: input.toAddress,
      value: input.valueWei,
      ...(feeData.maxFeePerGas ? { maxFeePerGas: feeData.maxFeePerGas } : {}),
      ...(feeData.maxPriorityFeePerGas ? { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas } : {}),
    });
    return transaction.hash as `0x${string}`;
  }

  async waitForConfirmation(transactionHash: `0x${string}`, minimumConfirmations: number): Promise<ConfirmedPayment> {
    const receipt = await this.#provider.waitForTransaction(transactionHash, minimumConfirmations, 180_000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Procurement payment transaction did not confirm successfully: ${transactionHash}`);
    }
    const currentBlock = await this.#provider.getBlockNumber();
    return { transactionHash, confirmations: currentBlock - receipt.blockNumber + 1 };
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
    const tx = await this.#contract['recordRun']!(attestation, signature);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Attestation transaction did not confirm successfully: ${tx.hash}`);
    }
    return receipt.hash as `0x${string}`;
  }
}
