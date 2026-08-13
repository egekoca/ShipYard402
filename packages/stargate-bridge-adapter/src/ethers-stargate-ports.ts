import { Contract, getAddress, id, zeroPadValue, type JsonRpcProvider, type Signer } from 'ethers';

import type { EvmAddress, TransactionHash } from '@shipyard402/x402-payments';

import type { DestinationReceiptPort, StargateSendParameters, StargateSourceChainPort } from './ports.js';
import { GOAT_TO_BNB_USDT_STARGATE_ROUTE, type StargateRoute } from './route.js';

const OFT_ABI = [
  'function token() view returns (address)',
  'function approvalRequired() view returns (bool)',
  'function sharedDecimals() view returns (uint8)',
  'function quoteOFT((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam) view returns ((uint256 minAmountLD,uint256 maxAmountLD) oftLimit,(int256 feeAmount,string description)[] oftFeeDetails,(uint256 amountSentLD,uint256 amountReceivedLD) oftReceipt)',
  'function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam,bool payInLzToken) view returns ((uint256 nativeFee,uint256 lzTokenFee) fee)',
  'function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam,(uint256 nativeFee,uint256 lzTokenFee) fee,address refundAddress) payable returns ((bytes32 guid,uint64 nonce) msgReceipt,(uint256 amountSentLD,uint256 amountReceivedLD) oftReceipt)',
] as const;

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
] as const;

type OftReceiptResult = Readonly<{ amountSentLD: bigint; amountReceivedLD: bigint }>;
type MessagingFeeResult = Readonly<{ nativeFee: bigint; lzTokenFee: bigint }>;

export class EthersStargateSourceChainPort implements StargateSourceChainPort {
  readonly #signer: Signer;
  readonly #route: StargateRoute;
  readonly #oft: Contract;
  readonly #token: Contract;
  #verified: Promise<void> | undefined;

  constructor(input: Readonly<{ signer: Signer; route?: StargateRoute }>) {
    if (!input.signer.provider) throw new Error('Stargate source signer must have a provider');
    this.#signer = input.signer;
    this.#route = input.route ?? GOAT_TO_BNB_USDT_STARGATE_ROUTE;
    this.#oft = new Contract(this.#route.sourceOftAddress, OFT_ABI, input.signer);
    this.#token = new Contract(this.#route.sourceAsset.tokenAddress, ERC20_ABI, input.signer);
  }

  async quoteOft(
    input: StargateSendParameters,
    signal?: AbortSignal,
  ): Promise<Readonly<{ amountSentAtomic: string; amountReceivedAtomic: string }>> {
    await this.#verify(signal);
    const result = (await this.#oft.getFunction('quoteOFT').staticCall(toSendParam(input))) as readonly [
      unknown,
      unknown,
      OftReceiptResult,
    ];
    throwIfAborted(signal);
    return {
      amountSentAtomic: result[2].amountSentLD.toString(),
      amountReceivedAtomic: result[2].amountReceivedLD.toString(),
    };
  }

  async quoteSend(input: StargateSendParameters, signal?: AbortSignal): Promise<Readonly<{ nativeFeeWei: string }>> {
    await this.#verify(signal);
    const fee = (await this.#oft.getFunction('quoteSend').staticCall(toSendParam(input), false)) as MessagingFeeResult;
    throwIfAborted(signal);
    if (fee.lzTokenFee !== 0n) throw new Error('Reviewed Stargate route unexpectedly requires an LZ token fee');
    return { nativeFeeWei: fee.nativeFee.toString() };
  }

  async ensureTokenAllowance(amountAtomic: string, signal?: AbortSignal): Promise<void> {
    await this.#verify(signal);
    const owner = await this.#signer.getAddress();
    const current = (await this.#token
      .getFunction('allowance')
      .staticCall(owner, this.#route.sourceOftAddress)) as bigint;
    if (current >= BigInt(amountAtomic)) return;
    throwIfAborted(signal);
    if (current !== 0n) {
      const reset = await this.#token.getFunction('approve').send(this.#route.sourceOftAddress, 0n);
      await reset.wait();
    }
    throwIfAborted(signal);
    const approval = await this.#token.getFunction('approve').send(this.#route.sourceOftAddress, BigInt(amountAtomic));
    const receipt = await approval.wait();
    if (receipt?.status !== 1) throw new Error('GOAT USDT approval transaction failed');
  }

  async send(
    input: StargateSendParameters & Readonly<{ nativeFeeWei: string }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ transactionHash: TransactionHash }>> {
    await this.#verify(signal);
    throwIfAborted(signal);
    const refundAddress = await this.#signer.getAddress();
    const transaction = await this.#oft
      .getFunction('send')
      .send(toSendParam(input), { nativeFee: BigInt(input.nativeFeeWei), lzTokenFee: 0n }, refundAddress, {
        value: BigInt(input.nativeFeeWei),
      });
    return { transactionHash: transaction.hash as TransactionHash };
  }

  async #verify(signal?: AbortSignal): Promise<void> {
    this.#verified ??= this.#verifyConfiguration(signal).catch((error: unknown) => {
      this.#verified = undefined;
      throw error;
    });
    return this.#verified;
  }

  async #verifyConfiguration(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const provider = this.#signer.provider;
    if (!provider) throw new Error('Stargate source signer lost its provider');
    const [network, tokenAddress, approvalRequired, sharedDecimals, tokenDecimals] = await Promise.all([
      provider.getNetwork(),
      this.#oft.getFunction('token').staticCall() as Promise<string>,
      this.#oft.getFunction('approvalRequired').staticCall() as Promise<boolean>,
      this.#oft.getFunction('sharedDecimals').staticCall() as Promise<bigint>,
      this.#token.getFunction('decimals').staticCall() as Promise<bigint>,
    ]);
    throwIfAborted(signal);
    if (network.chainId !== 2345n)
      throw new Error(`Stargate source provider is on unexpected chain ${network.chainId}`);
    if (getAddress(tokenAddress) !== getAddress(this.#route.sourceAsset.tokenAddress)) {
      throw new Error('GOAT Stargate OFT does not point to the reviewed USDT token');
    }
    if (!approvalRequired) throw new Error('GOAT Stargate OFT approval behavior changed');
    if (sharedDecimals !== 6n || tokenDecimals !== BigInt(this.#route.sourceAsset.decimals)) {
      throw new Error('GOAT Stargate USDT decimals do not match the reviewed route');
    }
  }
}

export class EthersDestinationReceiptPort implements DestinationReceiptPort {
  readonly #provider: JsonRpcProvider;
  readonly #expectedChainId: bigint;
  #verified: Promise<void> | undefined;

  constructor(input: Readonly<{ provider: JsonRpcProvider; expectedChainId?: bigint }>) {
    this.#provider = input.provider;
    this.#expectedChainId = input.expectedChainId ?? 56n;
  }

  async getTokenAmountReceived(
    input: Readonly<{
      transactionHash: TransactionHash;
      tokenAddress: EvmAddress;
      recipientAddress: EvmAddress;
    }>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    await this.#verify(signal);
    const receipt = await this.#provider.getTransactionReceipt(input.transactionHash);
    throwIfAborted(signal);
    if (!receipt) return null;
    if (receipt.status !== 1) return '0';
    const tokenAddress = getAddress(input.tokenAddress);
    const recipientAddress = getAddress(input.recipientAddress);
    let total = 0n;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== tokenAddress || log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3)
        continue;
      const recipientTopic = log.topics[2];
      if (!recipientTopic) continue;
      const recipient = getAddress(`0x${recipientTopic.slice(-40)}`);
      if (recipient !== recipientAddress) continue;
      total += BigInt(log.data);
    }
    return total.toString();
  }

  async #verify(signal?: AbortSignal): Promise<void> {
    this.#verified ??= this.#provider.getNetwork().then((network) => {
      throwIfAborted(signal);
      if (network.chainId !== this.#expectedChainId) {
        throw new Error(`Destination receipt provider is on unexpected chain ${network.chainId}`);
      }
    });
    return this.#verified;
  }
}

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');

function toSendParam(input: StargateSendParameters): Readonly<Record<string, string | number>> {
  return {
    dstEid: input.destinationEndpointId,
    to: zeroPadValue(getAddress(input.destinationRecipient), 32),
    amountLD: input.amountInAtomic,
    minAmountLD: input.minimumAmountOutAtomic,
    extraOptions: '0x',
    composeMsg: '0x',
    oftCmd: '0x',
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
