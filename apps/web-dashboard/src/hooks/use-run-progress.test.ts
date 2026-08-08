import { describe, expect, it } from 'vitest';

import {
  explorerTxUrl,
  formatDurationEstimate,
  ipfsGatewayUrl,
  isTerminalStatus,
  shortHash,
  stepIndexForStatus,
} from './use-run-progress';

describe('stepIndexForStatus', () => {
  it('maps pre-payment statuses to -1', () => {
    expect(stepIndexForStatus('DRAFT')).toBe(-1);
    expect(stepIndexForStatus('QUOTED')).toBe(-1);
    expect(stepIndexForStatus('PAYMENT_REQUIRED')).toBe(-1);
  });

  it('maps a run that never reached step 0 (cancelled/expired) to -1, not the terminal index', () => {
    expect(stepIndexForStatus('CANCELLED')).toBe(-1);
    expect(stepIndexForStatus('EXPIRED')).toBe(-1);
  });

  it('maps each pipeline phase to its step index', () => {
    expect(stepIndexForStatus('FUNDED')).toBe(0);
    expect(stepIndexForStatus('ANALYZING')).toBe(1);
    expect(stepIndexForStatus('PLAN_COMPILED')).toBe(1);
    expect(stepIndexForStatus('PROCURING')).toBe(2);
    expect(stepIndexForStatus('EXECUTING')).toBe(2);
    expect(stepIndexForStatus('REPLANNING')).toBe(2);
    expect(stepIndexForStatus('EVIDENCE_BUILDING')).toBe(3);
    expect(stepIndexForStatus('ATTESTING')).toBe(4);
  });

  it('maps a genuinely delivered status to the final step', () => {
    expect(stepIndexForStatus('DELIVERED_PASS')).toBe(5);
    expect(stepIndexForStatus('DELIVERED_FAIL')).toBe(5);
    expect(stepIndexForStatus('DELIVERED_INCONCLUSIVE')).toBe(5);
  });
});

describe('isTerminalStatus', () => {
  it('treats every DELIVERED_* status, CANCELLED, and EXPIRED as terminal', () => {
    expect(isTerminalStatus('DELIVERED_PASS')).toBe(true);
    expect(isTerminalStatus('DELIVERED_CONDITIONAL')).toBe(true);
    expect(isTerminalStatus('DELIVERED_FAIL')).toBe(true);
    expect(isTerminalStatus('DELIVERED_INCONCLUSIVE')).toBe(true);
    expect(isTerminalStatus('CANCELLED')).toBe(true);
    expect(isTerminalStatus('EXPIRED')).toBe(true);
  });

  it('treats every in-flight status as non-terminal', () => {
    expect(isTerminalStatus('FUNDED')).toBe(false);
    expect(isTerminalStatus('EXECUTING')).toBe(false);
  });
});

describe('formatDurationEstimate', () => {
  it('rounds sub-second durations up to ~1s', () => {
    expect(formatDurationEstimate(400)).toBe('~1s');
  });

  it('formats whole seconds under a minute', () => {
    expect(formatDurationEstimate(3_000)).toBe('~3s');
    expect(formatDurationEstimate(59_000)).toBe('~59s');
  });

  it('formats minutes without a trailing 0s', () => {
    expect(formatDurationEstimate(120_000)).toBe('~2m');
  });

  it('formats minutes and seconds together', () => {
    expect(formatDurationEstimate(135_000)).toBe('~2m 15s');
  });
});

describe('explorerTxUrl', () => {
  it('routes GOAT mainnet (chain 2345) to the mainnet explorer', () => {
    expect(explorerTxUrl(2345, '0xabc')).toBe('https://explorer.goat.network/tx/0xabc');
  });

  it('routes any other chain id to the testnet3 explorer', () => {
    expect(explorerTxUrl(48816, '0xabc')).toBe('https://explorer.testnet3.goat.network/tx/0xabc');
  });
});

describe('ipfsGatewayUrl', () => {
  it('rewrites an ipfs:// URI through the public gateway', () => {
    expect(ipfsGatewayUrl('ipfs://bafybeigd')).toBe('https://ipfs.io/ipfs/bafybeigd');
  });

  it('passes a non-ipfs URI through unchanged', () => {
    expect(ipfsGatewayUrl('https://example.com/evidence.json')).toBe('https://example.com/evidence.json');
  });
});

describe('shortHash', () => {
  it('keeps the first 10 and last 6 characters, joined with an ellipsis', () => {
    expect(shortHash('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x12345678…345678');
  });
});
