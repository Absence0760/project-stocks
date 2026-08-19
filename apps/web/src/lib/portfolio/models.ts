import { asDateOrNull, asNumber, asNumberOrNull, asString } from '$lib/core/json';

/** An untyped PostgREST row. Every field is read through `$lib/core/json`. */
export type Row = Record<string, unknown>;

/** A holding, derived from the ledger by recompute_positions(). */
export interface Position {
	instrumentId: string;
	symbol: string;
	name: string | null;
	quantity: number;
	costBasis: number;
	avgCost: number | null;
	realizedPl: number;
	firstAcquiredOn: Date | null;
	lastTransactionOn: Date | null;
}

/** A fully-sold holding stays in the table so its realized P/L survives. */
export function isOpen(position: Position): boolean {
	return position.quantity > 0;
}

export function parsePosition(row: Row): Position {
	// PostgREST embeds the joined instrument under its table name.
	const instrument = (row.instruments ?? {}) as Row;

	return {
		instrumentId: asString(row.instrument_id),
		symbol: asString(instrument.symbol, '—'),
		name: typeof instrument.name === 'string' ? instrument.name : null,
		quantity: asNumber(row.quantity),
		costBasis: asNumber(row.cost_basis),
		avgCost: asNumberOrNull(row.avg_cost),
		realizedPl: asNumber(row.realized_pl),
		firstAcquiredOn: asDateOrNull(row.first_acquired_on),
		lastTransactionOn: asDateOrNull(row.last_transaction_on)
	};
}

/** An open FIFO tax lot. */
export interface PositionLot {
	id: string;
	acquiredOn: Date | null;
	quantity: number;
	costPerShare: number;
}

export function lotCostBasis(lot: PositionLot): number {
	return lot.quantity * lot.costPerShare;
}

export function parsePositionLot(row: Row): PositionLot {
	return {
		id: asString(row.id),
		acquiredOn: asDateOrNull(row.acquired_on),
		quantity: asNumber(row.quantity),
		costPerShare: asNumber(row.cost_per_share)
	};
}
