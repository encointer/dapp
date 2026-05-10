import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Default vitest config — runs the unit tests under `src/__tests__`. The
// chopsticks-backed e2e suite under `tests/e2e/` is excluded here and runs
// only via `pnpm test:e2e` (vitest.config.e2e.ts), so the regular `pnpm test`
// stays fast and deterministic.
export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
})
