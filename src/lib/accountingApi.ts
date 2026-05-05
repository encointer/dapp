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
