import { ShipyardApiError } from '@shipyard402/public-api-client';
import { describe, expect, it } from 'vitest';

import { formatAtomic, formatCountdown, formatError, shortHash } from './release-run-form';

describe('formatError', () => {
  it('formats a ShipyardApiError as "CODE: message"', () => {
    const error = new ShipyardApiError(410, 'QUOTE_EXPIRED', 'The quote has expired');
    expect(formatError(error)).toBe('QUOTE_EXPIRED: The quote has expired');
  });

  it('falls back to the message of a plain Error', () => {
    expect(formatError(new Error('network unreachable'))).toBe('network unreachable');
  });

  it('falls back to a generic message for anything else', () => {
    expect(formatError('boom')).toBe('Unexpected request failure');
  });
});

describe('shortHash', () => {
  it('keeps the first 12 and last 8 characters, joined with an ellipsis', () => {
    expect(shortHash('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234567890…12345678');
  });
});

describe('formatCountdown', () => {
  it('formats a sub-minute duration as 0:SS', () => {
    expect(formatCountdown(45_000)).toBe('0:45');
  });

  it('formats a multi-minute duration as M:SS, zero-padded', () => {
    expect(formatCountdown(125_000)).toBe('2:05');
  });

  it('never goes negative for an already-expired countdown', () => {
    expect(formatCountdown(-5_000)).toBe('0:00');
  });
});

describe('formatAtomic', () => {
  it('returns the raw value unchanged when the token has zero decimals', () => {
    expect(formatAtomic('42', 0)).toBe('42');
  });

  it('splits the atomic amount into whole and fractional parts at the token decimals', () => {
    expect(formatAtomic('1500000', 6)).toBe('1.500000');
  });

  it('zero-pads the fractional part so trailing zeros are not dropped', () => {
    expect(formatAtomic('1000001', 6)).toBe('1.000001');
  });
});
