/**
 * Mechanically enforces the layering documented in docs/architecture.md, which was previously
 * "true by discipline only" (verified by hand, one audit at a time). Run via `pnpm depcruise`.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A dependency cycle almost always means two modules should be merged or split differently.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-do-not-depend-on-apps',
      severity: 'error',
      comment:
        'packages/* are the shared domain/adapter layer; apps/* are wiring on top of them. An import the other ' +
        'way round inverts that and usually means the shared code should not have been shared in the first place.',
      from: { path: '^packages' },
      to: { path: '^apps' },
    },
    {
      name: 'web-dashboard-is-frontend-only',
      severity: 'error',
      comment:
        'apps/web-dashboard is independently deployable and must never gain a path to economic credentials or ' +
        'persistence (see docs/architecture.md, "Frontend/backend dependency direction") -- the public API over ' +
        'HTTPS is its only line to the backend.',
      from: { path: '^apps/web-dashboard' },
      to: {
        path: '^(packages/(?!public-api-client)|apps/(?!web-dashboard))',
      },
    },
    {
      name: 'demo-target-is-not-a-backend-dependency',
      severity: 'error',
      comment:
        'apps/x402-demo-target is a reference tool endpoint used to exercise the pipeline in scenarios, not a ' +
        'library other apps should import from.',
      from: { path: '^apps/(?!x402-demo-target)' },
      to: { path: '^apps/x402-demo-target' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    // dist/** is deliberately NOT excluded: every @shipyard402/* package's package.json "exports"
    // resolves to its own dist/index.js, so excluding that path silently drops every cross-package
    // import from the graph -- which is exactly the thing this config exists to check.
    exclude: {
      path: '(^|/)\\.next/|(^|/)\\.turbo/|(^|/)contracts/(out|out-solc|cache)/',
    },
    doNotFollow: {
      path: 'node_modules/(?!@shipyard402)',
    },
  },
};
