import { describe, expect, it } from 'vitest';
import { asDateOrNull, asIntOrNull, asNum, asNumber, asNumberOrNull, asString } from './json';

describe('asNum', () => {
	it('passes finite numbers through', () => {
		expect(asNum(42)).toBe(42);
		expect(asNum(1.5)).toBe(1.5);
		expect(asNum(0)).toBe(0);
		expect(asNum(-12.5)).toBe(-12.5);
	});

	// Postgres numeric is often encoded as a string to stay lossless. Casting
	// straight to a number would either throw or produce NaN mid-render.
	it('parses numerics that arrive as strings', () => {
		expect(asNum('1790.00000000')).toBe(1790);
		expect(asNum('-12.5')).toBe(-12.5);
		expect(asNum('0.00000001')).toBe(0.00000001);
	});

	// The whole reason this module exists: JavaScript coerces every one of these
	// to 0, which would silently invent a cost basis.
	it('does not turn empty or non-numeric input into zero', () => {
		expect(asNum('')).toBeNull();
		expect(asNum('   ')).toBeNull();
		expect(asNum(null)).toBeNull();
		expect(asNum(undefined)).toBeNull();
		expect(asNum([])).toBeNull();
		expect(asNum({})).toBeNull();
		expect(asNum(false)).toBeNull();
		expect(asNum('not a number')).toBeNull();
	});

	it('rejects non-finite numbers', () => {
		expect(asNum(Number.NaN)).toBeNull();
		expect(asNum(Number.POSITIVE_INFINITY)).toBeNull();
		expect(asNum('Infinity')).toBeNull();
	});
});

describe('asNumber', () => {
	it('falls back rather than throwing', () => {
		expect(asNumber(null)).toBe(0);
		expect(asNumber('nope', -1)).toBe(-1);
	});

	it('accepts both encodings of the same value', () => {
		expect(asNumber('200.00000000')).toBe(asNumber(200));
	});
});

describe('asNumberOrNull', () => {
	it('distinguishes a real zero from a missing value', () => {
		expect(asNumberOrNull('0')).toBe(0);
		expect(asNumberOrNull(null)).toBeNull();
	});
});

describe('asIntOrNull', () => {
	it('truncates a numeric string', () => {
		expect(asIntOrNull('4')).toBe(4);
		expect(asIntOrNull('4.9')).toBe(4);
		expect(asIntOrNull('-4.9')).toBe(-4);
		expect(asIntOrNull(null)).toBeNull();
	});
});

describe('asString', () => {
	it('falls back for anything that is not a string', () => {
		expect(asString('AAPL')).toBe('AAPL');
		expect(asString(null, '—')).toBe('—');
		expect(asString(7, '—')).toBe('—');
	});
});

describe('asDateOrNull', () => {
	it('reads a bare date column as local midnight', () => {
		const parsed = asDateOrNull('2026-01-12');
		expect(parsed).not.toBeNull();
		// Local components, so a browser west of Greenwich still shows the 12th.
		expect(parsed?.getFullYear()).toBe(2026);
		expect(parsed?.getMonth()).toBe(0);
		expect(parsed?.getDate()).toBe(12);
		expect(parsed?.getHours()).toBe(0);
	});

	it('reads a timestamptz as the instant it names', () => {
		expect(asDateOrNull('2026-05-04T09:00:00Z')?.toISOString()).toBe('2026-05-04T09:00:00.000Z');
		expect(asDateOrNull('2026-05-04T09:00:00+00:00')?.toISOString()).toBe(
			'2026-05-04T09:00:00.000Z'
		);
	});

	it('passes a Date through', () => {
		const now = new Date('2026-06-01T00:00:00Z');
		expect(asDateOrNull(now)).toBe(now);
		expect(asDateOrNull(new Date('nonsense'))).toBeNull();
	});

	it('returns null for blanks and rubbish', () => {
		expect(asDateOrNull(null)).toBeNull();
		expect(asDateOrNull('')).toBeNull();
		expect(asDateOrNull('not a date')).toBeNull();
		expect(asDateOrNull(20260112)).toBeNull();
	});

	// A US-style date resolves against the runtime timezone and can shift a
	// trade by a day, so it is refused rather than parsed.
	it('refuses non-ISO date shapes', () => {
		expect(asDateOrNull('3/14/2026')).toBeNull();
		expect(asDateOrNull('14 March 2026')).toBeNull();
	});
});
