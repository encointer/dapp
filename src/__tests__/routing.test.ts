import { describe, it, expect } from 'vitest'
import { resolveRoute, getDestinations, detectSource } from '../lib/routing'
import type { BalanceEntry } from '../lib/types'

describe('resolveRoute', () => {
  it('resolves KSM Encointer -> KAH (1 hop)', () => {
    const route = resolveRoute('KSM', 'encointer', 'kah')
    expect(route).toEqual({
      token: 'KSM',
      hops: [{ from: 'encointer', to: 'kah' }],
    })
  })

  it('resolves KSM KAH -> Encointer (1 hop)', () => {
    const route = resolveRoute('KSM', 'kah', 'encointer')
    expect(route).toEqual({
      token: 'KSM',
      hops: [{ from: 'kah', to: 'encointer' }],
    })
  })

  it('resolves KSM KAH -> PAH (1 hop, bridge)', () => {
    const route = resolveRoute('KSM', 'kah', 'pah')
    expect(route).toEqual({
      token: 'KSM',
      hops: [{ from: 'kah', to: 'pah' }],
    })
  })

  it('resolves KSM PAH -> KAH (1 hop, bridge)', () => {
    const route = resolveRoute('KSM', 'pah', 'kah')
    expect(route).toEqual({
      token: 'KSM',
      hops: [{ from: 'pah', to: 'kah' }],
    })
  })

  it('resolves KSM Encointer -> PAH (2 hops)', () => {
    const route = resolveRoute('KSM', 'encointer', 'pah')
    expect(route).toEqual({
      token: 'KSM',
      hops: [
        { from: 'encointer', to: 'kah' },
        { from: 'kah', to: 'pah' },
      ],
    })
  })

  it('resolves KSM PAH -> Encointer (2 hops)', () => {
    const route = resolveRoute('KSM', 'pah', 'encointer')
    expect(route).toEqual({
      token: 'KSM',
      hops: [
        { from: 'pah', to: 'kah' },
        { from: 'kah', to: 'encointer' },
      ],
    })
  })

  it('resolves USDC KAH -> PAH (1 hop)', () => {
    const route = resolveRoute('USDC', 'kah', 'pah')
    expect(route).toEqual({
      token: 'USDC',
      hops: [{ from: 'kah', to: 'pah' }],
    })
  })

  it('resolves USDC PAH -> KAH (1 hop)', () => {
    const route = resolveRoute('USDC', 'pah', 'kah')
    expect(route).toEqual({
      token: 'USDC',
      hops: [{ from: 'pah', to: 'kah' }],
    })
  })

  it('returns same-chain route (single trivial hop) when source == destination', () => {
    const route = resolveRoute('KSM', 'kah', 'kah')
    expect(route).not.toBeNull()
    expect(route?.hops).toEqual([{ from: 'kah', to: 'kah' }])
  })

  it('returns null when source chain does not carry the token', () => {
    expect(resolveRoute('USDC', 'encointer', 'encointer')).toBeNull()
  })

  it('returns null for USDC involving Encointer', () => {
    expect(resolveRoute('USDC', 'encointer', 'kah')).toBeNull()
    expect(resolveRoute('USDC', 'kah', 'encointer')).toBeNull()
  })
})

describe('getDestinations', () => {
  // getDestinations now includes the source chain itself (same-chain transfer
  // to a custom recipient), as well as all cross-chain destinations.
  it('KSM from Encointer -> Encointer, KAH, PAH', () => {
    expect(getDestinations('KSM', 'encointer')).toEqual(['encointer', 'kah', 'pah'])
  })

  it('KSM from KAH -> Encointer, KAH, PAH', () => {
    expect(getDestinations('KSM', 'kah')).toEqual(['encointer', 'kah', 'pah'])
  })

  it('KSM from PAH includes self + KAH + Encointer', () => {
    const dests = getDestinations('KSM', 'pah')
    expect(dests).toContain('kah')
    expect(dests).toContain('encointer')
    expect(dests).toContain('pah')
  })

  it('USDC from KAH -> KAH, PAH', () => {
    expect(getDestinations('USDC', 'kah')).toEqual(['kah', 'pah'])
  })

  it('USDC from PAH -> KAH, PAH', () => {
    expect(getDestinations('USDC', 'pah')).toEqual(['kah', 'pah'])
  })

  it('USDC from Encointer -> empty (encointer has no USDC)', () => {
    expect(getDestinations('USDC', 'encointer')).toEqual([])
  })
})

describe('detectSource', () => {
  it('picks chain with highest transferable balance', () => {
    const balances: BalanceEntry[] = [
      { chain: 'encointer', token: 'KSM', free: 500n, transferable: 400n },
      { chain: 'kah', token: 'KSM', free: 1200n, transferable: 1100n },
      { chain: 'pah', token: 'KSM', free: 100n, transferable: 50n },
    ]
    expect(detectSource('KSM', balances)).toBe('kah')
  })

  it('returns null when no balances', () => {
    expect(detectSource('KSM', [])).toBeNull()
  })

  it('ignores wrong token entries', () => {
    const balances: BalanceEntry[] = [
      { chain: 'kah', token: 'USDC', free: 1000n, transferable: 900n },
    ]
    expect(detectSource('KSM', balances)).toBeNull()
  })
})
