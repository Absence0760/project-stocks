import { supabaseAnonKey, supabaseUrl } from '$lib/config/env';
import { supabase } from '$lib/supabase/client';

/** A row the adapter deliberately did not import, and why. */
export interface SkippedRow {
	/** 1-based row number in the source file, excluding the header. */
	row: number;
	reason: string;
	raw: Record<string, string>;
}

/** The edge function's response — see _shared/ingest/handler.ts ImportResult. */
export interface ImportResult {
	ingestRunId: string;
	rowsSeen: number;
	/** Rows newly written. A re-import of an overlapping export reports 0. */
	rowsImported: number;
	/** Parsed rows already present, so not written again. */
	rowsDuplicate: number;
	skipped: SkippedRow[];
}

/** Adapter ids. Paired to INGEST_SOURCES and the `source` CHECK constraint. */
export const IMPORT_SOURCES = ['robinhood-csv'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/**
 * POST the CSV text to the `import-transactions` edge function.
 *
 * Plain `fetch` rather than `supabase.functions.invoke` so a non-2xx response
 * can be surfaced with the server's own message — `invoke` buries it inside a
 * FunctionsHttpError and the reason a file was rejected is the whole point of
 * the screen.
 *
 * The user id is never sent: the function resolves the caller from this token.
 */
export async function importTransactions(
	source: ImportSource,
	content: string
): Promise<ImportResult> {
	const { data } = await supabase().auth.getSession();
	const accessToken = data.session?.access_token;
	if (!accessToken) throw new Error('Importing requires a signed-in user.');

	const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/import-transactions`;

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: supabaseAnonKey,
			Authorization: `Bearer ${accessToken}`
		},
		body: JSON.stringify({ source, content })
	});

	const body: unknown = await response.json().catch(() => null);

	if (!response.ok) {
		const message =
			body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
				? (body as { error: string }).error
				: `import failed (HTTP ${response.status})`;
		throw new Error(message);
	}

	return body as ImportResult;
}
