/// <reference types="vite/client" />

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
