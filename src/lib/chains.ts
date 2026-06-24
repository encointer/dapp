import { Native, Foreign, type TCurrencyCore } from '@paraspell/sdk'
import type { ChainConfig, ChainId, TokenSymbol, ParaSpellChain } from './types'

export const CHAINS: Record<ChainId, ChainConfig> = {
  encointer: {
    id: 'encointer',
    name: 'Encointer',
    paraSpellName: 'Encointer',
    rpcEndpoints: [
      'wss://kusama.api.encointer.org',
      'wss://encointer-kusama-rpc.dwellir.com',
      'wss://rpc-encointer-kusama.luckyfriday.io'
    ],
    tokens: [{ symbol: 'KSM', decimals: 12 }],
  },
  kah: {
    id: 'kah',
    name: 'Asset Hub Kusama',
    paraSpellName: 'AssetHubKusama',
    rpcEndpoints: [
      'wss://kusama-asset-hub-rpc.polkadot.io',
      'wss://assethub-kusama.api.onfinality.io/public-ws'
    ],
    tokens: [
      { symbol: 'KSM', decimals: 12, currency: { symbol: Native('KSM') } },
      // DOT bridged from PAH — KAH's foreign asset for the Polkadot relay token.
      { symbol: 'DOT', decimals: 10, currency: { symbol: Foreign('DOT') } },
      {
        symbol: 'USDC',
        decimals: 6,
        currency: {
          location: {
            parents: 2,
            interior: {
              X4: [
                { GlobalConsensus: { Polkadot: null } },
                { Parachain: 1000 },
                { PalletInstance: 50 },
                { GeneralIndex: 1337 },
              ],
            },
          },
        },
      },
    ],
  },
  pah: {
    id: 'pah',
    name: 'Asset Hub Polkadot',
    paraSpellName: 'AssetHubPolkadot',
    rpcEndpoints: [
      'wss://polkadot-asset-hub-rpc.polkadot.io',
      'wss://statemint.api.onfinality.io/public-ws'
    ],
    tokens: [
      { symbol: 'KSM', decimals: 12, currency: { symbol: Foreign('KSM') } },
      { symbol: 'DOT', decimals: 10, currency: { symbol: Native('DOT') } },
      { symbol: 'USDC', decimals: 6, currency: { id: 1337 } },
    ],
  },
}

export const CHAIN_IDS: ChainId[] = ['encointer', 'kah', 'pah']
export const TOKEN_SYMBOLS: TokenSymbol[] = ['KSM', 'DOT', 'USDC']

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

export function getCurrency(chainId: ChainId, token: TokenSymbol): TCurrencyCore {
  const t = CHAINS[chainId].tokens.find(t => t.symbol === token)
  return t?.currency ?? { symbol: token }
}
