/** Formats an integer token amount without letting tiny 18-decimal values dominate narrow cards. */
export function formatAtomic(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const divisor = 10n ** BigInt(decimals);
  const atomic = BigInt(value);
  const whole = atomic / divisor;
  const fraction = (atomic % divisor).toString().padStart(decimals, '0');

  if (whole === 0n && atomic !== 0n) {
    const firstSignificantIndex = fraction.search(/[1-9]/);
    if (firstSignificantIndex >= 6) {
      const significantDigits = fraction.slice(firstSignificantIndex).replace(/0+$/, '');
      const trailingDigits = significantDigits.slice(1).replace(/0+$/, '');
      const mantissa = trailingDigits ? `${significantDigits[0]}.${trailingDigits}` : significantDigits[0];
      return `${mantissa}e-${firstSignificantIndex + 1}`;
    }
  }

  return `${whole}.${fraction}`;
}
