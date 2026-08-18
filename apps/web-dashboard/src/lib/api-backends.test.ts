import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * MARKETPLACE_BACKENDS is resolved once at module load from the NEXT_PUBLIC_* values baked into
 * the build, so each case has to load the module fresh with its own environment.
 */
async function loadWith(env: Readonly<Record<string, string | undefined>>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(name, '');
    else vi.stubEnv(name, value);
  }
  return import('./api-backends');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('MARKETPLACE_BACKENDS', () => {
  it('browses only the backend a deployment was actually given a URL for', async () => {
    // The production shape today: a GOAT API is deployed, no BOT Chain one is. Querying a
    // backend nobody configured would mean an HTTPS page fetching the visitor's own localhost --
    // blocked as mixed content, erroring in their console, feeding a tab that stays empty.
    const { MARKETPLACE_BACKENDS } = await loadWith({
      NEXT_PUBLIC_SHIPYARD_API_URL: 'https://api.example.com',
      NEXT_PUBLIC_BOTCHAIN_API_URL: undefined,
    });
    expect(MARKETPLACE_BACKENDS).toEqual(['goat']);
  });

  it('browses both once both are configured', async () => {
    const { MARKETPLACE_BACKENDS } = await loadWith({
      NEXT_PUBLIC_SHIPYARD_API_URL: 'https://api.example.com',
      NEXT_PUBLIC_BOTCHAIN_API_URL: 'https://bot.example.com',
    });
    expect(MARKETPLACE_BACKENDS).toEqual(['goat', 'bot-chain']);
  });

  it('keeps both loopback backends when nothing is configured at all', async () => {
    // A bare checkout running `pnpm dev` has no NEXT_PUBLIC_* set and both APIs really are on
    // loopback, so zero configuration must still browse both.
    const { MARKETPLACE_BACKENDS, apiBaseUrl } = await loadWith({
      NEXT_PUBLIC_SHIPYARD_API_URL: undefined,
      NEXT_PUBLIC_BOTCHAIN_API_URL: undefined,
    });
    expect(MARKETPLACE_BACKENDS).toEqual(['goat', 'bot-chain']);
    expect(apiBaseUrl('goat')).toBe('http://127.0.0.1:3001');
    expect(apiBaseUrl('bot-chain')).toBe('http://127.0.0.1:3011');
  });

  it('still routes a run to a backend that is configured', async () => {
    const { apiBaseUrl } = await loadWith({
      NEXT_PUBLIC_SHIPYARD_API_URL: 'https://api.example.com',
      NEXT_PUBLIC_BOTCHAIN_API_URL: 'https://bot.example.com',
    });
    expect(apiBaseUrl('goat')).toBe('https://api.example.com');
    expect(apiBaseUrl('bot-chain')).toBe('https://bot.example.com');
  });
});
