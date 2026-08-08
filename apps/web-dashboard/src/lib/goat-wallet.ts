/**
 * Talks directly to the browser's injected wallet (MetaMask and most other extensions expose
 * window.ethereum per EIP-1193) so a customer can pay an x402 challenge without ever handing a
 * private key to this frontend -- signing happens entirely inside the user's own wallet. Chain
 * identities are duplicated from packages/goat-network-config rather than imported: web-dashboard
 * has no workspace dependency beyond the public API client, and this keeps it that way.
 */

export type EthereumProvider = Readonly<{
  request: (args: Readonly<{ method: string; params?: readonly unknown[] }>) => Promise<unknown>;
}>;

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export type GoatChainConfig = Readonly<{
  chainIdHex: `0x${string}`;
  chainName: string;
  nativeCurrency: Readonly<{ name: string; symbol: string; decimals: number }>;
  rpcUrls: readonly string[];
  blockExplorerUrls: readonly string[];
}>;

/** The only chain this app targets while GOAT Flow Mainnet merchant onboarding is still pending. */
export const GOAT_TESTNET3_CHAIN_ID = 48816;

export const GOAT_CHAINS: Readonly<Record<number, GoatChainConfig>> = {
  2345: {
    chainIdHex: '0x929',
    chainName: 'GOAT Network',
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
    rpcUrls: ['https://rpc.goat.network'],
    blockExplorerUrls: ['https://explorer.goat.network'],
  },
  48816: {
    chainIdHex: '0xbeb0',
    chainName: 'GOAT Testnet3',
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
    rpcUrls: ['https://rpc.testnet3.goat.network'],
    blockExplorerUrls: ['https://explorer.testnet3.goat.network'],
  },
};

export function isWalletAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

function getProvider(): EthereumProvider {
  if (!isWalletAvailable()) throw new Error('No browser wallet extension was detected.');
  return window.ethereum!;
}

export async function connectWallet(): Promise<`0x${string}`> {
  const accounts = (await getProvider().request({ method: 'eth_requestAccounts' })) as readonly string[];
  const address = accounts[0];
  if (!address) throw new Error('The wallet did not return an account.');
  return address as `0x${string}`;
}

/** eth_accounts never prompts -- it just reports whether this site already has standing
 * permission from a previous connectWallet() call. Used to restore the connected address after a
 * full page navigation (e.g. back from a run's detail page) without asking the customer to
 * reconnect a wallet that was never actually disconnected. */
export async function getAuthorizedAccount(): Promise<`0x${string}` | null> {
  if (!isWalletAvailable()) return null;
  const accounts = (await getProvider().request({ method: 'eth_accounts' })) as readonly string[];
  return (accounts[0] as `0x${string}` | undefined) ?? null;
}

export async function ensureChain(chainId: number): Promise<void> {
  const config = GOAT_CHAINS[chainId];
  if (!config) throw new Error(`Unrecognized GOAT chain id: ${chainId}`);
  const provider = getProvider();
  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  if (current.toLowerCase() === config.chainIdHex.toLowerCase()) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chainIdHex }] });
  } catch (error) {
    if ((error as Readonly<{ code?: number }> | null)?.code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: config.chainIdHex,
          chainName: config.chainName,
          nativeCurrency: config.nativeCurrency,
          rpcUrls: config.rpcUrls,
          blockExplorerUrls: config.blockExplorerUrls,
        },
      ],
    });
  }
}

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ERC20_TRANSFER_SELECTOR = 'a9059cbb'; // keccak256("transfer(address,uint256)")[:4], a fixed public constant

export function encodeErc20Transfer(to: string, amountAtomic: string): `0x${string}` {
  if (!ADDRESS_PATTERN.test(to)) throw new Error('Invalid ERC-20 recipient address');
  const paddedTo = to.toLowerCase().slice(2).padStart(64, '0');
  const paddedAmount = BigInt(amountAtomic).toString(16).padStart(64, '0');
  return `0x${ERC20_TRANSFER_SELECTOR}${paddedTo}${paddedAmount}`;
}

export async function sendErc20Payment(
  input: Readonly<{
    fromAddress: `0x${string}`;
    tokenAddress: string;
    toAddress: string;
    amountAtomic: string;
  }>,
): Promise<`0x${string}`> {
  if (!ADDRESS_PATTERN.test(input.tokenAddress)) throw new Error('Invalid token address');
  const data = encodeErc20Transfer(input.toAddress, input.amountAtomic);
  const txHash = (await getProvider().request({
    method: 'eth_sendTransaction',
    params: [{ from: input.fromAddress, to: input.tokenAddress, data }],
  })) as string;
  return txHash as `0x${string}`;
}

function toHexMessage(message: string): `0x${string}` {
  const bytes = new TextEncoder().encode(message);
  return `0x${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** personal_sign, used once after connecting to prove control of the address before the API
 * gateway will issue a session token (see ../lib/session.ts). */
export async function signPersonalMessage(address: `0x${string}`, message: string): Promise<`0x${string}`> {
  const signature = (await getProvider().request({
    method: 'personal_sign',
    params: [toHexMessage(message), address],
  })) as string;
  return signature as `0x${string}`;
}

export function formatWalletError(error: unknown): string {
  const code = (error as Readonly<{ code?: number }> | null)?.code;
  if (code === 4001) return 'Rejected in wallet.';
  if (error instanceof Error) return error.message;
  return 'Unexpected wallet error';
}
