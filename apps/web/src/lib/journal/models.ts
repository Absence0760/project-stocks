import { asDateOrNull, asIntOrNull, asString } from '$lib/core/json';
import type { Row } from '$lib/portfolio/models';

/**
 * A written investment thesis. Append-only: superseding writes a new row and
 * stamps the old one, so the history is the feature.
 */
export interface Thesis {
	id: string;
	instrumentId: string;
	rationale: string;
	entryConditions: string | null;
	exitConditions: string | null;
	conviction: number | null;
	writtenAt: Date | null;
	supersededAt: Date | null;
}

export function isLive(thesis: Thesis): boolean {
	return thesis.supersededAt === null;
}

export function parseThesis(row: Row): Thesis {
	return {
		id: asString(row.id),
		instrumentId: asString(row.instrument_id),
		rationale: asString(row.rationale),
		entryConditions: typeof row.entry_conditions === 'string' ? row.entry_conditions : null,
		exitConditions: typeof row.exit_conditions === 'string' ? row.exit_conditions : null,
		conviction: asIntOrNull(row.conviction),
		writtenAt: asDateOrNull(row.written_at),
		supersededAt: asDateOrNull(row.superseded_at)
	};
}

/** A journal entry. A null instrumentId is a portfolio-level note. */
export interface Note {
	id: string;
	instrumentId: string | null;
	body: string;
	createdAt: Date | null;
}

export function parseNote(row: Row): Note {
	return {
		id: asString(row.id),
		instrumentId: typeof row.instrument_id === 'string' ? row.instrument_id : null,
		body: asString(row.body),
		createdAt: asDateOrNull(row.created_at)
	};
}
