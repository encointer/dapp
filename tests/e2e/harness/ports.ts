/** Port assignments for the chopsticks XCM-mode instances. Mirrors
 *  `tests/e2e/chopsticks/{kusama,polkadot}.yml`. */
export const CHOPSTICKS_PORTS = {
  kusamaRelay: 8100,
  kah: 8101,
  encointer: 8102,
  polkadotRelay: 8200,
  pah: 8201,
} as const

export const WS_URL = {
  kusamaRelay: `ws://127.0.0.1:${CHOPSTICKS_PORTS.kusamaRelay}`,
  kah: `ws://127.0.0.1:${CHOPSTICKS_PORTS.kah}`,
  encointer: `ws://127.0.0.1:${CHOPSTICKS_PORTS.encointer}`,
  polkadotRelay: `ws://127.0.0.1:${CHOPSTICKS_PORTS.polkadotRelay}`,
  pah: `ws://127.0.0.1:${CHOPSTICKS_PORTS.pah}`,
} as const
