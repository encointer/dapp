/// <reference types="vite/client" />

import { getClient } from './provider.svelte'

// Hard-coded CC→local-fiat rates for known communities.
// Mirrors encointer-wallet-flutter app/lib/service/forex/known_community.dart
// (markup not applied — we want approximate turnover, not buy/sell quotes).
//
// localFiatRate = CC per 1 unit of local fiat.
// e.g. NYT { fiat: 'tzs', localFiatRate: 0.001 } means 0.001 NYT per TZS,
// i.e. 1 NYT = 1000 TZS.
type FiatCode = 'chf' | 'tzs' | 'ngn' | 'eur'

const KNOWN_COMMUNITIES: Record<string, { fiat: FiatCode; localFiatRate: number }> = {
  LEU: { fiat: 'chf', localFiatRate: 1 },
  NYT: { fiat: 'tzs', localFiatRate: 0.001 },
  PNQ: { fiat: 'ngn', localFiatRate: 0.001 },
  MTA: { fiat: 'eur', localFiatRate: 2 },
}

// Same currency-api endpoints the flutter wallet uses.
const FOREX_PRIMARY = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies'
const FOREX_FALLBACK = 'https://cdn.statically.io/gh/fawazahmed0/exchange-api/latest/v1/currencies'

// Cache USD→fiat rates per session. The flutter wallet caches for 1 day on
// disk; for the dapp's short-lived sessions, in-memory is enough.
const usdToFiatCache = new Map<FiatCode, Promise<number | null>>()

async function fetchUsdToFiat(target: FiatCode): Promise<number | null> {
  for (const base of [FOREX_PRIMARY, FOREX_FALLBACK]) {
    try {
      const res = await fetch(`${base}/usd.json`)
      if (!res.ok) continue
      const data = await res.json() as { usd?: Record<string, number> }
      const rate = data.usd?.[target]
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) return rate
    } catch (err) {
      console.warn(`[forex] usd.json fetch failed at ${base}`, err)
    }
  }
  return null
}

function cachedUsdToFiat(target: FiatCode): Promise<number | null> {
  let p = usdToFiatCache.get(target)
  if (!p) {
    p = fetchUsdToFiat(target)
    usdToFiatCache.set(target, p)
  }
  return p
}

/**
 * Approximate USD value of `ccAmount` in community currency `symbol`.
 * Returns `null` for unknown communities or if the forex fetch fails.
 */
export async function convertCcToUsd(symbol: string, ccAmount: number): Promise<number | null> {
  const k = KNOWN_COMMUNITIES[symbol.toUpperCase()]
  if (!k) return null
  const usdToFiat = await cachedUsdToFiat(k.fiat)
  if (usdToFiat == null) return null
  // ccPerUsd = (CC / fiat) * (fiat / USD)
  const ccPerUsd = k.localFiatRate * usdToFiat
  if (ccPerUsd <= 0) return null
  return ccAmount / ccPerUsd
}

// USDC per 1 KSM (live quote via KAH AssetConversion pool). Cached for the
// session; refreshed if the call is retried after a null result.
const KSM_LOCATION = { parents: 1, interior: 'Here' }
const USDC_KAH_LOCATION = {
  parents: 2,
  interior: {
    X4: [
      { GlobalConsensus: { Polkadot: null } },
      { Parachain: 1000 },
      { PalletInstance: 50 },
      { GeneralIndex: 1337 },
    ],
  },
}
let ksmUsdcRatePromise: Promise<number | null> | null = null

async function fetchKsmUsdcRate(): Promise<number | null> {
  const kahClient = getClient('kah')
  if (!kahClient) return null
  try {
    const api = kahClient.getUnsafeApi() as unknown as {
      apis: { AssetConversionApi: { quote_price_exact_tokens_for_tokens: (a: unknown, b: unknown, amt: bigint, includeFee: boolean) => Promise<bigint | null | undefined> } }
    }
    const oneKsm = 10n ** 12n
    const result = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
      KSM_LOCATION, USDC_KAH_LOCATION, oneKsm, true,
    )
    if (result == null) return null
    // USDC has 6 decimals.
    return Number(BigInt(result)) / 1e6
  } catch (err) {
    console.warn('[forex] KSM/USDC quote failed', err)
    return null
  }
}

export function getKsmUsdcRate(): Promise<number | null> {
  if (!ksmUsdcRatePromise) {
    ksmUsdcRatePromise = fetchKsmUsdcRate().then(r => {
      // If the fetch fails, allow a future retry.
      if (r == null) ksmUsdcRatePromise = null
      return r
    })
  }
  return ksmUsdcRatePromise
}

/**
 * Approximate USDC value of a KSM amount (12 decimals). Returns null if the
 * AssetConversion pool isn't reachable.
 */
export async function ksmToUsdc(ksmAmount: bigint): Promise<number | null> {
  const rate = await getKsmUsdcRate()
  if (rate == null) return null
  return (Number(ksmAmount) / 1e12) * rate
}
