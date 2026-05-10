import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// E2E config: runs the chopsticks-backed integration suite under `tests/e2e/`.
// Slow (each test spins up multi-chain XCM simulations and waits for blocks),
// so kept off the default `pnpm test` and gated behind `pnpm test:e2e`.
//
// The svelte plugin is required because the dapp's lib functions live in
// `.svelte.ts` files which use Svelte 5 runes (`$state`/`$derived`). Without
// the plugin, those runes throw `ReferenceError` at import time.
export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    // Chopsticks block production is slow; XCM forwarding adds more.
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // Bring up chopsticks sequentially across files (each file uses the same
    // ports) — parallel workers would clobber each other.
    fileParallelism: false,
    // Spawn chopsticks once for the whole suite, not per file — see
    // `tests/e2e/global-setup.ts`.
    globalSetup: ['./tests/e2e/global-setup.ts'],
    // Verbose output is essential when chopsticks misbehaves in CI.
    reporters: ['verbose'],
  },
})
