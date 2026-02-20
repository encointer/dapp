import { getBalance, getExistentialDeposit } from '@paraspell/sdk'
import { CHAINS, CHAIN_IDS } from './chains'
import { getApiOverrides } from './provider.svelte'
import type { ChainId, TokenSymbol, BalanceEntry, ParaSpellChain } from './types'
import type { PolkadotClient } from 'polkadot-api'

let balances = $state<BalanceEntry[]>([])
let loading = $state(false)
let lastError = $state<string | null>(null)
let refreshTimer: ReturnType<typeof setInterval> | null = null

function ed(chain: ParaSpellChain, token: TokenSymbol): bigint {
  const result = getExistentialDeposit(chain, { symbol: token })
  return result ?? 0n
}

async function fetchBalance(
  address: string,
  chainId: ChainId,
  token: TokenSymbol,
  apiOverrides: Partial<Record<ParaSpellChain, PolkadotClient>>,
): Promise<BalanceEntry> {
  const paraSpell = CHAINS[chainId].paraSpellName
  const api = apiOverrides[paraSpell]

  try {
    const free = await getBalance({
      address,
      chain: paraSpell,
      currency: { symbol: token },
      ...(api ? { api } : {}),
    })

    const existential = ed(paraSpell, token)
    const transferable = free > existential ? free - existential : 0n

    return { chain: chainId, token, free, transferable }
  } catch (err) {
    console.warn(`Balance query failed: ${chainId}/${token}`, err)
    return { chain: chainId, token, free: 0n, transferable: 0n }
  }
}

export async function fetchAllBalances(address: string) {
  const overrides = getApiOverrides()
  if (!overrides) {
    lastError = 'Not connected'
    return
  }

  loading = true
  lastError = null

  try {
    const queries: Promise<BalanceEntry>[] = []
    for (const chainId of CHAIN_IDS) {
      for (const tokenConfig of CHAINS[chainId].tokens) {
        queries.push(fetchBalance(address, chainId, tokenConfig.symbol, overrides))
      }
    }
    balances = await Promise.all(queries)
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'Failed to fetch balances'
  } finally {
    loading = false
  }
}

export function startAutoRefresh(address: string, intervalMs = 30_000) {
  stopAutoRefresh()
  fetchAllBalances(address)
  refreshTimer = setInterval(() => {
    if (!document.hidden) fetchAllBalances(address)
  }, intervalMs)
}

export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

export function getBalances(): BalanceEntry[] {
  return balances
}

export function getBalanceFor(chainId: ChainId, token: TokenSymbol): BalanceEntry | undefined {
  return balances.find(b => b.chain === chainId && b.token === token)
}

export function isLoading(): boolean {
  return loading
}

export function getError(): string | null {
  return lastError
}
