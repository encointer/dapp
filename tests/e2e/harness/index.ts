import { afterAll, beforeAll } from 'vitest'
import { createClient, type PolkadotClient } from 'polkadot-api'
import { getWsProvider } from 'polkadot-api/ws'
import { setRpcOverrides, connect, disconnect, getClient } from '../../../src/lib/provider.svelte'
import { setSafeFeeAssetEnforcement } from '../../../src/lib/donate.svelte'
import { devAccount, type DevAccount, type TestAccount } from './signer'
import { endowTestAccount, type PreState } from './endow'
import { DevRpc, newBlock } from './dev-rpc'
import { WS_URL } from './ports'
import type { ChainId } from '../../../src/lib/types'

/** Per-file setup. Chopsticks itself is spawned once for the whole vitest
 *  run via `globalSetup` (see vitest.config.e2e.ts); each test file's
 *  `beforeAll` only points the dapp at the chopsticks WS ports and connects
 *  the PAPI client. */

beforeAll(async () => {
  setRpcOverrides({
    encointer: WS_URL.encointer,
    kah: WS_URL.kah,
    pah: WS_URL.pah,
  })
  // Disable the wallet-bug guard: it's a defensive check for browser-
  // injected wallets that crash on cross-consensus `assetId`. We use a
  // programmatic signer here, so the guard is overly conservative.
  setSafeFeeAssetEnforcement(false)
  await connect('rpc')
}, 60_000)

afterAll(async () => {
  disconnect()
  setRpcOverrides(null)
  setSafeFeeAssetEnforcement(true)
}, 30_000)

/** Per-test setup helper. Endows the chosen dev account on every chain
 *  according to the issue's pre-state categories, then returns handles for
 *  test code to:
 *  - call dapp lib functions (`executeDonate`, `executeTransfer`, …) using
 *    the test signer,
 *  - inspect destination chain state directly via `clientFor(chain)`,
 *  - advance chopsticks block production after a tx (via
 *    `produceBlocks(chain, n)`).
 */
export interface TestContext {
  account: TestAccount
  source: 'pah' | 'kah'
  preState: PreState
  /** PAPI clients pointed at chopsticks; one per chain. The dapp also uses
   *  these (via the provider's RPC override). */
  clientFor: (chain: ChainId) => PolkadotClient
  /** Advance chopsticks's manual block production for a chain. Required to
   *  finalize submitted txs since YAMLs use `build-block-mode: Manual`. */
  produceBlocks: (chain: ChainId, count?: number) => Promise<void>
}

const directClients: Partial<Record<ChainId, PolkadotClient>> = {}
const devRpcs: Partial<Record<ChainId, DevRpc>> = {}

function chainWsUrl(chain: ChainId): string {
  if (chain === 'encointer') return WS_URL.encointer
  if (chain === 'kah') return WS_URL.kah
  return WS_URL.pah
}

afterAll(() => {
  for (const c of Object.values(directClients)) c?.destroy()
  for (const r of Object.values(devRpcs)) r?.close()
})

export async function setupContext(opts: {
  account?: DevAccount
  source: 'pah' | 'kah'
  preState: PreState
}): Promise<TestContext> {
  const account = devAccount(opts.account ?? '//Alice')
  await endowTestAccount(account, { source: opts.source, preState: opts.preState })

  const clientFor = (chain: ChainId): PolkadotClient => {
    const fromDapp = getClient(chain)
    if (fromDapp) return fromDapp
    if (!directClients[chain]) directClients[chain] = createClient(getWsProvider(chainWsUrl(chain)))
    return directClients[chain]!
  }

  const produceBlocks = async (chain: ChainId, count = 1): Promise<void> => {
    if (!devRpcs[chain]) devRpcs[chain] = new DevRpc(chainWsUrl(chain))
    await newBlock(devRpcs[chain]!, count)
  }

  return { account, source: opts.source, preState: opts.preState, clientFor, produceBlocks }
}
