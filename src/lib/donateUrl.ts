import type { ChainId, TokenSymbol } from './types'
import { ALLOWED_SOURCES } from './donate.svelte'

export interface DonateUrlParams {
  token?: TokenSymbol
  source?: ChainId
  amount?: string
  /**
   * Recipient identifiers. Interpretation depends on token:
   *   - USDC: list of cids (community identifiers, base58 like "u0qj944rhWE")
   *   - KSM:  list of faucet account SS58 addresses OR faucet names (matched case-insensitively)
   */
  recipients?: string[]
}

/**
 * Parse `?asset=...&source=...&amount=...&recipients=cid1,cid2` from the URL hash.
 * The hash may carry a route prefix (e.g. `#donate?asset=USDC...`); we read
 * everything after the first `?`.
 */
export function parseDonateUrlParams(hash: string = window.location.hash): DonateUrlParams {
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return {}
  const sp = new URLSearchParams(hash.slice(qIdx + 1))
  const out: DonateUrlParams = {}

  const asset = sp.get('asset')?.toUpperCase()
  if (asset === 'KSM' || asset === 'USDC') out.token = asset

  const source = sp.get('source')?.toLowerCase()
  const validChain = source === 'encointer' || source === 'kah' || source === 'pah'
  if (validChain) {
    if (out.token) {
      // Asset known: only accept source if compatible.
      if (ALLOWED_SOURCES[out.token].includes(source as ChainId)) out.source = source as ChainId
    } else {
      // Asset unknown: accept the source and try to infer the asset from it
      // (pah → USDC; encointer → KSM; kah is ambiguous, leave asset to default).
      out.source = source as ChainId
      const candidates = (['KSM', 'USDC'] as TokenSymbol[])
        .filter(t => ALLOWED_SOURCES[t].includes(source as ChainId))
      if (candidates.length === 1) out.token = candidates[0]
    }
  }

  const amount = sp.get('amount')?.trim()
  if (amount && /^\d+\.?\d*$/.test(amount)) out.amount = amount

  const recipients = sp.get('recipients')
  if (recipients) {
    const parts = recipients.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length > 0) out.recipients = parts
  }

  return out
}

/** Strip the hash route prefix (e.g. "#donate") to get just the route name. */
export function routeFromHash(hash: string = window.location.hash): string {
  const qIdx = hash.indexOf('?')
  return qIdx < 0 ? hash : hash.slice(0, qIdx)
}
