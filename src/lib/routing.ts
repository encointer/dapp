import type { ChainId, TokenSymbol, Route, Hop, BalanceEntry } from './types'
import { chainHasToken, CHAIN_IDS } from './chains'

interface RouteKey {
  token: TokenSymbol
  from: ChainId
  to: ChainId
}

function key(r: RouteKey): string {
  return `${r.token}:${r.from}:${r.to}`
}

function hop(from: ChainId, to: ChainId): Hop {
  return { from, to }
}

const ROUTE_TABLE = new Map<string, Hop[]>([
  // KSM: Encointer <-> KAH (1 hop)
  [key({ token: 'KSM', from: 'encointer', to: 'kah' }), [hop('encointer', 'kah')]],
  [key({ token: 'KSM', from: 'kah', to: 'encointer' }), [hop('kah', 'encointer')]],

  // KSM: KAH <-> PAH (1 hop, bridge)
  [key({ token: 'KSM', from: 'kah', to: 'pah' }), [hop('kah', 'pah')]],
  [key({ token: 'KSM', from: 'pah', to: 'kah' }), [hop('pah', 'kah')]],

  // KSM: Encointer <-> PAH (2 hops)
  [key({ token: 'KSM', from: 'encointer', to: 'pah' }), [hop('encointer', 'kah'), hop('kah', 'pah')]],
  [key({ token: 'KSM', from: 'pah', to: 'encointer' }), [hop('pah', 'kah'), hop('kah', 'encointer')]],

  // USDC: KAH <-> PAH (1 hop, bridge)
  [key({ token: 'USDC', from: 'kah', to: 'pah' }), [hop('kah', 'pah')]],
  [key({ token: 'USDC', from: 'pah', to: 'kah' }), [hop('pah', 'kah')]],

  // DOT: KAH <-> PAH (1 hop, bridge) — DOT lives on PAH; on KAH it's a foreign asset.
  [key({ token: 'DOT', from: 'pah', to: 'kah' }), [hop('pah', 'kah')]],
  [key({ token: 'DOT', from: 'kah', to: 'pah' }), [hop('kah', 'pah')]],
])

export function resolveRoute(token: TokenSymbol, from: ChainId, to: ChainId): Route | null {
  if (from === to) return null
  const hops = ROUTE_TABLE.get(key({ token, from, to }))
  if (!hops) return null
  return { token, hops }
}

export function getDestinations(token: TokenSymbol, source: ChainId): ChainId[] {
  return CHAIN_IDS.filter(id => {
    if (id === source) return false
    if (!chainHasToken(id, token)) return false
    if (!chainHasToken(source, token)) return false
    return resolveRoute(token, source, id) !== null
  })
}

export function detectSource(token: TokenSymbol, balances: BalanceEntry[]): ChainId | null {
  let best: ChainId | null = null
  let bestAmount = 0n

  for (const entry of balances) {
    if (entry.token !== token) continue
    if (!chainHasToken(entry.chain, token)) continue
    if (entry.transferable > bestAmount) {
      bestAmount = entry.transferable
      best = entry.chain
    }
  }

  return best
}
