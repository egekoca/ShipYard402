/**
 * Token glyphs, drawn rather than fetched.
 *
 * Third-party token logos are trademarked artwork with unclear redistribution terms, and shipping
 * them as files would also mean another request per asset. These are neutral, recognisable marks
 * built from each token's own ticker and brand colour, so a new asset needs one entry here instead
 * of a licensing question.
 */

type TokenStyle = Readonly<{ label: string; background: string; ink: string }>;

const TOKENS: Readonly<Record<string, TokenStyle>> = {
  USDT: { label: '₮', background: '#26A17B', ink: '#ffffff' },
  USDC: { label: '$', background: '#2775CA', ink: '#ffffff' },
  USD1: { label: '1', background: '#C8A227', ink: '#12100a' },
  BTC: { label: '₿', background: '#F7931A', ink: '#ffffff' },
  BNB: { label: 'B', background: '#F0B90B', ink: '#12100a' },
  BOT: { label: 'β', background: '#1F8F4E', ink: '#ffffff' },
};

const UNKNOWN: TokenStyle = { label: '?', background: '#2a2f36', ink: '#c9cdd4' };

export function TokenMark({
  symbol,
  size = 22,
  className,
}: Readonly<{ symbol: string; size?: number; className?: string }>) {
  const token = TOKENS[symbol.toUpperCase()] ?? UNKNOWN;
  return (
    <span
      className={className ? `token-mark ${className}` : 'token-mark'}
      style={{ width: size, height: size, background: token.background, color: token.ink, fontSize: size * 0.55 }}
      title={symbol}
      aria-hidden="true"
    >
      {token.label}
    </span>
  );
}

/** True when this build has a real glyph for the symbol, rather than the neutral placeholder. */
export function isKnownToken(symbol: string): boolean {
  return symbol.toUpperCase() in TOKENS;
}
