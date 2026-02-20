import { describe, it, expect } from 'vitest'
import { getChain, chainHasToken, getDecimals, toParaSpell, CHAINS, CHAIN_IDS } from '../lib/chains'

describe('chains', () => {
  it('has 3 chains configured', () => {
    expect(CHAIN_IDS).toHaveLength(3)
    expect(CHAIN_IDS).toEqual(['encointer', 'kah', 'pah'])
  })

  it('getChain returns correct config', () => {
    const enc = getChain('encointer')
    expect(enc.name).toBe('Encointer')
    expect(enc.paraSpellName).toBe('Encointer')
    expect(enc.tokens).toHaveLength(1)
    expect(enc.tokens[0].symbol).toBe('KSM')
  })

  it('chainHasToken works correctly', () => {
    expect(chainHasToken('encointer', 'KSM')).toBe(true)
    expect(chainHasToken('encointer', 'USDC')).toBe(false)
    expect(chainHasToken('kah', 'KSM')).toBe(true)
    expect(chainHasToken('kah', 'USDC')).toBe(true)
    expect(chainHasToken('pah', 'KSM')).toBe(true)
    expect(chainHasToken('pah', 'USDC')).toBe(true)
  })

  it('getDecimals returns correct values', () => {
    expect(getDecimals('encointer', 'KSM')).toBe(12)
    expect(getDecimals('kah', 'USDC')).toBe(6)
  })

  it('getDecimals throws for missing token', () => {
    expect(() => getDecimals('encointer', 'USDC')).toThrow()
  })

  it('toParaSpell maps correctly', () => {
    expect(toParaSpell('encointer')).toBe('Encointer')
    expect(toParaSpell('kah')).toBe('AssetHubKusama')
    expect(toParaSpell('pah')).toBe('AssetHubPolkadot')
  })

  it('all chains have at least one RPC endpoint', () => {
    for (const id of CHAIN_IDS) {
      expect(CHAINS[id].rpcEndpoints.length).toBeGreaterThan(0)
    }
  })
})
