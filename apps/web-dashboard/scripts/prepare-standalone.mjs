import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Vercel builds without output: 'standalone' (see next.config.ts) -- no .next/standalone exists
// to populate, and there's nothing for this self-host-only step to do.
if (process.env.VERCEL) process.exit(0);

const applicationRoot = resolve(import.meta.dirname, '..');
const standaloneRoot = resolve(applicationRoot, '.next/standalone/apps/web-dashboard');

await mkdir(resolve(standaloneRoot, '.next'), { recursive: true });
await cp(
  resolve(applicationRoot, '.next/static'),
  resolve(standaloneRoot, '.next/static'),
  { recursive: true, force: true },
);

try {
  await cp(resolve(applicationRoot, 'public'), resolve(standaloneRoot, 'public'), {
    recursive: true,
    force: true,
  });
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
