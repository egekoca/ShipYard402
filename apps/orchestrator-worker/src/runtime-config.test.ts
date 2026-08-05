import { GOAT_TESTNET3 } from '@shipyard402/goat-network-config';
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
  DEMO_TARGET_BASE_URL: 'https://demo-target.example',
  DEMO_TARGET_HOST: 'demo-target.example',
  DEMO_TARGET_TOOL_AGENT_ID: 'agent:demo-target',
  DEMO_TARGET_RECEIVING_ADDRESS: '0x4000000000000000000000000000000000000004',
  DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT: '100',
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
    expect(() => parseOrchestratorWorkerRuntimeConfig({
      ...baseEnvironment,
      ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY: rawKey,
    })).toThrowError(OrchestratorConfigurationError);
  });

  it('refuses a raw key and a keystore configured at the same time', () => {
    expect(() => parseOrchestratorWorkerRuntimeConfig(withSigner({
      ORCHESTRATOR_SIGNER_KEYSTORE_PATH: keystorePath,
      ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD: keystorePassword,
    }))).toThrowError(/either a raw private key or an encrypted keystore, not both/);
  });

  it('requires both a keystore path and password, not just one', () => {
    expect(() => parseOrchestratorWorkerRuntimeConfig({
      ...baseEnvironment,
      ORCHESTRATOR_SIGNER_KEYSTORE_PATH: keystorePath,
      ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY: rawKey,
    })).toThrowError(/requires both a path and a password/);
  });

  it('refuses a raw private key in production', () => {
    expect(() => parseOrchestratorWorkerRuntimeConfig(withSigner({ APP_ENV: 'production', DATABASE_URL: 'postgresql://database.example/shipyard' })))
      .toThrowError(/production must use an encrypted keystore/);
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
    expect(() => parseOrchestratorWorkerRuntimeConfig(withSigner({
      ORCHESTRATOR_SIGNER_PRIVATE_KEY: undefined as unknown as string,
      ORCHESTRATOR_SIGNER_KEYSTORE_PATH: join(keystoreDir, 'does-not-exist.json'),
      ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD: keystorePassword,
    }))).toThrowError(/could not read the keystore file/);
  });
});
