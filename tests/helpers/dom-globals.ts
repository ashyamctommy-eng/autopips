/**
 * Test bootstrap for files that must import the ADMIN service.
 *
 * WHY THIS EXISTS
 * `admin.service.ts` pulls in the broker registry → `metaapi.adapter.ts` →
 * `metaapi.cloud-sdk`. Under Node's CJS resolution (what Next.js uses on the
 * server) that package resolves to its `dist/index.js` CJS build, but vitest
 * resolves the ESM `import` condition and gets `dists/esm-web/index.js` — the
 * BROWSER bundle, which reads `window` at module-evaluation time and throws
 * `ReferenceError: window is not defined` in a Node test process.
 *
 * The accounting aggregates this suite exercises (`aggregateUserLedgers`,
 * `getAdminUser`) never call the SDK at all, so a minimal `window` shim is the
 * least invasive fix: it lets the module graph load without mocking metaapi and
 * without touching `src/**` or `vitest.config.ts` (both out of the verifier's
 * scope).
 *
 * IMPORT ORDER MATTERS: import this module BEFORE any `@/server/modules/admin/**`
 * import. ES module evaluation follows declaration order, so the shim is in
 * place before the SDK's top-level `window` read.
 */

const g = globalThis as unknown as Record<string, unknown>;

if (g.window === undefined) {
  g.window = {
    // The SDK's browser `form-data` shim reads these off `window`/module scope.
    FormData: globalThis.FormData,
    location: { href: 'http://127.0.0.1/' },
    navigator: { userAgent: 'node' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
}
