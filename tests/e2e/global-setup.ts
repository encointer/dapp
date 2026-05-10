import { startChopsticks, type ChopsticksHandle } from './harness/chopsticks'

/** Vitest `globalSetup`: runs once before the entire e2e suite (across all
 *  test files) and once after. Spawning chopsticks here — instead of per-file
 *  `beforeAll` — means each test file connects to a long-lived multi-chain
 *  simulation rather than ping-ponging chopsticks between files. */
let handle: ChopsticksHandle | null = null

export async function setup(): Promise<void> {
  handle = await startChopsticks()
}

export async function teardown(): Promise<void> {
  await handle?.shutdown()
  handle = null
}
