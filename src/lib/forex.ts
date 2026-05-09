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
      if (!res.ok) {
        console.warn(`[forex] usd.json @ ${base} → HTTP ${res.status}`)
        continue
      }
      const data = await res.json() as { usd?: Record<string, number> }
      const rate = data.usd?.[target]
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
        console.log(`[forex] USD/${target.toUpperCase()} = ${rate} (source: ${base})`)
        return rate
      }
      console.warn(`[forex] usd.json @ ${base} missing or invalid rate for ${target}`)
    } catch (err) {
      console.warn(`[forex] usd.json fetch failed at ${base}`, err)
    }
  }
  console.warn(`[forex] giving up on USD/${target.toUpperCase()}: all sources failed`)
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
  if (!k) {
    console.log(`[forex] convertCcToUsd: unknown community symbol "${symbol}"; returning null`)
    return null
  }
  const usdToFiat = await cachedUsdToFiat(k.fiat)
  if (usdToFiat == null) return null
  const ccPerUsd = k.localFiatRate * usdToFiat
  if (ccPerUsd <= 0) return null
  const usd = ccAmount / ccPerUsd
  console.log(`[forex] CC→USD: ${ccAmount.toFixed(2)} ${symbol} × (1 USD = ${ccPerUsd.toFixed(4)} ${symbol}) = ${usd.toFixed(2)} USD`)
  return usd
}

/** Inverse of convertCcToUsd: USD amount → CC equivalent for the given symbol. */
export async function convertUsdToCc(symbol: string, usdAmount: number): Promise<number | null> {
  const k = KNOWN_COMMUNITIES[symbol.toUpperCase()]
  if (!k) {
    console.log(`[forex] convertUsdToCc: unknown community symbol "${symbol}"; returning null`)
    return null
  }
  const usdToFiat = await cachedUsdToFiat(k.fiat)
  if (usdToFiat == null) return null
  const cc = usdAmount * k.localFiatRate * usdToFiat
  console.log(`[forex] USD→CC: ${usdAmount.toFixed(2)} USD × ${k.localFiatRate} × ${usdToFiat.toFixed(4)} = ${cc.toFixed(2)} ${symbol}`)
  return cc
}

// USDC per 1 KSM (live quote via KAH AssetConversion pool). Cached for the
// session; refreshed if the call is retried after a null result.
//
// Locations are in PAPI-normalized {type, value} form (matches the shape
// recipients.svelte.ts already uses successfully for ForeignAssets queries).
const KSM_LOCATION = {
  parents: 1,
  interior: { type: 'Here', value: undefined },
}
const USDC_KAH_LOCATION = {
  parents: 2,
  interior: {
    type: 'X4',
    value: [
      { type: 'GlobalConsensus', value: { type: 'Polkadot', value: undefined } },
      { type: 'Parachain', value: 1000 },
      { type: 'PalletInstance', value: 50 },
      { type: 'GeneralIndex', value: 1337n },
    ],
  },
}
let ksmUsdcRatePromise: Promise<number | null> | null = null

async function fetchKsmUsdcRate(): Promise<number | null> {
  const kahClient = getClient('kah')
  if (!kahClient) {
    console.warn('[forex] KSM/USDC quote: KAH client not connected')
    return null
  }
  try {
    const api = kahClient.getUnsafeApi() as unknown as {
      apis: { AssetConversionApi: { quote_price_exact_tokens_for_tokens: (a: unknown, b: unknown, amt: bigint, includeFee: boolean) => Promise<bigint | null | undefined> } }
    }
    const oneKsm = 10n ** 12n
    const result = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
      KSM_LOCATION, USDC_KAH_LOCATION, oneKsm, true,
    )
    if (result == null) {
      console.warn('[forex] KSM/USDC quote: pool returned null (no liquidity?)')
      return null
    }
    const rate = Number(BigInt(result)) / 1e6
    console.log(`[forex] KSM/USDC pool quote: 1 KSM = ${rate.toFixed(4)} USDC (KAH AssetConversion)`)
    return rate
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
  const ksmFloat = Number(ksmAmount) / 1e12
  const usdc = ksmFloat * rate
  console.log(`[forex] KSM→USDC: ${ksmFloat.toFixed(6)} KSM × ${rate.toFixed(4)} USDC/KSM = ${usdc.toFixed(4)} USDC`)
  return usdc
}

/**
 * Quote how many base-units of USDC the user needs to swap on the source chain's
 * AssetConversion pool to receive exactly `nativeAmount` of the chain's native
 * asset (DOT on PAH, KSM on KAH). Reflects the actual AMM result including pool
 * fees. Returns null if the chain isn't connected, the pool is unreachable, or
 * the source isn't an asset hub.
 */
export async function quoteUsdcForExactNative(
  source: 'pah' | 'kah',
  nativeAmount: bigint,
): Promise<bigint | null> {
  const client = getClient(source)
  if (!client) {
    console.warn(`[forex] AMM quote: ${source} client not connected`)
    return null
  }
  // Bare `Location` (the AssetConversionApi takes Location, not Versioned).
  const nativeLoc = { parents: 1, interior: { type: 'Here', value: undefined } }
  const usdcLoc = source === 'pah'
    ? {
      parents: 0,
      interior: {
        type: 'X2',
        value: [
          { type: 'PalletInstance', value: 50 },
          { type: 'GeneralIndex', value: 1337n },
        ],
      },
    }
    : {
      parents: 2,
      interior: {
        type: 'X4',
        value: [
          { type: 'GlobalConsensus', value: { type: 'Polkadot', value: undefined } },
          { type: 'Parachain', value: 1000 },
          { type: 'PalletInstance', value: 50 },
          { type: 'GeneralIndex', value: 1337n },
        ],
      },
    }
  try {
    const api = client.getUnsafeApi() as unknown as {
      apis: { AssetConversionApi: {
        quote_price_tokens_for_exact_tokens: (a: unknown, b: unknown, amt: bigint, includeFee: boolean) => Promise<bigint | null | undefined>
      } }
    }
    const result = await api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
      usdcLoc, nativeLoc, nativeAmount, true,
    )
    if (result == null) {
      console.warn(`[forex] AMM quote (${source}): pool returned null for ${nativeAmount} native`)
      return null
    }
    const usdcBase = BigInt(result)
    const nativeDec = source === 'pah' ? 10 : 12
    const nativeSym = source === 'pah' ? 'DOT' : 'KSM'
    console.log(`[forex] AMM quote @ ${source}: ${(Number(nativeAmount) / 10 ** nativeDec).toFixed(6)} ${nativeSym} costs ${(Number(usdcBase) / 1e6).toFixed(6)} USDC (incl. pool fees)`)
    return usdcBase
  } catch (err) {
    console.warn(`[forex] AMM quote (${source}) failed`, err)
    return null
  }
}
