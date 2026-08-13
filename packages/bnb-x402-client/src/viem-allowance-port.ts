import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { BNB_MAINNET_CHAIN_ID, PERMIT2_ADDRESS } from './constants.js';
import { getAddress } from 'viem';
import type { BnbPermit2AllowancePort } from './ports.js';

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
]);

export function createViemBnbPermit2AllowancePort(
  input: Readonly<{
    rpcUrl: string;
    payerPrivateKey: `0x${string}`;
    maxApprovalGasCostWei: string;
  }>,
): BnbPermit2AllowancePort {
  if (!/^[1-9]\d*$/.test(input.maxApprovalGasCostWei)) {
    throw new Error('maxApprovalGasCostWei must be a positive integer');
  }
  const maxApprovalGasCostWei = BigInt(input.maxApprovalGasCostWei);
  const chain = defineChain({
    id: BNB_MAINNET_CHAIN_ID,
    name: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  const account = privateKeyToAccount(input.payerPrivateKey);
  const transport = http(input.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  return {
    async ensureExactAllowance({ amountAtomic, asset: rawAsset }, signal) {
      if (!/^[1-9]\d*$/.test(amountAtomic)) throw new Error('Permit2 allowance amount must be positive');
      // Checksummed here rather than trusted: this address decides which token gets approved.
      const asset = getAddress(rawAsset);
      throwIfAborted(signal);
      const [networkChainId, balance, allowance, nativeBalance, gasPrice] = await Promise.all([
        publicClient.getChainId(),
        publicClient.readContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account.address],
        }),
        publicClient.readContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [account.address, PERMIT2_ADDRESS],
        }),
        publicClient.getBalance({ address: account.address }),
        publicClient.getGasPrice(),
      ]);
      if (networkChainId !== BNB_MAINNET_CHAIN_ID)
        throw new Error(`Permit2 provider is on unexpected chain ${networkChainId}`);
      if (balance < BigInt(amountAtomic)) throw new Error('BNB payer token balance cannot cover the x402 payment');
      if (allowance === BigInt(amountAtomic)) return;

      const transactionCount = allowance === 0n ? 1n : 2n;
      const conservativeGas = 100_000n * transactionCount;
      const gasCost = conservativeGas * gasPrice;
      if (gasCost > maxApprovalGasCostWei) throw new Error('Permit2 approval gas exceeds its safety ceiling');
      if (nativeBalance < gasCost)
        throw new Error('BNB payer does not have enough BNB for the bounded Permit2 approval');
      throwIfAborted(signal);
      if (allowance !== 0n) await approveAndWait(asset, 0n);
      throwIfAborted(signal);
      await approveAndWait(asset, BigInt(amountAtomic));
    },
  };

  async function approveAndWait(asset: `0x${string}`, amount: bigint): Promise<void> {
    const hash = await walletClient.writeContract({
      account,
      chain,
      address: asset,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, amount],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`BNB token Permit2 approval ${hash} failed`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
