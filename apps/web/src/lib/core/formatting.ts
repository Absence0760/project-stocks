/**
 * Display formatting. Locale is pinned to en-US rather than taken from the
 * browser: the numbers are US-market dollars, and a machine set to de-DE
 * rendering `$1.850,00` would read as a different amount, not a translation.
 *
 * Mirrors apps/mobile/lib/core/formatting.dart.
 */

const money = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD'
});

const shares = new Intl.NumberFormat('en-US');

const day = new Intl.DateTimeFormat('en-US', {
	year: 'numeric',
	month: 'short',
	day: 'numeric'
});

export function formatMoney(value: number): string {
	return money.format(value);
}

/** Realized P/L reads better with an explicit sign. */
export function formatSignedMoney(value: number): string {
	const formatted = money.format(Math.abs(value));
	if (value > 0) return `+${formatted}`;
	if (value < 0) return `-${formatted}`;
	return formatted;
}

/**
 * Fractional shares are normal, but trailing zeros are noise. Show up to four
 * decimals and drop what isn't needed.
 */
export function formatShares(value: number): string {
	if (value === Math.round(value)) return shares.format(Math.round(value));
	return value
		.toFixed(4)
		.replace(/0+$/, '')
		.replace(/\.$/, '');
}

export function formatDate(value: Date | null | undefined): string {
	return value ? day.format(value) : '—';
}
