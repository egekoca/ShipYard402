export type AssetId = Readonly<{
  chainId: number;
  tokenAddress: `0x${string}`;
  decimals: number;
}>;

export type Money = Readonly<{
  asset: AssetId;
  atomicAmount: string;
}>;

export function parseAtomicAmount(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Atomic amount must be an unsigned base-10 integer string');
  }
  return BigInt(value);
}
export function assertSameAsset(left: AssetId, right: AssetId): void {
  if (
    left.chainId !== right.chainId ||
    left.tokenAddress.toLowerCase() !== right.tokenAddress.toLowerCase() ||
    left.decimals !== right.decimals
  ) {
    throw new Error('Cannot aggregate amounts from different assets');
  }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameAsset(left.asset, right.asset);
  return {
    asset: left.asset,
    atomicAmount: (parseAtomicAmount(left.atomicAmount) + parseAtomicAmount(right.atomicAmount)).toString(),
  };
}
