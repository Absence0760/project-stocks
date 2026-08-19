import { parseNote, parseThesis, type Note, type Thesis } from '$lib/journal/models';
import { supabase } from '$lib/supabase/client';
import {
	parsePosition,
	parsePositionLot,
	type Position,
	type PositionLot,
	type Row
} from './models';

/**
 * All reads and writes for the portfolio and journal.
 *
 * Every query scopes to the caller implicitly through RLS, and the derived
 * tables are SELECT-only by design: to change a position you change the ledger
 * and recompute. There is deliberately no `updatePosition` here.
 *
 * Mirrors apps/mobile/lib/portfolio/portfolio_repository.dart, query for query.
 */

const POSITION_COLUMNS =
	'instrument_id, quantity, cost_basis, avg_cost, realized_pl, ' +
	'first_acquired_on, last_transaction_on, instruments(symbol, name)';

const THESIS_COLUMNS =
	'id, instrument_id, rationale, entry_conditions, exit_conditions, ' +
	'conviction, written_at, superseded_at';

function rowsOf(data: unknown): Row[] {
	return Array.isArray(data) ? (data as Row[]) : [];
}

export async function fetchPositions(): Promise<Position[]> {
	const { data, error } = await supabase()
		.from('positions')
		.select(POSITION_COLUMNS)
		.order('cost_basis', { ascending: false });

	if (error) throw error;
	return rowsOf(data).map(parsePosition);
}

export async function fetchPosition(instrumentId: string): Promise<Position | null> {
	const { data, error } = await supabase()
		.from('positions')
		.select(POSITION_COLUMNS)
		.eq('instrument_id', instrumentId)
		.limit(1);

	if (error) throw error;

	const rows = rowsOf(data);
	return rows.length === 0 ? null : parsePosition(rows[0]);
}

export async function fetchLots(instrumentId: string): Promise<PositionLot[]> {
	const { data, error } = await supabase()
		.from('position_lots')
		.select('id, acquired_on, quantity, cost_per_share')
		.eq('instrument_id', instrumentId)
		.order('acquired_on');

	if (error) throw error;
	return rowsOf(data).map(parsePositionLot);
}

/** Newest first, so the live thesis leads and history follows. */
export async function fetchTheses(instrumentId: string): Promise<Thesis[]> {
	const { data, error } = await supabase()
		.from('theses')
		.select(THESIS_COLUMNS)
		.eq('instrument_id', instrumentId)
		.order('written_at', { ascending: false });

	if (error) throw error;
	return rowsOf(data).map(parseThesis);
}

export async function fetchNotes(instrumentId?: string): Promise<Note[]> {
	let query = supabase().from('notes').select('id, instrument_id, body, created_at');
	if (instrumentId) query = query.eq('instrument_id', instrumentId);

	const { data, error } = await query.order('created_at', { ascending: false });

	if (error) throw error;
	return rowsOf(data).map(parseNote);
}

export async function addNote(body: string, instrumentId?: string): Promise<void> {
	const { data } = await supabase().auth.getUser();
	const userId = data.user?.id;
	if (!userId) throw new Error('addNote requires a signed-in user');

	const { error } = await supabase()
		.from('notes')
		.insert({ user_id: userId, instrument_id: instrumentId ?? null, body });

	if (error) throw error;
}

export interface ThesisDraft {
	instrumentId: string;
	rationale: string;
	entryConditions: string | null;
	exitConditions: string | null;
	conviction: number | null;
}

/**
 * Stamps the current thesis and writes its replacement in one statement — see
 * supersede_thesis() in the schema. A thesis is NEVER updated in place: the
 * history is the product. Doing it client-side in two statements would also race
 * the one-live-thesis unique index.
 */
export async function supersedeThesis(draft: ThesisDraft): Promise<void> {
	const { error } = await supabase().rpc('supersede_thesis', {
		p_instrument_id: draft.instrumentId,
		p_rationale: draft.rationale,
		p_entry_conditions: draft.entryConditions,
		p_exit_conditions: draft.exitConditions,
		p_conviction: draft.conviction
	});

	if (error) throw error;
}
