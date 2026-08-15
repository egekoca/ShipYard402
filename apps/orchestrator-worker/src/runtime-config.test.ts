import { BOT_CHAIN_TESTNET } from '@shipyard402/bot-chain-network-config';
import { GOAT_MAINNET, GOAT_TESTNET3 } from '@shipyard402/goat-network-config';
import { Wallet } from 'ethers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrchestratorConfigurationError, parseOrchestratorWorkerRuntimeConfig } from './runtime-config.js';

const rawKey = `0x${'11'.repeat(32)}`;
const keystorePassword = 'a-real-passphrase-not-in-source-control';
let keystoreDir: string;
let keystorePath: string;
let keystoreWalletAddress: string;

beforeAll(async () => {
  keystoreDir = mkdtempSync(join(tmpdir(), 'shipyard-runtime-config-test-'));
  keystorePath = join(keystoreDir, 'signer.json');
  const wallet = new Wallet(rawKey);
  keystoreWalletAddress = wallet.address;
  const json = await wallet.encrypt(keystorePassword);
  writeFileSync(keystorePath, json, 'utf8');
});

afterAll(() => {
  rmSync(keystoreDir, { recursive: true, force: true });
});

const baseEnvironment = {
  ORCHESTRATOR_MAX_PROCUREMENT_SPEND_ATOMIC: '1000000',
  SHIPYARD_RUN_REGISTRY_ADDRESS: '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd',
  SHIPYARD_AGENT_ID: 'shipyard:orchestrator',
  ORCHESTRATOR_PROCUREMENT_ALLOWED_ASSETS: '0x5000000000000000000000000000000000000005',
  DEMO_TARGET_TOOL_AGENT_ID: 'agent:demo-target',
  IPFS_API_URL: 'http://127.0.0.1:5001',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_MODEL: 'gpt-5.1',
  GOAT_TESTNET_RPC_URL: GOAT_TESTNET3.publicRpcUrl,
} satisfies NodeJS.ProcessEnv;

function withSigner(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    ORCHESTRATOR_SIGNER_PRIVATE_KEY: rawKey,
    ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY: rawKey,
    ...overrides,
  };
}

describe('orchestrator worker signer key source configuration', () => {
  it('accepts a raw private key outside production', () => {
    const config = parseOrchestratorWorkerRuntimeConfig(withSigner());
    expect(config.signerKeySource.kind).toBe('raw-env');
    expect(config.toolReceiptSignerKeySource.kind).toBe('raw-env');
  });

  it('requires either a raw key or an encrypted keystore', () => {
    expect(() =>
      parseOrchestratorWorkerRuntimeConfig({
        ...baseEnvironment,
        ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY: rawKey,
      }),
    ).toThrowError(OrchestratorConfigurationError);
  });

  it('refuses a raw key and a keystore configured at the same time', () => {
    expect(() =>
      parseOrchestratorWorkerRuntimeConfig(
        withSigner({
          ORCHESTRATOR_SIGNER_KEYSTORE_PATH: keystorePath,
          ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD: keystorePassword,
        }),
      ),
    ).toThrowError(/either a raw private key or an encrypted keystore, not both/);
  });

  it('requires both a keystore path and password, not just one', () => {
    expect(() =>
      parseOrchestratorWorkerRuntimeConfig({
        ...baseEnvironment,
        ORCHESTRATOR_SIGNER_KEYSTORE_PATH: keystorePath,
        ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY: rawKey,
      }),
    ).toThrowError(/requires both a path and a password/);
  });

  it('refuses a raw private key in production', () => {
    expect(() =>
      parseOrchestratorWorkerRuntimeConfig(
        withSigner({ APP_ENV: 'production', DATABASE_URL: 'postgresql://database.example/shipyard' }),
      ),
    ).toThrowError(/production must use an encrypted keystore/);
  });

  it('loads a real encrypted keystore and decrypts it to the original signer address, including in production', async () => {
    const config = parseOrchestratorWorkerRuntimeConfig({
      ...baseEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://database.example/shipyard',
      ORCHESTRATOR_SIGNER_KEYSTORE_PATH: keystorePath,
      ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD: keystorePassword,
      ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PATH: keystorePath,
      ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PASSWORD: keystorePassword,
    });
    expect(config.signerKeySource.kind).toBe('encrypted-keystore');
    const wallet = await config.signerKeySource.loadWallet({ getFeeData: async () => ({}) } as never);
    expect(wallet.address).toBe(keystoreWalletAddress);
  });

  it('rejects a keystore path that does not exist', () => {
    expect(() =>
      parseOrchestratorWorkerRuntimeConfig(
        withSigner({
          ORCHESTRATOR_SIGNER_PRIVATE_KEY: undefined as unknown as string,
          ORCHESTRATOR_SIGNER_KEYSTORE_PATH: join(keystoreDir, 'does-not-exist.json'),
          ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD: keystorePassword,
        }),
      ),
    ).toThrowError(/could not read the keystore file/);
  });
});

describe('orchestrator worker network selection', () => {
  it('defaults to GOAT, reproducing the existing rpcUrl/chainId resolution', () => {
    const config = parseOrchestratorWorkerRuntimeConfig(withSigner());
    expect(config.network).toBe('goat');
    expect(config.chainId).toBe(GOAT_TESTNET3.chainId);
    expect(config.rpcUrl).toBe(GOAT_TESTNET3.publicRpcUrl);
  });

  it('resolves BOT Chain testnet rpcUrl/chainId when NETWORK=bot-chain-testnet, ignoring GOAT_NETWORK_ENVIRONMENT', () => {
    const config = parseOrchestratorWorkerRuntimeConfig(withSigner({ NETWORK: 'bot-chain-testnet' }));
    expect(config.network).toBe('bot-chain-testnet');
    expect(config.chainId).toBe(BOT_CHAIN_TESTNET.chainId);
    expect(config.rpcUrl).toBe(BOT_CHAIN_TESTNET.publicRpcUrl);
  });

  it('rejects a BOT Chain RPC override that does not match the reviewed origin', () => {
    expect(() =>
      parseOrchestratorWorkerRuntimeConfig(
        withSigner({ NETWORK: 'bot-chain-testnet', BOTCHAIN_TESTNET_RPC_URL: 'https://attacker.example' }),
      ),
    ).toThrowError(OrchestratorConfigurationError);
  });
});

describe('GOAT to BNB cross-chain procurement configuration', () => {
  const enabled = {
    CROSS_CHAIN_PROCUREMENT_MODE: 'goat-bnb-usdt',
    GOAT_NETWORK_ENVIRONMENT: 'mainnet',
    GOAT_MAINNET_RPC_URL: GOAT_MAINNET.publicRpcUrl,
    BNB_RPC_URL: 'https://bsc-dataseed.bnbchain.org',
    BNB_X402_ENDPOINT: 'http://127.0.0.1:3402/paid/resource',
    BNB_X402_PAY_TO: '0x9000000000000000000000000000000000000009',
    BNB_X402_PAYER_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
    CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC: '250000',
    BNB_X402_TARGET_AMOUNT_ATOMIC: '200000000000000000',
    STARGATE_MAX_NATIVE_FEE_WEI: '1000000000000000',
    BNB_MAX_APPROVAL_GAS_COST_WEI: '1000000000000000',
  } satisfies NodeJS.ProcessEnv;

  it('is disabled by default', () => {
    expect(parseOrchestratorWorkerRuntimeConfig(withSigner()).crossChain).toBeUndefined();
  });

  it('accepts the complete reviewed GOAT-mainnet to BNB configuration', () => {
    const config = parseOrchestratorWorkerRuntimeConfig(withSigner(enabled));
    expect(config.chainId).toBe(GOAT_MAINNET.chainId);
    expect(config.crossChain).toMatchObject({
      mode: 'BRIDGE_THEN_PAY',
      targetPaymentAmountAtomic: '200000000000000000',
      // Defaults to what actually leaves the funding rail, which is the amount the run's tool
      // budget is really committing.
      policyCostAtomic: '250000',
      bridge: {
        sourceAssetSymbol: 'USDT',
        sourceBridgeAmountAtomic: '250000',
        maximumBridgeWaitSeconds: 1800,
      },
    });
  });

  it('selects the USDC route when the mode is goat-bnb-usdc', () => {
    const config = parseOrchestratorWorkerRuntimeConfig(
      withSigner({ ...enabled, CROSS_CHAIN_PROCUREMENT_MODE: 'goat-bnb-usdc' }),
    );
    expect(config.crossChain?.bridge?.sourceAssetSymbol).toBe('USDC');
  });

  describe('bnb-prefunded mode', () => {
    const prefunded = {
      CROSS_CHAIN_PROCUREMENT_MODE: 'bnb-prefunded',
      BNB_RPC_URL: 'https://bsc-dataseed.bnbchain.org',
      BNB_X402_ENDPOINT: 'https://api.example/paid/resource',
      BNB_X402_PAYER_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
      BNB_X402_SETTLEMENT_ASSET: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d',
      BNB_X402_TARGET_AMOUNT_ATOMIC: '10000000000000000',
      CROSS_CHAIN_POLICY_COST_ATOMIC: '250000',
      BNB_MAX_APPROVAL_GAS_COST_WEI: '1000000000000000',
    } satisfies NodeJS.ProcessEnv;

    it('configures a payer with no bridge at all', () => {
      const config = parseOrchestratorWorkerRuntimeConfig(withSigner(prefunded));

      expect(config.crossChain).toMatchObject({
        mode: 'PREFUNDED',
        settlementAsset: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d',
        targetPaymentAmountAtomic: '10000000000000000',
        policyCostAtomic: '250000',
      });
      expect(config.crossChain?.bridge).toBeUndefined();
    });

    it('runs alongside GOAT testnet3, because it spends no GOAT balance', () => {
      // Only a bridged run moves funds off the GOAT rail, so only that one needs mainnet.
      const config = parseOrchestratorWorkerRuntimeConfig(
        withSigner({ ...prefunded, GOAT_NETWORK_ENVIRONMENT: 'testnet3' }),
      );

      expect(config.crossChain?.mode).toBe('PREFUNDED');
    });

    it('demands the settlement asset and the budget cost, which cannot be derived', () => {
      try {
        parseOrchestratorWorkerRuntimeConfig(
          withSigner({ ...prefunded, BNB_X402_SETTLEMENT_ASSET: undefined, CROSS_CHAIN_POLICY_COST_ATOMIC: undefined }),
        );
        throw new Error('expected configuration error');
      } catch (error) {
        expect(error).toBeInstanceOf(OrchestratorConfigurationError);
        expect((error as OrchestratorConfigurationError).fields).toEqual(
          expect.arrayContaining(['BNB_X402_SETTLEMENT_ASSET', 'CROSS_CHAIN_POLICY_COST_ATOMIC']),
        );
      }
    });

    it('needs no bridge safety ceilings, since nothing is bridged', () => {
      const config = parseOrchestratorWorkerRuntimeConfig(
        withSigner({ ...prefunded, STARGATE_MAX_NATIVE_FEE_WEI: undefined }),
      );

      expect(config.crossChain?.mode).toBe('PREFUNDED');
    });
  });

  it('rejects activation on GOAT testnet3', () => {
    expect(() =>
      parseOrchestratorWorkerRuntimeConfig(
        withSigner({ ...enabled, GOAT_NETWORK_ENVIRONMENT: 'testnet3', GOAT_MAINNET_RPC_URL: undefined }),
      ),
    ).toThrowError(/requires GOAT mainnet/);
  });

  it('lists missing safety-critical bridge fields instead of partially enabling the route', () => {
    try {
      parseOrchestratorWorkerRuntimeConfig(
        withSigner({
          ...enabled,
          STARGATE_MAX_NATIVE_FEE_WEI: undefined,
          BNB_MAX_APPROVAL_GAS_COST_WEI: undefined,
        }),
      );
      throw new Error('expected configuration error');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestratorConfigurationError);
      expect((error as OrchestratorConfigurationError).fields).toEqual(
        expect.arrayContaining(['STARGATE_MAX_NATIVE_FEE_WEI', 'BNB_MAX_APPROVAL_GAS_COST_WEI']),
      );
    }
  });
});
