<script lang="ts">
	import { importTransactions, type ImportResult, type ImportSource } from '$lib/ingest/import-client';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import SectionHeader from '$lib/ui/SectionHeader.svelte';
	import StatTile from '$lib/ui/StatTile.svelte';

	const source: ImportSource = 'robinhood-csv';

	let file = $state<File | null>(null);
	let running = $state(false);
	let result = $state<ImportResult | null>(null);
	let error = $state<string | null>(null);

	function pick(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		file = input.files?.[0] ?? null;
		result = null;
		error = null;
	}

	async function upload() {
		if (!file || running) return;

		running = true;
		result = null;
		error = null;
		try {
			result = await importTransactions(source, await file.text());
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.message : 'Import failed.';
		} finally {
			running = false;
		}
	}
</script>

<h1>Import transactions</h1>
<p class="muted lede">
	A Robinhood CSV export (Account → Reports and Statements). Re-importing an overlapping export is a
	no-op — rows are matched on their idempotency key, so nothing is double-counted.
</p>

<div class="picker card">
	<input type="file" accept=".csv,text/csv" onchange={pick} />
	<button class="primary" type="button" onclick={upload} disabled={!file || running}>
		{running ? 'Importing…' : 'Import'}
	</button>
</div>

{#if error}
	<p class="warn card" role="alert">{error}</p>
{/if}

{#if result}
	<SectionHeader title="Result" />
	<section class="summary card">
		<StatTile label="ROWS SEEN" value={String(result.rowsSeen)} />
		<StatTile
			label="IMPORTED"
			value={String(result.rowsImported)}
			tone={result.rowsImported > 0 ? 'positive' : null}
		/>
		<StatTile label="DUPLICATE" value={String(result.rowsDuplicate)} />
		<StatTile
			label="SKIPPED"
			value={String(result.skipped.length)}
			tone={result.skipped.length > 0 ? 'negative' : null}
		/>
	</section>

	<p class="muted run">Ingest run {result.ingestRunId}</p>

	<SectionHeader title="Skipped rows" />
	{#if result.skipped.length === 0}
		<EmptyState message="Nothing skipped — every row in the file was understood." />
	{:else}
		<ul class="rows card">
			{#each result.skipped as row (row.row)}
				<li>
					<span class="row-no tabular">Row {row.row}</span>
					<span>
						<span class="reason">{row.reason}</span>
						<span class="muted raw">{JSON.stringify(row.raw)}</span>
					</span>
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 1.25rem 0 0.5rem;
	}

	.lede {
		margin: 0 0 1.25rem;
		font-size: 0.9rem;
	}

	.picker {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1.1rem 1.25rem;
		flex-wrap: wrap;
	}

	.picker input {
		flex: 1 1 16rem;
		width: auto;
		border: none;
		padding: 0;
	}

	.summary {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.1rem 1.25rem;
		flex-wrap: wrap;
	}

	.run {
		margin: 0.6rem 0 0;
		font-size: 0.8rem;
	}

	.warn {
		margin: 1rem 0 0;
		padding: 1rem 1.25rem;
		color: var(--negative);
		border-color: var(--negative);
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.rows li {
		display: flex;
		gap: 1rem;
		padding: 0.75rem 1.25rem;
	}

	.rows li + li {
		border-top: 1px solid var(--border);
	}

	.rows li > span:last-child {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.row-no {
		flex: 0 0 4.5rem;
		font-weight: 600;
	}

	.reason {
		font-size: 0.9rem;
	}

	.raw {
		font-size: 0.75rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		overflow-wrap: anywhere;
	}
</style>
