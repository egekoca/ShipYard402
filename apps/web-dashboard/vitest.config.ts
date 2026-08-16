import { defineConfig } from 'vitest/config';

/**
 * Coverage is scoped to src/lib, src/hooks, and src/components -- the app router pages
 * (src/app/**) are thin Next.js routing wrappers better exercised by the browser than a unit
 * test, and the excluded components below are presentational-only with no business logic, so they
 * were never in scope for this pass. Two groups are excluded: the marketing/landing sections,
 * which render static copy and static data arrays; and the vendored React Bits visual primitives
 * (AnimatedContent, DecryptedText, GlassSurface, LightRays, SpotlightCard, specular-button), which
 * are WebGL/animation effects with nothing a unit test can meaningfully assert. Anything that
 * reads data, branches on it, or talks to the API stays in scope. Thresholds are set just under
 * what this scope actually measures at, as a floor against silent regression -- not a 100% target.
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
        // Marketing/landing sections: static copy and static data arrays.
        'src/components/animated-workflow.tsx',
        'src/components/app-link-button.tsx',
        'src/components/capabilities.tsx',
        'src/components/cross-chain-flow.tsx',
        'src/components/hero-console.tsx',
        'src/components/icons.tsx',
        'src/components/logo.tsx',
        'src/components/networks-strip.tsx',
        'src/components/pipeline.tsx',
        'src/components/problem-solution.tsx',
        'src/components/replay-defense-demo.tsx',
        'src/components/site-header.tsx',
        'src/components/threat-coverage.tsx',
        // Vendored React Bits visual primitives: WebGL and animation effects.
        'src/components/AnimatedContent.tsx',
        'src/components/DecryptedText.tsx',
        'src/components/GlassSurface.tsx',
        'src/components/LightRays.tsx',
        'src/components/SpotlightCard.tsx',
        'src/components/specular-button.tsx',
      ],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 75,
        lines: 85,
      },
    },
  },
});
