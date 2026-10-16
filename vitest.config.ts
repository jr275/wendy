import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The web package imports its own libs as '@/lib/...'; tests that load web/proxy.ts or web/app/**/route.ts need the same mapping.
  resolve: { alias: { '@/lib': fileURLToPath(new URL('./web/lib', import.meta.url)), 'next/server': fileURLToPath(new URL('./web/node_modules/next/server.js', import.meta.url)) } },
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Tests never read the principal's personal Search Console scope (config/search-scope.json): a path that does not exist means "no restriction".
    env: { WENDY_SEARCH_SCOPE_FILE: '/nonexistent/wendy-test/search-scope.json' },
  },
});
