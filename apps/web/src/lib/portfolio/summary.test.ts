import { describe, expect, it } from 'vitest';
import { parsePosition, type Position } from './models';
import { partition, summarize } from './summary';

/** Built through the parser on purpose: the summary consumes parser output. */
function position(fields: Record<string, unknown>): Position {
	return parsePosition({ instrument_id: 'i', quantity: '0', cost_basis: '0', ...fields });
}

// Mirrors the seeded portfolio: AAPL part-sold, MSFT split, VTI opening balance.
const seeded = [
	position({ quantity: '9.00000000', cost_basis: '1790.00000000', realized_pl: '240.00000000' }),
	position({ quantity: '16.00000000', cost_basis: '3200.00000000' }),
	position({ quantity: '25.00000000', cost_basis: '6000.00000000' })
];

describe('summarize', () => {
	it('totals cost basis and realized P/L across every position', () => {
		const summary = summarize(seeded);
		expect(summary.totalCostBasis).toBe(10990);
		expect(summary.totalRealizedPl).toBe(240);
		expect(summary.openCount).toBe(3);
		expect(summary.closedCount).toBe(0);
	});

	// A closed position keeps contributing its realized P/L but is not a holding.
	it('counts only open positions as holdings', () => {
		const withClosed = [
			...seeded,
			position({ quantity: '0', cost_basis: '0', realized_pl: '-125.50' })
		];

		const summary = summarize(withClosed);
		expect(summary.openCount).toBe(3);
		expect(summary.closedCount).toBe(1);
		expect(summary.totalRealizedPl).toBeCloseTo(114.5, 8);
	});

	it('is all zeroes for an empty portfolio', () => {
		expect(summarize([])).toEqual({
			totalCostBasis: 0,
			totalRealizedPl: 0,
			openCount: 0,
			closedCount: 0
		});
	});

	// The gotcha this whole numeric-parsing layer exists for: if the summary
	// added string-encoded numerics it would concatenate them into '0179032'.
	it('adds string-encoded numerics arithmetically, not as text', () => {
		expect(typeof summarize(seeded).totalCostBasis).toBe('number');
	});
});

describe('partition', () => {
	it('separates closed positions from open ones, preserving order', () => {
		const closed = position({ quantity: '0', cost_basis: '0', realized_pl: '12' });
		const { open, closed: closedList } = partition([seeded[0], closed, seeded[1]]);

		expect(open).toEqual([seeded[0], seeded[1]]);
		expect(closedList).toEqual([closed]);
	});
});
