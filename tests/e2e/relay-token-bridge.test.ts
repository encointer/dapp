import { describe, it, expect } from 'vitest'
import { setupContext } from './harness'
import { ss58For } from './harness/signer'
import { estimateFees, executeTransfer, resetTransfer, getTransferState } from '../../src/lib/transfer.svelte'
import type { ChainId, TokenSymbol } from '../../src/lib/types'

/**
 * Bridge transfers of relay-native tokens (DOT, KSM) across the Polkadot↔Kusama
 * substrate bridge in both directions.
 *
 * What the test asserts:
 *  - `estimateFees` reaches `ready` (covers source dry-run + the synthetic
 *    destination dry-run the dapp performs in `dryRunFull`).
 *  - `executeTransfer` submits the source-side dispatch successfully.
 *  - Source balance decreases by at least `amount`.
 *
 * What it cannot assert: actual destination credit. Chopsticks pairs one relay
 * per process and doesn't auto-forward across the P↔K bridge; cross-consensus
 * delivery isn't simulated. The dapp's dry-run on the destination (via
 * `DryRunApi.dry_run_xcm` with a re-anchored origin) is the closest proxy.
 */

const DOT_KAH_FOREIGN_LOC = {
  parents: 2,
  interior: { type: 'X1', value: { type: 'GlobalConsensus', value: { type: 'Polkadot' } } },
}
const KSM_PAH_FOREIGN_LOC = {
  parents: 2,
  interior: { type: 'X1', value: { type: 'GlobalConsensus', value: { type: 'Kusama' } } },
}

interface ApiShape {
  query: {
    System: { Account: { getValue: (addr: string) => Promise<{ data: { free: bigint } }> } }
    ForeignAssets: { Account: { getValue: (loc: unknown, addr: string) => Promise<{ balance: bigint } | undefined> } }
  }
}

async function balanceOf(api: ApiShape, chain: ChainId, token: TokenSymbol, addr: string): Promise<bigint> {
  // Native on the home chain; Foreign on the bridged side.
  if (token === 'DOT') {
    if (chain === 'pah') return (await api.query.System.Account.getValue(addr)).data.free
    return (await api.query.ForeignAssets.Account.getValue(DOT_KAH_FOREIGN_LOC, addr))?.balance ?? 0n
  }
  // KSM
  if (chain === 'kah') return (await api.query.System.Account.getValue(addr)).data.free
  return (await api.query.ForeignAssets.Account.getValue(KSM_PAH_FOREIGN_LOC, addr))?.balance ?? 0n
}

interface Route { source: 'pah' | 'kah'; dest: 'pah' | 'kah'; token: TokenSymbol; decimals: number }

// 0.5 of the token in planck. Small enough to leave headroom for fees on the
// pre-funded dev account; large enough to be well above ED.
const HALF = (decimals: number): bigint => 5n * 10n ** BigInt(decimals - 1)

const ROUTES: Route[] = [
  { source: 'pah', dest: 'kah', token: 'DOT', decimals: 10 },
  { source: 'kah', dest: 'pah', token: 'DOT', decimals: 10 },
  { source: 'pah', dest: 'kah', token: 'KSM', decimals: 12 },
  { source: 'kah', dest: 'pah', token: 'KSM', decimals: 12 },
]

describe('relay-token bridge: DOT/KSM across P↔K bridge (both directions)', () => {
  for (const route of ROUTES) {
    const amount = HALF(route.decimals)
    const label = `${route.source.toUpperCase()} → ${route.dest.toUpperCase()} ${route.token}`

    it(`bridges 0.5 ${route.token} ${label}`, async () => {
      const ctx = await setupContext({ source: route.source, preState: 'usdc-and-native' })
      resetTransfer()
      const recipient = ss58For(ctx.account, route.dest === 'pah' ? 0 : 2)

      const params = {
        token: route.token,
        source: route.source as ChainId,
        destination: route.dest as ChainId,
        amount,
        recipient,
      }

      const fees = await estimateFees(params, ctx.account.address)
      if (!fees) {
        const s = getTransferState()
        throw new Error(`estimateFees failed: ${s.step === 'error' ? s.message : 'unknown'}`)
      }
      expect(getTransferState().step).toBe('ready')

      const apiSrc = ctx.clientFor(route.source).getUnsafeApi() as unknown as ApiShape
      const before = await balanceOf(apiSrc, route.source, route.token, ctx.account.address)
      const ok = await executeTransfer(params, ctx.account.signer, ctx.account.address, fees)
      expect(ok).toBe(true)

      // Allow the storage subscriber to catch up after the included block.
      await new Promise((r) => setTimeout(r, 250))
      const after = await balanceOf(apiSrc, route.source, route.token, ctx.account.address)
      expect(before - after).toBeGreaterThanOrEqual(amount)
    })
  }
})
