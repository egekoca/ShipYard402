import { defineConfig } from 'vitest/config';

/**
 * Coverage is scoped to src/lib, src/hooks, and src/components -- the app router pages
 * (src/app/**) are thin Next.js routing wrappers better exercised by the browser than a unit
 * test, and the marketing/landing components (animated-workflow, icons, logo, problem-solution,
 * replay-defense-demo, threat-coverage, site-header, use-reveal) are presentational-only with no
 * business logic, so they were never in scope for this pass. Thresholds are set just under what
 * this scope actually measures at, as a floor against silent regression -- not a 100% target.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/hooks/**/*.ts', 'src/components/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        'src/hooks/use-reveal.ts',
        'src/components/animated-workflow.tsx',
        'src/components/icons.tsx',
        'src/components/logo.tsx',
        'src/components/pipeline.tsx',
        'src/components/problem-solution.tsx',
        'src/components/replay-defense-demo.tsx',
        'src/components/site-header.tsx',
        'src/components/threat-coverage.tsx',
      ],
      thresholds: {
        statements: 65,
        branches: 80,
        functions: 50,
        lines: 65,
      },
    },
  },
});
