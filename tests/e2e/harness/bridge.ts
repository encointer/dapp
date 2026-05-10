import { createClient } from 'polkadot-api'
import { getWsProvider } from 'polkadot-api/ws'
import type { PolkadotClient } from 'polkadot-api'
import { WS_URL } from './ports'
import type { ChainId } from '../../../src/lib/types'

/**
 * Forward the bridge XCM emitted by a `transfer_assets_using_type_and_then`
 * dispatch on `source` to the corresponding chopsticks instance for `dest`.
 *
 * Chopsticks auto-forwards HRMP between siblings under the same XCM-mode
 * invocation, but cross-consensus (PAH↔KAH via bridge-hubs) is not auto-
 * handled — we run two separate chopsticks XCM instances. This helper bridges
 * the gap.
 *
 * Approach: locate the source chain's emitted forwarded XCM (the inbound
 * message that would have been delivered to the destination via a real
 * bridge) and run `XcmDryRunApi.dry_run_xcm` on the destination chopsticks
 * to verify it would execute. This matches the dapp's own `dryRunFull`
 * approach in `donate.svelte.ts` and is sufficient to validate that
 *   (a) the bridge message is well-formed,
 *   (b) the destination's transactor accepts the assets.
 *
 * It does NOT mutate destination state — there's no public chopsticks RPC for
 * that. If end-to-end balance assertions on the destination side are needed,
 * the test should fall back to inspecting the dry-run's emitted_events
 * (`BalancesDeposited`, `ForeignAssets.Issued`, etc.) instead of querying
 * destination storage. See the TODO at the bottom of this file.
 */
export interface BridgeForwardResult {
  /** True if the source-side dispatch produced a forwarded XCM at all. */
  forwarded: boolean
  /** True if the destination's dry-run executed Complete. */
  destOk: boolean
  /** Raw destination-side dry-run result for tests to inspect (events,
   *  outcome, weight, etc.). */
  destResult: unknown
  /** Error message when something went wrong. */
  message?: string
}

const RELAY_FROM_PARA: Record<ChainId, 'Polkadot' | 'Kusama'> = {
  pah: 'Polkadot',
  kah: 'Kusama',
  encointer: 'Kusama',
}

/** Origin location for the destination's `dry_run_xcm` call: the
 *  GlobalConsensus(<source-relay>) / Parachain(1000) ancestor of the bridge
 *  message. Mirrors `originLocationFromTo` in `donate.svelte.ts`. */
function originLocFor(source: ChainId, dest: ChainId): unknown | null {
  const sourceRelay = RELAY_FROM_PARA[source]
  const destRelay = RELAY_FROM_PARA[dest]
  if (sourceRelay === destRelay) return null // sibling, not bridge
  return {
    type: 'V5',
    value: {
      parents: 2,
      interior: {
        type: 'X2',
        value: [
          { type: 'GlobalConsensus', value: { type: sourceRelay } },
          { type: 'Parachain', value: 1000 },
        ],
      },
    },
  }
}

/** Find the bridge-bound XCM emitted at the source. After
 *  `transfer_assets_using_type_and_then` runs locally, a forwarded XCM is
 *  recorded in the chain's `messageQueue` outbound. We dry-run the call
 *  shape from the captured events and return its `forwarded_xcms`. */
export async function dryRunForwarding(
  sourceCall: unknown,
  source: ChainId,
  senderAddress: string,
  dest: ChainId,
): Promise<BridgeForwardResult> {
  const sourceClient = createClient(getWsProvider(WS_URL[source as 'pah' | 'kah' | 'encointer']))
  const destClient = createClient(getWsProvider(WS_URL[dest as 'pah' | 'kah' | 'encointer']))
  try {
    const sourceApi = sourceClient.getUnsafeApi() as unknown as ApiShape
    const destApi = destClient.getUnsafeApi() as unknown as ApiShape

    // 1. Dry-run on source to capture forwarded_xcms.
    const origin = { type: 'system', value: { type: 'Signed', value: senderAddress } }
    const src = await sourceApi.apis.DryRunApi.dry_run_call(origin, sourceCall, 5) as
      | { success: boolean; value: unknown }
    if (!src.success) {
      return { forwarded: false, destOk: false, destResult: src.value, message: 'source dry-run failed' }
    }
    const result = src.value as { forwarded_xcms?: Array<[unknown, unknown[]]> }
    const forwarded = result.forwarded_xcms ?? []

    // 2. Find the XCM aimed at the destination's relay (for cross-consensus
    //    bridge messages it's wrapped in `(parents=2, X1[GlobalConsensus(...)])`).
    const destOrigin = originLocFor(dest, source) // origin OF the message at the dest = "from this consensus"
    if (!destOrigin) {
      return { forwarded: false, destOk: true, destResult: null, message: 'siblings — chopsticks forwards automatically' }
    }
    const xcms: unknown[] = []
    for (const [, msgs] of forwarded) {
      for (const m of msgs) xcms.push(m)
    }
    if (xcms.length === 0) {
      return { forwarded: false, destOk: false, destResult: null, message: 'no forwarded xcms emitted' }
    }

    // 3. Dry-run the first forwarded XCM at the destination.
    const xcm = xcms[0]
    const dr = await destApi.apis.DryRunApi.dry_run_xcm(destOrigin, xcm) as
      | { success: boolean; value: { execution_result: { type: string; value: unknown }; emitted_events: unknown[] } }
    const okOutcome = dr.success && dr.value.execution_result.type === 'Complete'
    return {
      forwarded: true,
      destOk: okOutcome,
      destResult: dr.value,
      message: okOutcome ? undefined : `destination outcome ${dr.value?.execution_result?.type ?? 'unknown'}`,
    }
  } finally {
    sourceClient.destroy()
    destClient.destroy()
  }
}

interface ApiShape {
  apis: {
    DryRunApi: {
      dry_run_call: (origin: unknown, call: unknown, version: number) => Promise<unknown>
      dry_run_xcm: (origin: unknown, xcm: unknown) => Promise<unknown>
    }
  }
}

// TODO: implement actual destination-state mutation by injecting the bridge
// XCM into the destination's MessageQueue via dev_setStorage. Today's tests
// fall back to dry-run-based assertions on the destination side (read events
// returned by `dry_run_xcm` rather than destination storage). Tracked
// upstream: https://github.com/AcalaNetwork/chopsticks/issues/?q=bridge

/** Re-export for tests that just want a typed handle. */
export function destClient(dest: ChainId): PolkadotClient {
  return createClient(getWsProvider(WS_URL[dest as 'pah' | 'kah' | 'encointer']))
}
