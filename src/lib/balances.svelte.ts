import { getBalance, getExistentialDeposit } from '@paraspell/sdk'
import { CHAINS, CHAIN_IDS, getCurrency } from './chains'
import { getApiOverrides, getClient } from './provider.svelte'
import type { TCurrencyCore } from '@paraspell/sdk'
import type { ChainId, TokenSymbol, BalanceEntry, ParaSpellChain } from './types'
import type { PolkadotClient } from 'polkadot-api'

let balances = $state<BalanceEntry[]>([])
let loading = $state(false)
let lastError = $state<string | null>(null)
let subscriptions: (() => void)[] = []

function ed(chain: ParaSpellChain, currency: TCurrencyCore): bigint {
  const result = getExistentialDeposit(chain, currency)
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
    const currency = getCurrency(chainId, token)
    const free = await getBalance({
      address,
      chain: paraSpell,
      currency,
      ...(api ? { api } : {}),
    })

    const existential = ed(paraSpell, currency)
    const transferable = free > existential ? free - existential : 0n

    return { chain: chainId, token, free, transferable }
  } catch (err) {
    console.warn(`Balance query failed: ${chainId}/${token}`, err)
    return { chain: chainId, token, free: 0n, transferable: 0n }
  }
}

async function fetchChainBalances(address: string, chainId: ChainId) {
  const overrides = getApiOverrides()
  if (!overrides) return

  const tokens = CHAINS[chainId].tokens
  const results = await Promise.all(
    tokens.map(t => fetchBalance(address, chainId, t.symbol, overrides)),
  )

  // Merge into existing balances
  balances = balances
    .filter(b => b.chain !== chainId)
    .concat(results)
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

export function subscribeBalances(address: string) {
  unsubscribeBalances()

  // Initial fetch
  loading = true
  fetchAllBalances(address).then(() => { loading = false })

  // Subscribe to finalized blocks on each chain; refetch that chain's balances
  for (const chainId of CHAIN_IDS) {
    const client = getClient(chainId)
    if (!client) continue

    let first = true
    const sub = client.finalizedBlock$.subscribe({
      next: () => {
        // Skip the first emission (we already fetched above)
        if (first) { first = false; return }
        fetchChainBalances(address, chainId)
      },
      error: (err: unknown) => {
        console.warn(`Block subscription error for ${chainId}:`, err)
      },
    })
    subscriptions.push(() => sub.unsubscribe())
  }
}

export function unsubscribeBalances() {
  subscriptions.forEach(fn => fn())
  subscriptions = []
}

// Keep old API for compatibility, but prefer subscribeBalances
export function startAutoRefresh(address: string) {
  subscribeBalances(address)
}

export function stopAutoRefresh() {
  unsubscribeBalances()
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
