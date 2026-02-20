export function formatBalance(value: bigint, decimals: number, maxFraction = 4): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = value / divisor
  const frac = value % divisor

  if (frac === 0n) return whole.toString()

  const fracStr = frac.toString().padStart(decimals, '0')
  const trimmed = fracStr.slice(0, maxFraction).replace(/0+$/, '')

  if (trimmed === '') return whole.toString()
  return `${whole}.${trimmed}`
}

export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim()
  if (trimmed === '' || !/^\d+\.?\d*$/.test(trimmed)) return null

  const parts = trimmed.split('.')
  const whole = parts[0]
  const frac = (parts[1] ?? '').padEnd(decimals, '0').slice(0, decimals)

  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac)
  return result > 0n ? result : null
}

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}
