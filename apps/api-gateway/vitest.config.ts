import { defineConfig } from 'vitest/config';

/**
 * `vercel build` writes a compiled copy of this app -- test files included -- into `.vercel/output`,
 * which is not one of Vitest's default-excluded directories the way `dist` is. Without this the
 * suite collects and runs that build output alongside the real sources: every `api/*.test.ts` case
 * executes twice, and the second copy is whatever the last local `vercel build` froze, so it keeps
 * passing long after the source it was compiled from has changed. Exclude it so the suite only ever
 * reports on the current sources.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.vercel/**'],
  },
});
