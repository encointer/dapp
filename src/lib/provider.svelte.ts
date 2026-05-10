import { createClient, type PolkadotClient } from 'polkadot-api'
import { getSmProvider } from 'polkadot-api/sm-provider'
import { getWsProvider } from 'polkadot-api/ws'
import { startFromWorker } from 'polkadot-api/smoldot/from-worker'
import { chainSpec as kusamaSpec } from 'polkadot-api/chains/kusama'
import { chainSpec as polkadotSpec } from 'polkadot-api/chains/polkadot'
import { chainSpec as encointerSpec } from 'polkadot-api/chains/kusama_encointer'
import { chainSpec as kahSpec } from 'polkadot-api/chains/kusama_asset_hub'
import { chainSpec as pahSpec } from 'polkadot-api/chains/polkadot_asset_hub'
import { CHAINS, CHAIN_IDS } from './chains'
import type { ChainId, ProviderMode, SyncStatus, ParaSpellChain } from './types'

type SmoldotClient = ReturnType<typeof startFromWorker>

interface Clients {
  encointer: PolkadotClient
  kah: PolkadotClient
  pah: PolkadotClient
}

let clients = $state<Clients | null>(null)
let syncStatuses = $state<Record<ChainId, SyncStatus>>({
  encointer: 'disconnected',
  kah: 'disconnected',
  pah: 'disconnected',
})
let currentMode = $state<ProviderMode | null>(null)
let smoldotRef: SmoldotClient | null = null

function setSyncStatus(chain: ChainId, status: SyncStatus) {
  syncStatuses = { ...syncStatuses, [chain]: status }
}

async function createSmoldotClients(): Promise<Clients> {
  const SmWorker = (await import('./smoldot-worker?worker')).default
  smoldotRef = startFromWorker(new SmWorker())

  const kusamaChain = await smoldotRef.addChain({ chainSpec: kusamaSpec })
  const polkadotChain = await smoldotRef.addChain({ chainSpec: polkadotSpec })

  const [encointerChain, kahChain, pahChain] = await Promise.all([
    smoldotRef.addChain({ chainSpec: encointerSpec, potentialRelayChains: [kusamaChain] }),
    smoldotRef.addChain({ chainSpec: kahSpec, potentialRelayChains: [kusamaChain] }),
    smoldotRef.addChain({ chainSpec: pahSpec, potentialRelayChains: [polkadotChain] }),
  ])

  return {
    encointer: createClient(getSmProvider(() => encointerChain)),
    kah: createClient(getSmProvider(() => kahChain)),
    pah: createClient(getSmProvider(() => pahChain)),
  }
}

function createRpcClients(): Clients {
  return {
    encointer: createClient(getWsProvider(CHAINS.encointer.rpcEndpoints[0])),
    kah: createClient(getWsProvider(CHAINS.kah.rpcEndpoints[0])),
    pah: createClient(getWsProvider(CHAINS.pah.rpcEndpoints[0])),
  }
}

function teardown() {
  if (clients) {
    try { clients.encointer.destroy() } catch { /* ignore */ }
    try { clients.kah.destroy() } catch { /* ignore */ }
    try { clients.pah.destroy() } catch { /* ignore */ }
    clients = null
  }
  if (smoldotRef) {
    try { smoldotRef.terminate() } catch { /* ignore */ }
    smoldotRef = null
  }
  syncStatuses = { encointer: 'disconnected', kah: 'disconnected', pah: 'disconnected' }
}

export async function connect(mode: ProviderMode) {
  if (currentMode === mode && clients) return
  teardown()
  currentMode = mode

  for (const id of CHAIN_IDS) setSyncStatus(id, 'syncing')

  try {
    clients = mode === 'smoldot'
      ? await createSmoldotClients()
      : createRpcClients()

    for (const id of CHAIN_IDS) setSyncStatus(id, 'synced')
  } catch (err) {
    console.error('Provider connection failed:', err)
    for (const id of CHAIN_IDS) setSyncStatus(id, 'disconnected')
  }
}

export function disconnect() {
  teardown()
  currentMode = null
}

export function getClient(chain: ChainId): PolkadotClient | null {
  if (!clients) return null
  return clients[chain]
}

export function getApiOverrides(): Partial<Record<ParaSpellChain, PolkadotClient>> | null {
  if (!clients) return null
  return {
    Encointer: clients.encointer,
    AssetHubKusama: clients.kah,
    AssetHubPolkadot: clients.pah,
  }
}

export function getSyncStatuses(): Record<ChainId, SyncStatus> {
  return syncStatuses
}

export function isConnected(): boolean {
  return clients !== null
}
