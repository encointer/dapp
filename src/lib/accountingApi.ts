/// <reference types="vite/client" />

const API_URL = (import.meta.env.VITE_ACCOUNTING_API_URL as string | undefined) ?? 'https://api.encointer.org/v1'

interface VolumeReport {
  data: Record<string, number>
  communityName: string
  year: number
}

async function getVolumeReport(cid: string, year: number): Promise<VolumeReport | null> {
  try {
    const url = `${API_URL}/accounting/volume-report?cid=${encodeURIComponent(cid)}&year=${year}`
    const res = await fetch(url, { credentials: 'omit' })
    if (!res.ok) {
      console.warn(`[accounting] volume-report ${cid} ${year} → ${res.status}`)
      return null
    }
    return await res.json() as VolumeReport
  } catch (err) {
    console.warn(`[accounting] volume-report ${cid} ${year} fetch failed`, err)
    return null
  }
}

/**
 * Returns the (year, month) pairs for the last `n` fully-completed calendar months
 * before `now` (UTC). Most recent first.
 */
export function lastFullMonths(n: number, now: Date = new Date()): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = []
  let y = now.getUTCFullYear()
  let m = now.getUTCMonth() - 1 // last full month
  for (let i = 0; i < n; i++) {
    if (m < 0) { m = 11; y -= 1 }
    out.push({ year: y, month: m })
    m -= 1
  }
  return out
}

interface ReputablesByCindexResponse {
  data: Record<string, number>
  communityName: string
}

/**
 * Returns the most recent (highest cindex) reputables count for a community.
 * Backed by /v1/accounting/reputables-by-cindex which computes the union of
 * accounts that earned reputation within the current reputation lifetime.
 * Returns null on fetch failure or if the community has no reputables.
 */
export async function getCurrentReputables(cid: string): Promise<number | null> {
  try {
    const url = `${API_URL}/accounting/reputables-by-cindex?cid=${encodeURIComponent(cid)}`
    const res = await fetch(url, { credentials: 'omit' })
    if (!res.ok) {
      console.warn(`[accounting] reputables-by-cindex ${cid} → ${res.status}`)
      return null
    }
    const body = await res.json() as ReputablesByCindexResponse
    const cindices = Object.keys(body.data ?? {}).map(Number).filter(Number.isFinite)
    if (cindices.length === 0) return 0
    const latest = Math.max(...cindices)
    const v = body.data[String(latest)]
    return typeof v === 'number' ? v : null
  } catch (err) {
    console.warn(`[accounting] reputables-by-cindex ${cid} fetch failed`, err)
    return null
  }
}

export interface LeaderboardDonor {
  ss58: string
  count: number
  /** Bigint as string (planck-level, before applying decimals). */
  totalRaw: string
}
export interface LeaderboardUnidentified {
  timestamp: number
  amountRaw: string
}
export interface AggregateLeaderboard {
  token: 'USDC' | 'KSM'
  decimals: number
  totalInflowsRaw: string
  totalOutflowsRaw: string
  donors: LeaderboardDonor[]
  crossChainUnidentified: LeaderboardUnidentified[]
}

/** Aggregate donor leaderboard for the given token across every recipient
 *  (USDC across treasuries, KSM across faucets). */
export async function getAggregateLeaderboard(token: 'USDC' | 'KSM'): Promise<AggregateLeaderboard | null> {
  try {
    const res = await fetch(`${API_URL}/leaderboard?token=${token}`, { credentials: 'omit' })
    if (!res.ok) {
      console.warn(`[accounting] leaderboard ${token} → ${res.status}`)
      return null
    }
    return await res.json() as AggregateLeaderboard
  } catch (err) {
    console.warn(`[accounting] leaderboard ${token} fetch failed`, err)
    return null
  }
}

/**
 * Sum the community-currency volume across the last `n` full calendar months.
 * Returns null on any fetch failure (treated as "no data").
 */
export async function getTurnoverLastNMonths(cid: string, n: number): Promise<number | null> {
  const months = lastFullMonths(n)
  const years = [...new Set(months.map(m => m.year))]
  const reports = await Promise.all(years.map(y => getVolumeReport(cid, y)))
  const reportsByYear = new Map<number, VolumeReport | null>()
  years.forEach((y, i) => reportsByYear.set(y, reports[i]))

  let total = 0
  let any = false
  for (const { year, month } of months) {
    const r = reportsByYear.get(year)
    if (!r) continue
    const v = r.data[String(month)]
    if (typeof v === 'number') {
      total += v
      any = true
    }
  }
  return any ? total : null
}
