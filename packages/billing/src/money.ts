import { BillingError, invariant } from './errors.ts';

export const CURRENCY = 'USD' as const;
export const UNITS_PER_DOLLAR = 1_000_000_000n;
export const UNITS_PER_CENT = 10_000_000n;
const INTEGER = /^(0|[1-9][0-9]{0,62})$/;
const SIGNED_INTEGER = /^(0|-?[1-9][0-9]{0,62})$/;

/** JSON/D1 boundaries use canonical strings, including values above Number.MAX_SAFE_INTEGER. */
export function units(value: string, name = 'amount'): bigint {
  invariant(typeof value === 'string' && INTEGER.test(value), 'invalid_units', `${name} must be a canonical nonnegative decimal integer string.`, 422);
  return BigInt(value);
}

export function signedUnits(value: string): bigint {
  invariant(typeof value === 'string' && SIGNED_INTEGER.test(value), 'invalid_units', 'Amount must be a canonical decimal integer string.', 422);
  return BigInt(value);
}

export function integer(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'invalid_quantity', `${name} is outside its supported integer range.`, 422);
  return value;
}

export function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  invariant(numerator >= 0n && denominator > 0n, 'invalid_rate', 'A rate requires a positive denominator and nonnegative numerator.', 422);
  return (numerator + denominator - 1n) / denominator;
}

export interface Rate {
  id: string;
  meter: string;
  meter_version: number;
  version: string;
  currency: typeof CURRENCY;
  unit_name: string;
  unit_quantity: string;
  unit_price_units: string;
  platform_unit_price_units: string;
}

export function maximumCharge(quantity: string, rate: Rate, platform = false): string {
  const price = platform ? rate.platform_unit_price_units : rate.unit_price_units;
  return ceilDivide(units(quantity, 'quantity') * units(price, 'price'), units(rate.unit_quantity, 'unit_quantity')).toString();
}

export function meterCharge(quantity: string, rate: Rate, remainder: string, platform = false): { amount_units: string; remainder: string } {
  const denominator = units(rate.unit_quantity, 'unit_quantity');
  const carried = units(remainder, 'remainder');
  invariant(denominator > 0n && carried < denominator, 'meter_corrupt', 'Meter carry is inconsistent with its immutable price.', 503);
  const numerator = units(quantity, 'quantity') * units(platform ? rate.platform_unit_price_units : rate.unit_price_units) + carried;
  return { amount_units: (numerator / denominator).toString(), remainder: (numerator % denominator).toString() };
}

export function sumUnits(values: Iterable<string>): string {
  let total = 0n;
  for (const value of values) total += signedUnits(value);
  return total.toString();
}

export function formatDollars(value: string): string {
  const amount = signedUnits(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / UNITS_PER_DOLLAR}.${(absolute % UNITS_PER_DOLLAR).toString().padStart(9, '0')}`;
}

/** Round a whole invoice once. Carry the signed sub-cent difference to the next statement. */
export function invoiceRounding(value: string, previousCarry = '0'): { cents: string; carry_units: string; rounded_units: string } {
  const exact = signedUnits(value) + signedUnits(previousCarry);
  if (exact < 0n) return { cents: '0', carry_units: exact.toString(), rounded_units: '0' };
  const cents = (exact + UNITS_PER_CENT / 2n) / UNITS_PER_CENT;
  return { cents: cents.toString(), rounded_units: (cents * UNITS_PER_CENT).toString(), carry_units: (exact - cents * UNITS_PER_CENT).toString() };
}

export function monthWindow(at = new Date()): { period_start: string; period_end: string } {
  return {
    period_start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString(),
    period_end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString(),
  };
}
