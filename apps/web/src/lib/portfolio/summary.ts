import { isOpen, type Position } from './models';

export interface PortfolioSummary {
	/** Cost basis across every position, open and closed. */
	totalCostBasis: number;
	/** Realized P/L across every position — closed ones are where it lives. */
	totalRealizedPl: number;
	/** Open holdings only. A closed position is history, not a holding. */
	openCount: number;
	closedCount: number;
}

export function summarize(positions: readonly Position[]): PortfolioSummary {
	let totalCostBasis = 0;
	let totalRealizedPl = 0;
	let openCount = 0;

	for (const position of positions) {
		totalCostBasis += position.costBasis;
		totalRealizedPl += position.realizedPl;
		if (isOpen(position)) openCount += 1;
	}

	return {
		totalCostBasis,
		totalRealizedPl,
		openCount,
		closedCount: positions.length - openCount
	};
}

/**
 * Split into the two lists the portfolio screen renders. A fully-sold holding
 * stays in `positions` so its realized P/L survives, but it isn't a holding any
 * more — showing it inline would overstate what's actually owned.
 */
export function partition(positions: readonly Position[]): {
	open: Position[];
	closed: Position[];
} {
	return {
		open: positions.filter(isOpen),
		closed: positions.filter((position) => !isOpen(position))
	};
}
