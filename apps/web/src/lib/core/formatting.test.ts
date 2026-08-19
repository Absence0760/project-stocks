import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, formatShares, formatSignedMoney } from './formatting';

describe('formatMoney', () => {
	it('renders US dollars with two decimals', () => {
		expect(formatMoney(1850)).toBe('$1,850.00');
		expect(formatMoney(0)).toBe('$0.00');
		expect(formatMoney(-12.5)).toBe('-$12.50');
	});
});

describe('formatSignedMoney', () => {
	it('signs a gain and a loss, but not a flat zero', () => {
		expect(formatSignedMoney(240)).toBe('+$240.00');
		expect(formatSignedMoney(-240)).toBe('-$240.00');
		expect(formatSignedMoney(0)).toBe('$0.00');
	});
});

describe('formatShares', () => {
	it('drops the decimal point on whole share counts', () => {
		expect(formatShares(9)).toBe('9');
		expect(formatShares(1000)).toBe('1,000');
	});

	it('keeps fractional shares but trims trailing zeros', () => {
		expect(formatShares(1.5)).toBe('1.5');
		expect(formatShares(0.25)).toBe('0.25');
		expect(formatShares(2.123456)).toBe('2.1235');
	});
});

describe('formatDate', () => {
	it('renders an em dash for a missing date', () => {
		expect(formatDate(null)).toBe('—');
		expect(formatDate(undefined)).toBe('—');
	});

	it('renders a date in a fixed en-US shape', () => {
		expect(formatDate(new Date(2026, 0, 12))).toBe('Jan 12, 2026');
	});
});
