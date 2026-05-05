import { AccountId, Binary } from 'polkadot-api'
import { getClient } from './provider.svelte'
import { getTurnoverLastNMonths, getCurrentReputables } from './accountingApi'
import { convertCcToUsd, ksmToUsdc } from './forex'

const ENCOINTER_PARA_ID = 1001
const KSM_SS58_PREFIX = 2

const USDC_FOREIGN_LOCATION = {
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

export interface Faucet {
  account: string
  name: string
  dripAmount: bigint
  whitelist: string[] | null
  freeBalance: bigint
  /** Approximated count of unique persons attested every 10 days who could drip
   *  from this faucet (sum across whitelisted cids; sum across all cids when open). */
  attestedPersons: number
  /** USDC value of one drip — `null` if quote unavailable, undefined while loading. */
  dripUsdc: number | null | undefined
}

export interface Treasury {
  cid: string
  name: string
  /** On-chain community currency symbol (CommunityMetadata.symbol) */
  symbol: string
  encointerAccount: string
  kahAccount: string
  ksmBalance: bigint
  usdcBalance: bigint
  location?: string
  donationsDisabled: boolean
  /** Count of regularly active unique persons (current reputables, fetched from
   *  accounting-backend). `null` once loading completes if unavailable. */
  regularlyActivePersons: number | null
  regularlyActivePersonsLoading: boolean
  /** Total community-currency turnover over the last 3 full calendar months,
   *  fetched from accounting-backend. `null` once loading completes if unavailable. */
  turnoverLast3Months: number | null
  turnoverLoading: boolean
  /** Approximate USDC value of the 3-month turnover, derived via known-community
   *  fiat rates + currency-api USD→fiat. `null` if unknown community or forex failed. */
  turnoverLast3MonthsUsdc: number | null
}

const TREASURY_FIXTURE: Record<string, { name: string; encointerAccount: string; kahAccount: string }> = {
  u0qj944rhWE: {
    name: 'Leu Treasury',
    encointerAccount: 'HNJDzJEGaBgWRXz7bjERsRidJFQBnj1AZ2Tn3Q9uRGynhwq',
    kahAccount: 'DgdA9qwXxBAtdy9veCR4LZpcbYuMgCSL9XpV7gbELFncV2t',
  },
  kygch5kVGq7: {
    name: 'Nyota Treasury',
    encointerAccount: 'E9KVuDLEtBBWSqhCiKn31VPBBLe33CbYJTrnWAbjszwskWH',
    kahAccount: 'G8yWL9B48XnbwC5aYpotqUk7ZTcpP7SGQcykoo7TVQTkhwJ',
  },
  s1vrqQL2SD: {
    name: 'PayNuQ Treasury',
    encointerAccount: 'E2mZ1u2xepTF8nuEQVkrimPVwqtqq1joC56cUwYPftXAEQL',
    kahAccount: 'CqCAXF5M51M7xttMuK47TmyuSos8iusFm524ZzaAZnNiner',
  },
}

const COMMUNITY_INFO: Record<string, { location?: string; donationsDisabled?: boolean }> = {
  u0qj944rhWE: { location: 'Zurich, Switzerland', donationsDisabled: true },
  kygch5kVGq7: { location: 'Dar es Salaam, Tanzania' },
  s1vrqQL2SD: { location: 'Zaria, Nigeria' },
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let num = 0n
  for (const b of bytes) num = num * 256n + BigInt(b)
  let out = ''
  while (num > 0n) {
    out = BASE58_ALPHABET[Number(num % 58n)] + out
    num /= 58n
  }
  return '1'.repeat(zeros) + out
}

const ksmSs58 = AccountId(KSM_SS58_PREFIX)

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Binary) return v.asBytes()
  if (v instanceof Uint8Array) return v
  if (typeof v === 'object' && v !== null && 'asBytes' in v && typeof (v as { asBytes: unknown }).asBytes === 'function') {
    return (v as { asBytes: () => Uint8Array }).asBytes()
  }
  if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)) {
    const hex = v.slice(2)
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  if (Array.isArray(v) && v.every(x => typeof x === 'number')) {
    return new Uint8Array(v as number[])
  }
  const ctor = (v as { constructor?: { name?: string } })?.constructor?.name ?? typeof v
  let sample = ''
  try { sample = JSON.stringify(v)?.slice(0, 200) ?? '' } catch { sample = String(v).slice(0, 200) }
  throw new Error(`not bytes-like: ctor=${ctor} sample=${sample}`)
}

function cidToString(cid: { geohash: unknown; digest: unknown }): string {
  const geohashStr = new TextDecoder().decode(asBytes(cid.geohash))
  return geohashStr + encodeBase58(asBytes(cid.digest))
}

function accountFromKey(arg: unknown): string {
  if (typeof arg === 'string') return arg
  return ksmSs58.dec(asBytes(arg))
}

function ss58ToBytes(ss58: string): Uint8Array {
  return ksmSs58.enc(ss58)
}

function accountToSs58AndBytes(v: unknown): { ss58: string; bytes: Uint8Array } {
  if (typeof v === 'string') return { ss58: v, bytes: ss58ToBytes(v) }
  const bytes = asBytes(v)
  return { ss58: ksmSs58.dec(bytes), bytes }
}

let faucets = $state<Faucet[]>([])
let treasuries = $state<Treasury[]>([])
let loading = $state(false)
let lastError = $state<string | null>(null)
let loadedOnce = $state(false)
let selected = $state<Set<string>>(new Set())

interface UnsafeApi {
  query: Record<string, Record<string, {
    getValue: (...args: unknown[]) => Promise<unknown>
    getEntries: () => Promise<Array<{ keyArgs: unknown[]; value: unknown }>>
  }>>
  apis: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
}

/**
 * Returns expected new reputations issued per ceremony cycle (≈ 10 days) per cid.
 * This is the attendance of the most recent fully-attested ceremony per cid:
 * each new reputation = one fresh, unspent drip permission. We walk cindices
 * from newest to oldest within the reputation-lifetime window and pick the
 * first non-zero count (skips the in-progress cindex if rewards haven't been
 * issued yet).
 */
async function loadReputablesByCid(
  encApi: UnsafeApi,
  cidsRaw: Array<{ geohash: unknown; digest: unknown }>,
): Promise<Map<string, number>> {
  const lifetimeRaw = await encApi.query.EncointerCeremonies.ReputationLifetime.getValue() as bigint | number
  const currentRaw = await encApi.query.EncointerScheduler.CurrentCeremonyIndex.getValue() as bigint | number
  const lifetime = Number(lifetimeRaw)
  const current = Number(currentRaw)
  const minC = Math.max(1, current - lifetime + 1)

  const out = new Map<string, number>()
  for (const cidObj of cidsRaw) {
    const cidStr = cidToString(cidObj)
    const queries: Array<Promise<unknown>> = []
    for (let c = minC; c <= current; c++) {
      queries.push(encApi.query.EncointerCeremonies.ReputationCount.getValue([cidObj, c]))
    }
    let latestNonZero = 0
    try {
      const counts = await Promise.all(queries)
      // queries[i] corresponds to cindex (minC + i); iterate newest → oldest
      for (let i = counts.length - 1; i >= 0; i--) {
        const v = counts[i]
        const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0)
        if (n > 0) { latestNonZero = n; break }
      }
    } catch (err) {
      console.warn(`[recipients] reputation count query failed for ${cidStr}`, err)
    }
    out.set(cidStr, latestNonZero)
  }
  return out
}

async function loadFaucets(encApi: UnsafeApi, reputablesByCid: Map<string, number>): Promise<Faucet[]> {
  const entries = await encApi.query.EncointerFaucet.Faucets.getEntries()
  const totalAcrossAllCids = [...reputablesByCid.values()].reduce((a, b) => a + b, 0)
  const result: Faucet[] = []
  for (const entry of entries) {
    const account = accountFromKey(entry.keyArgs[0])
    const f = entry.value as {
      name: unknown
      whitelist: Array<{ geohash: unknown; digest: unknown }> | null | undefined
      drip_amount: bigint
    }
    const name = new TextDecoder().decode(asBytes(f.name))
    const whitelist = f.whitelist != null ? f.whitelist.map(cidToString) : null
    let freeBalance = 0n
    try {
      const acc = await encApi.query.System.Account.getValue(account) as {
        data: { free: bigint }
      }
      freeBalance = acc.data.free
    } catch (err) {
      console.warn(`[recipients] system.account failed for faucet ${name}`, err)
    }
    const attestedPersons = whitelist == null
      ? totalAcrossAllCids
      : whitelist.reduce((s, c) => s + (reputablesByCid.get(c) ?? 0), 0)
    result.push({
      account, name, dripAmount: f.drip_amount, whitelist, freeBalance, attestedPersons,
      dripUsdc: undefined,
    })
  }
  return result
}

async function callTreasuriesApi(encApi: UnsafeApi, cidObj: unknown): Promise<unknown> {
  const candidates = ['TreasuriesApi', 'EncointerTreasuriesApi']
  let lastErr: unknown
  for (const apiName of candidates) {
    const api = encApi.apis[apiName]
    if (!api?.get_community_treasury_account_unchecked) continue
    try {
      return await api.get_community_treasury_account_unchecked(cidObj)
    } catch (err) {
      lastErr = err
    }
  }
  if (lastErr) throw lastErr
  throw new Error(`No matching runtime API among: ${candidates.join(', ')}. Available: ${Object.keys(encApi.apis ?? {}).join(', ')}`)
}

async function deriveKahAccount(kahApi: UnsafeApi, treasuryBytes: Uint8Array): Promise<string | null> {
  const versions = ['V5', 'V4', 'V3'] as const
  for (const v of versions) {
    const versionedLoc = {
      type: v,
      value: {
        parents: 1,
        interior: {
          type: 'X2',
          value: [
            { type: 'Parachain', value: ENCOINTER_PARA_ID },
            { type: 'AccountId32', value: { network: undefined, id: Binary.fromBytes(treasuryBytes) } },
          ],
        },
      },
    }
    try {
      const result = await kahApi.apis.LocationToAccountApi.convert_location(versionedLoc) as
        | { success: true; value: unknown }
        | { success: false; value: unknown }
      if (result.success) {
        return accountFromKey(result.value)
      }
    } catch {
      // try lower version
    }
  }
  return null
}

async function loadTreasuries(
  encApi: UnsafeApi,
  kahApi: UnsafeApi,
  cidsRaw: Array<{ geohash: unknown; digest: unknown }>,
): Promise<Treasury[]> {
  const metaEntries = await encApi.query.EncointerCommunities.CommunityMetadata.getEntries()
  const nameByCid = new Map<string, string>()
  const symbolByCid = new Map<string, string>()
  for (const entry of metaEntries) {
    const cidStr = cidToString(entry.keyArgs[0] as { geohash: unknown; digest: unknown })
    const meta = entry.value as { name: unknown; symbol: unknown }
    nameByCid.set(cidStr, new TextDecoder().decode(asBytes(meta.name)))
    try {
      symbolByCid.set(cidStr, new TextDecoder().decode(asBytes(meta.symbol)))
    } catch {
      // missing symbol — leave unset
    }
  }

  const result: Treasury[] = []
  for (const cidObj of cidsRaw) {
    const cidStr = cidToString(cidObj)

    const treasuryRaw = await callTreasuriesApi(encApi, cidObj)
    const { ss58: encointerAccount, bytes: treasuryBytes } = accountToSs58AndBytes(treasuryRaw)

    const kahAccount = await deriveKahAccount(kahApi, treasuryBytes) ?? ''

    let ksmBalance = 0n
    try {
      const acc = await encApi.query.System.Account.getValue(encointerAccount) as {
        data: { free: bigint }
      }
      ksmBalance = acc.data.free
    } catch (err) {
      console.warn(`[recipients] KSM balance query failed for ${cidStr}`, err)
    }

    let usdcBalance = 0n
    if (kahAccount) {
      try {
        const fa = await kahApi.query.ForeignAssets.Account.getValue(USDC_FOREIGN_LOCATION, kahAccount) as
          | { balance: bigint }
          | undefined
        usdcBalance = fa?.balance ?? 0n
      } catch (err) {
        console.warn(`[recipients] USDC balance query failed for ${cidStr}`, err)
      }
    }

    const fixture = TREASURY_FIXTURE[cidStr]
    if (fixture && (fixture.encointerAccount !== encointerAccount || fixture.kahAccount !== kahAccount)) {
      console.warn(`[recipients] fixture mismatch for ${cidStr}`, {
        expected: fixture, got: { encointerAccount, kahAccount },
      })
    }

    const info = COMMUNITY_INFO[cidStr] ?? {}
    result.push({
      cid: cidStr,
      name: nameByCid.get(cidStr) ?? cidStr,
      symbol: symbolByCid.get(cidStr) ?? '',
      encointerAccount,
      kahAccount,
      ksmBalance,
      usdcBalance,
      location: info.location,
      donationsDisabled: info.donationsDisabled ?? false,
      regularlyActivePersons: null,
      regularlyActivePersonsLoading: true,
      turnoverLast3Months: null,
      turnoverLoading: true,
      turnoverLast3MonthsUsdc: null,
    })
  }
  return result
}

async function fetchFaucetDripUsdcInto(account: string, dripAmount: bigint) {
  const usdc = await ksmToUsdc(dripAmount)
  const f = faucets.find(x => x.account === account)
  if (f) f.dripUsdc = usdc
}

async function fetchRegularlyActiveInto(cid: string) {
  const n = await getCurrentReputables(cid)
  const t = treasuries.find(x => x.cid === cid)
  if (t) {
    t.regularlyActivePersons = n
    t.regularlyActivePersonsLoading = false
  }
}

async function fetchTurnoverInto(cid: string) {
  const v = await getTurnoverLastNMonths(cid, 3)
  const t = treasuries.find(x => x.cid === cid)
  if (!t) return
  t.turnoverLast3Months = v
  t.turnoverLoading = false
  if (v !== null && v > 0 && t.symbol) {
    const usdc = await convertCcToUsd(t.symbol, v)
    const after = treasuries.find(x => x.cid === cid)
    if (after) after.turnoverLast3MonthsUsdc = usdc
  }
}

export async function loadRecipients() {
  const encClient = getClient('encointer')
  const kahClient = getClient('kah')
  if (!encClient || !kahClient) {
    lastError = 'Not connected to chains'
    return
  }
  loading = true
  lastError = null
  try {
    const encApi = encClient.getUnsafeApi() as unknown as UnsafeApi
    const kahApi = kahClient.getUnsafeApi() as unknown as UnsafeApi
    const cidsRaw = await encApi.query.EncointerCommunities.CommunityIdentifiers.getValue() as Array<{
      geohash: unknown
      digest: unknown
    }>
    let reputablesByCid = new Map<string, number>()
    try {
      reputablesByCid = await loadReputablesByCid(encApi, cidsRaw)
    } catch (err) {
      console.warn('[recipients] reputables load failed; faucets will show 0', errMsg(err), err)
    }
    let f: Faucet[] = []
    let t: Treasury[] = []
    try {
      f = await loadFaucets(encApi, reputablesByCid)
    } catch (err) {
      console.error('[recipients] loadFaucets threw:', errMsg(err), err)
      throw new Error(`loadFaucets: ${errMsg(err)}`)
    }
    try {
      t = await loadTreasuries(encApi, kahApi, cidsRaw)
    } catch (err) {
      console.error('[recipients] loadTreasuries threw:', errMsg(err), err)
      throw new Error(`loadTreasuries: ${errMsg(err)}`)
    }
    faucets = f
    treasuries = t
    loadedOnce = true
    // Fire turnover + reputables + KSM/USDC quote fetches in parallel; mutate entries as they land.
    for (const tr of treasuries) {
      void fetchTurnoverInto(tr.cid)
      void fetchRegularlyActiveInto(tr.cid)
    }
    for (const fc of faucets) {
      void fetchFaucetDripUsdcInto(fc.account, fc.dripAmount)
    }
  } catch (err) {
    lastError = errMsg(err)
    console.error('[recipients] load failed:', errMsg(err), err)
  } finally {
    loading = false
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

export function getFaucets(): Faucet[] { return faucets }
export function getTreasuries(): Treasury[] { return treasuries }
export function isLoadingRecipients(): boolean { return loading }
export function getRecipientsError(): string | null { return lastError }
export function isRecipientsLoaded(): boolean { return loadedOnce }

export function isSelected(id: string): boolean { return selected.has(id) }

export function toggleSelected(id: string) {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected = next
}

export function clearSelection() { selected = new Set() }

export function getSelectedIds(): string[] { return [...selected] }

export function selectionCount(): number { return selected.size }

export function selectAll(ids: string[]) { selected = new Set(ids) }
