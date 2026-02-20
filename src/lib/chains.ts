import type { ChainConfig, ChainId, TokenSymbol, ParaSpellChain } from './types'

export const CHAINS: Record<ChainId, ChainConfig> = {
  encointer: {
    id: 'encointer',
    name: 'Encointer',
    paraSpellName: 'Encointer',
    rpcEndpoints: [
      'wss://sys.ibp.network/encointer-kusama',
      'wss://encointer-kusama-rpc.dwellir.com',
    ],
    tokens: [{ symbol: 'KSM', decimals: 12 }],
  },
  kah: {
    id: 'kah',
    name: 'Asset Hub Kusama',
    paraSpellName: 'AssetHubKusama',
    rpcEndpoints: [
      'wss://sys.ibp.network/statemine',
      'wss://kusama-asset-hub-rpc.polkadot.io',
    ],
    tokens: [
      { symbol: 'KSM', decimals: 12 },
      { symbol: 'USDC', decimals: 6 },
    ],
  },
  pah: {
    id: 'pah',
    name: 'Asset Hub Polkadot',
    paraSpellName: 'AssetHubPolkadot',
    rpcEndpoints: [
      'wss://sys.ibp.network/statemint',
      'wss://polkadot-asset-hub-rpc.polkadot.io',
    ],
    tokens: [
      { symbol: 'KSM', decimals: 12 },
      { symbol: 'USDC', decimals: 6 },
    ],
  },
}

export const CHAIN_IDS: ChainId[] = ['encointer', 'kah', 'pah']
export const TOKEN_SYMBOLS: TokenSymbol[] = ['KSM', 'USDC']

export function getChain(id: ChainId): ChainConfig {
  return CHAINS[id]
}

export function chainHasToken(chainId: ChainId, token: TokenSymbol): boolean {
  return CHAINS[chainId].tokens.some(t => t.symbol === token)
}

export function getDecimals(chainId: ChainId, token: TokenSymbol): number {
  const t = CHAINS[chainId].tokens.find(t => t.symbol === token)
  if (!t) throw new Error(`Token ${token} not on chain ${chainId}`)
  return t.decimals
}

export function toParaSpell(chainId: ChainId): ParaSpellChain {
  return CHAINS[chainId].paraSpellName
}
