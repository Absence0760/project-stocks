import { describe, expect, it } from 'vitest';
import { isOpen, lotCostBasis, parsePosition, parsePositionLot } from './models';

describe('parsePosition', () => {
	// This is the row shape PostgREST actually returns for the query in
	// repository.ts: numeric columns as strings, the joined instrument embedded
	// under its table name.
	const row = {
		instrument_id: '00000000-0000-0000-0000-0000000000b1',
		quantity: '9.00000000',
		cost_basis: '1790.00000000',
		avg_cost: '198.88888889',
		realized_pl: '240.00000000',
		first_acquired_on: '2026-01-12',
		last_transaction_on: '2026-05-15',
		instruments: { symbol: 'AAPL', name: 'Apple Inc.' }
	};

	it('reads string-encoded numerics without casting', () => {
		const position = parsePosition(row);
		expect(position.quantity).toBe(9);
		expect(position.costBasis).toBe(1790);
		expect(position.avgCost).toBeCloseTo(198.88888889, 8);
		expect(position.realizedPl).toBe(240);
	});

	it('lifts the embedded instrument', () => {
		const position = parsePosition(row);
		expect(position.symbol).toBe('AAPL');
		expect(position.name).toBe('Apple Inc.');
	});

	it('survives a row with the instrument join missing', () => {
		const position = parsePosition({ instrument_id: 'x', quantity: 1, cost_basis: 10 });
		expect(position.symbol).toBe('—');
		expect(position.name).toBeNull();
		expect(position.avgCost).toBeNull();
		expect(position.realizedPl).toBe(0);
		expect(position.firstAcquiredOn).toBeNull();
	});

	// A holding whose cost basis is genuinely zero (an opening_balance standing
	// in for shares older than the export window) must not read as missing.
	it('keeps a real zero distinct from a missing value', () => {
		const position = parsePosition({ ...row, cost_basis: '0', avg_cost: null });
		expect(position.costBasis).toBe(0);
		expect(position.avgCost).toBeNull();
	});
});

describe('isOpen', () => {
	const base = parsePosition({ instrument_id: 'x', quantity: '0', cost_basis: '0' });

	it('treats a fully-sold holding as closed', () => {
		expect(isOpen(base)).toBe(false);
		expect(isOpen({ ...base, quantity: 0.0001 })).toBe(true);
	});
});

describe('parsePositionLot', () => {
	it('derives the lot cost basis from string-encoded numerics', () => {
		const lot = parsePositionLot({
			id: 'lot-1',
			acquired_on: '2026-02-18',
			quantity: '4.00000000',
			cost_per_share: '210.00000000'
		});

		expect(lot.quantity).toBe(4);
		expect(lot.costPerShare).toBe(210);
		expect(lotCostBasis(lot)).toBe(840);
		expect(lot.acquiredOn?.getDate()).toBe(18);
	});
});
