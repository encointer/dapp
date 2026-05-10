import { describe, it, expect } from 'vitest'
import { formatBalance, formatNumber, parseAmount, truncateAddress } from '../lib/format'

describe('formatBalance', () => {
  it('formats zero', () => {
    expect(formatBalance(0n, 12)).toBe('0')
  })

  it('formats whole numbers', () => {
    expect(formatBalance(1_000_000_000_000n, 12)).toBe('1')
    expect(formatBalance(5_000_000_000_000n, 12)).toBe('5')
  })

  it('formats fractional amounts', () => {
    expect(formatBalance(1_500_000_000_000n, 12)).toBe('1.5')
    expect(formatBalance(1_234_500_000_000n, 12)).toBe('1.2345')
  })

  it('truncates to maxFraction digits', () => {
    expect(formatBalance(1_234_567_890_000n, 12, 2)).toBe('1.23')
    expect(formatBalance(1_234_567_890_000n, 12, 6)).toBe('1.234567')
  })

  it('strips trailing zeros in fraction', () => {
    expect(formatBalance(1_200_000_000_000n, 12)).toBe('1.2')
    expect(formatBalance(1_000_100_000_000n, 12)).toBe('1.0001')
  })

  it('handles USDC (6 decimals)', () => {
    expect(formatBalance(50_000_000n, 6)).toBe('50')
    expect(formatBalance(12_345_678n, 6)).toBe('12.3456')
  })

  it('groups thousands with apostrophe', () => {
    expect(formatBalance(1_234_000_000_000_000n, 12)).toBe("1'234")
    expect(formatBalance(1_234_567_000_000_000_000n, 12)).toBe("1'234'567")
    expect(formatBalance(1_000_000_000_000_000n, 6, 0)).toBe("1'000'000'000")
    expect(formatBalance(123_456_789_012n, 6, 4)).toBe("123'456.789")
  })
})

describe('formatNumber', () => {
  it('groups thousands with apostrophe', () => {
    expect(formatNumber(1234, 0)).toBe("1'234")
    expect(formatNumber(1_234_567, 0)).toBe("1'234'567")
    expect(formatNumber(1234.5, 2)).toBe("1'234.5")
    expect(formatNumber(-1234, 0)).toBe("-1'234")
  })

  it('renders null/NaN/Infinity as em dash', () => {
    expect(formatNumber(null, 0)).toBe('—')
    expect(formatNumber(undefined, 0)).toBe('—')
    expect(formatNumber(NaN, 0)).toBe('—')
    expect(formatNumber(Infinity, 0)).toBe('—')
  })

  it('strips trailing zeros after decimal', () => {
    expect(formatNumber(1234.0, 2)).toBe("1'234")
    expect(formatNumber(1234.50, 2)).toBe("1'234.5")
  })
})

describe('parseAmount', () => {
  it('parses whole numbers', () => {
    expect(parseAmount('1', 12)).toBe(1_000_000_000_000n)
    expect(parseAmount('50', 6)).toBe(50_000_000n)
  })

  it('parses decimal amounts', () => {
    expect(parseAmount('1.5', 12)).toBe(1_500_000_000_000n)
    expect(parseAmount('0.001', 12)).toBe(1_000_000_000n)
  })

  it('returns null for empty/invalid input', () => {
    expect(parseAmount('', 12)).toBeNull()
    expect(parseAmount('abc', 12)).toBeNull()
    expect(parseAmount('-1', 12)).toBeNull()
    expect(parseAmount('0', 12)).toBeNull()
  })

  it('handles excess decimal places by truncating', () => {
    expect(parseAmount('1.123456789012345', 12)).toBe(1_123_456_789_012n)
  })

  it("strips apostrophe thousands separators (e.g. paste from formatted display)", () => {
    expect(parseAmount("1'234", 12)).toBe(1_234_000_000_000_000n)
    expect(parseAmount("1'234.5", 12)).toBe(1_234_500_000_000_000n)
    expect(parseAmount("1'234'567'890", 6)).toBe(1_234_567_890_000_000n)
  })
})

describe('truncateAddress', () => {
  it('truncates long addresses', () => {
    const addr = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
    expect(truncateAddress(addr)).toBe('5Grwva...utQY')
  })

  it('returns short addresses as-is', () => {
    expect(truncateAddress('5GrwvaEF5z')).toBe('5GrwvaEF5z')
  })
})
