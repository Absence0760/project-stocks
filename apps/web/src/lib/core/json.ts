/**
 * Decoding helpers for rows coming back from PostgREST.
 *
 * Postgres `numeric` does not always arrive as a JSON number — depending on the
 * column and the client it can be a string, because that is the only lossless
 * JSON encoding for arbitrary precision. Every numeric read goes through here
 * rather than being cast, so a `string` where a `number` was expected can't blow
 * up a list render.
 *
 * This is the TypeScript twin of apps/mobile/lib/core/json.dart and is kept
 * behaviourally identical to it on purpose — the two clients read the same rows.
 *
 * JavaScript makes this sharper than Dart does: `Number('')`, `Number(' ')`,
 * `Number(null)` and `Number([])` are all `0`, so a naive `Number(x)` turns
 * missing data into a confident zero. Everything below rejects those first.
 */

export function asNum(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string') return null;

	const trimmed = value.trim();
	if (trimmed === '') return null;

	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

export function asNumber(value: unknown, fallback = 0): number {
	return asNum(value) ?? fallback;
}

export function asNumberOrNull(value: unknown): number | null {
	return asNum(value);
}

/** Truncates toward zero, matching Dart's `num.toInt()`. */
export function asIntOrNull(value: unknown): number | null {
	const parsed = asNum(value);
	return parsed === null ? null : Math.trunc(parsed);
}

export function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_SHAPED = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

/**
 * Parses an ISO date (`2026-01-12`) or timestamptz (`2026-05-04T09:00:00Z`).
 *
 * Two deliberate rules, both about not shifting a trade by a day:
 *
 *  - Only ISO-shaped input is accepted. `new Date('3/14/2026')` resolves against
 *    the runtime's timezone (docs/STACK.md § what not to do), so anything else
 *    is rejected rather than guessed at.
 *  - A bare `date` column becomes LOCAL midnight, not UTC midnight. ECMAScript
 *    reads `'2026-01-12'` as UTC, so a browser west of Greenwich would render a
 *    January 12th trade as the 11th. Dart's `DateTime.parse` uses local for
 *    date-only input, and the two clients have to agree.
 */
export function asDateOrNull(value: unknown): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value !== 'string') return null;

	const trimmed = value.trim();
	if (trimmed === '' || !ISO_SHAPED.test(trimmed)) return null;

	const dateOnly = DATE_ONLY.exec(trimmed);
	const parsed = dateOnly
		? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
		: new Date(trimmed);

	return Number.isNaN(parsed.getTime()) ? null : parsed;
}
