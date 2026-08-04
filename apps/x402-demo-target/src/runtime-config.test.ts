import { describe, expect, it } from 'vitest';

import { DemoTargetConfigurationError, parseDemoTargetRuntimeConfig } from './runtime-config.js';

describe('x402 demo target runtime configuration', () => {
  it('requires DEMO_MODE and a sufficiently long DEMO_RECEIPT_SECRET', () => {
    expect(() => parseDemoTargetRuntimeConfig({})).toThrowError(DemoTargetConfigurationError);
    expect(() => parseDemoTargetRuntimeConfig({ DEMO_MODE: 'V1_VULNERABLE', DEMO_RECEIPT_SECRET: 'too-short' }))
      .toThrowError(DemoTargetConfigurationError);
  });

  it('rejects an unknown demo mode', () => {
    expect(() => parseDemoTargetRuntimeConfig({
      DEMO_MODE: 'V3_UNKNOWN',
      DEMO_RECEIPT_SECRET: 'a'.repeat(32),
    })).toThrowError(DemoTargetConfigurationError);
  });

  it('applies host and port defaults', () => {
    const config = parseDemoTargetRuntimeConfig({
      DEMO_MODE: 'V2_PROTECTED',
      DEMO_RECEIPT_SECRET: 'a'.repeat(32),
    });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 3002, mode: 'V2_PROTECTED' });
  });

  it('honors an explicit host and port', () => {
    const config = parseDemoTargetRuntimeConfig({
      HOST: '0.0.0.0',
      PORT: '4100',
      DEMO_MODE: 'V1_VULNERABLE',
      DEMO_RECEIPT_SECRET: 'a'.repeat(32),
    });
    expect(config).toMatchObject({ host: '0.0.0.0', port: 4100, mode: 'V1_VULNERABLE' });
  });
});
