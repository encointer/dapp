/** Insert `'` as thousands separator into a non-negative integer string. */
function groupThousands(intStr: string): string {
  return intStr.length <= 3 ? intStr : intStr.replace(/\B(?=(\d{3})+(?!\d))/g, "'")
}

export function formatBalance(value: bigint, decimals: number, maxFraction = 4): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = value / divisor
  const frac = value % divisor
  const wholeStr = groupThousands(whole.toString())

  if (frac === 0n) return wholeStr

  const fracStr = frac.toString().padStart(decimals, '0')
  const trimmed = fracStr.slice(0, maxFraction).replace(/0+$/, '')

  if (trimmed === '') return wholeStr
  return `${wholeStr}.${trimmed}`
}

/** Format a JS number with `'` as thousands separator and up to `maxFraction`
 *  decimal places. `null`/`NaN`/`Infinity` render as `'—'`. */
export function formatNumber(value: number | null | undefined, maxFraction = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const fixed = value.toFixed(maxFraction)
  const [intPart, fracPart] = fixed.split('.')
  const sign = intPart.startsWith('-') ? '-' : ''
  const intDigits = sign ? intPart.slice(1) : intPart
  const grouped = sign + groupThousands(intDigits)
  if (!fracPart || /^0+$/.test(fracPart)) return grouped
  return `${grouped}.${fracPart.replace(/0+$/, '')}`
}

export function parseAmount(input: string, decimals: number): bigint | null {
  // Strip thousands separators (`'`) to be robust against copy-paste from
  // displayed values.
  const trimmed = input.replace(/'/g, '').trim()
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
