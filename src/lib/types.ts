import type { PolkadotSigner } from 'polkadot-api'

export type ChainId = 'encointer' | 'kah' | 'pah'
export type TokenSymbol = 'KSM' | 'USDC'
export type ProviderMode = 'smoldot' | 'rpc'

export type ParaSpellChain = 'Encointer' | 'AssetHubKusama' | 'AssetHubPolkadot'

export interface ChainConfig {
  id: ChainId
  name: string
  paraSpellName: ParaSpellChain
  rpcEndpoints: string[]
  tokens: TokenConfig[]
}

export interface TokenConfig {
  symbol: TokenSymbol
  decimals: number
}

export interface Route {
  token: TokenSymbol
  hops: Hop[]
}

export interface Hop {
  from: ChainId
  to: ChainId
}

export interface TransferParams {
  token: TokenSymbol
  source: ChainId
  destination: ChainId
  amount: bigint
}

export type HopStatus = 'pending' | 'signing' | 'submitted' | 'success' | 'error'

export interface HopProgress {
  hop: Hop
  status: HopStatus
  error?: string
}

export type TransferState =
  | { step: 'idle' }
  | { step: 'estimating' }
  | { step: 'ready'; fees: HopFee[] }
  | { step: 'executing'; hops: HopProgress[] }
  | { step: 'success' }
  | { step: 'error'; message: string }

export interface HopFee {
  hop: Hop
  originFee: bigint
  destinationFee: bigint
}

export interface BalanceEntry {
  chain: ChainId
  token: TokenSymbol
  free: bigint
  transferable: bigint
}

export interface WalletState {
  connected: boolean
  extensionName: string | null
  address: string | null
  name: string | null
  signer: PolkadotSigner | null
}

export type SyncStatus = 'disconnected' | 'syncing' | 'synced'
