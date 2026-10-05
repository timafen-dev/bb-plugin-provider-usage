/**
 * Exact decimal money, kept as text.
 *
 * The Firstmate Pi producer reports known spend twice: `known_cost_usd`
 * rounded to six places for reading, and `known_cost_usd_exact` with the
 * digits it actually summed. Both are strings on purpose — the producer adds
 * them as exact decimals, and a consumer that reads them back through a double
 * would hand the panel a number the producer never wrote.
 *
 * So the exact companion stays exact here too: it is parsed into a scaled
 * integer, and rounding happens only when a figure is about to be rendered.
 * Nothing in this file converts to `number`.
 */

/** A decimal as `units / 10^scale`, which an integer can hold without loss. */
export interface PiDecimal {
  units: bigint;
  scale: number;
}

/** Longer than any honest money string, and a cheap guard against a blob. */
const MAX_DIGITS = 40;
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** `null` for anything that is not a plain decimal: no exponents, no spaces. */
export function piDecimal(text: string): PiDecimal | null {
  if (text.length === 0 || text.length > MAX_DIGITS) return null;
  if (!PLAIN_DECIMAL.test(text)) return null;
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? "" : body.slice(dot + 1);
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

function at(value: PiDecimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function common(a: PiDecimal, b: PiDecimal): number {
  return Math.max(a.scale, b.scale);
}

export function piDecimalAdd(a: PiDecimal, b: PiDecimal): PiDecimal {
  const scale = common(a, b);
  return { units: at(a, scale) + at(b, scale), scale };
}

/** Equal by value, so `0`, `0.00` and `0.000000` are one amount. */
export function piDecimalEquals(a: PiDecimal, b: PiDecimal): boolean {
  const scale = common(a, b);
  return at(a, scale) === at(b, scale);
}

export function piDecimalIsZero(value: PiDecimal): boolean {
  return value.units === 0n;
}

export function piDecimalIsNegative(value: PiDecimal): boolean {
  return value.units < 0n;
}

export const PI_ZERO_USD: PiDecimal = { units: 0n, scale: 0 };

/**
 * Fixed-point text with `places` decimals, rounding half away from zero —
 * the same shape the producer writes into `known_cost_usd`. This is the only
 * place a figure loses precision, and only on the way to a screen.
 */
export function piDecimalFixed(value: PiDecimal, places: number): string {
  let units = value.units;
  let scale = value.scale;
  if (scale < places) {
    units = units * 10n ** BigInt(places - scale);
  } else if (scale > places) {
    const drop = 10n ** BigInt(scale - places);
    const negative = units < 0n;
    const magnitude = negative ? -units : units;
    const whole = magnitude / drop;
    const remainder = magnitude % drop;
    const rounded = remainder * 2n >= drop ? whole + 1n : whole;
    units = negative ? -rounded : rounded;
  }
  scale = places;
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** The exact digits, with no trailing-zero padding added or removed. */
export function piDecimalText(value: PiDecimal): string {
  return piDecimalFixed(value, value.scale);
}
