<script lang="ts">
	import { formatMoney, formatShares, formatSignedMoney } from '$lib/core/formatting';
	import { type Position } from '$lib/portfolio/models';
	import { fetchPositions } from '$lib/portfolio/repository';
	import { partition, summarize } from '$lib/portfolio/summary';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import ErrorState from '$lib/ui/ErrorState.svelte';
	import SectionHeader from '$lib/ui/SectionHeader.svelte';
	import StatTile from '$lib/ui/StatTile.svelte';

	let load = $state(fetchPositions());

	function reload() {
		load = fetchPositions();
	}

	function tone(value: number): 'positive' | 'negative' | null {
		if (value > 0) return 'positive';
		if (value < 0) return 'negative';
		return null;
	}

	function split(positions: Position[]) {
		return { ...partition(positions), summary: summarize(positions) };
	}
</script>

<h1>Portfolio</h1>

{#await load}
	<p class="muted">Loading positions…</p>
{:then positions}
	{@const view = split(positions)}

	<section class="summary card">
		<StatTile label="COST BASIS" value={formatMoney(view.summary.totalCostBasis)} />
		<StatTile
			label="REALIZED"
			value={formatSignedMoney(view.summary.totalRealizedPl)}
			tone={tone(view.summary.totalRealizedPl)}
		/>
		<StatTile label="HOLDINGS" value={String(view.summary.openCount)} />
	</section>

	{#if positions.length === 0}
		<EmptyState message={'No positions yet.\nImport a broker CSV to get started.'} />
	{:else}
		<SectionHeader title="Holdings" />
		{#if view.open.length === 0}
			<EmptyState message="Nothing open — every position has been sold." />
		{:else}
			{@render rows(view.open)}
		{/if}

		{#if view.closed.length > 0}
			<SectionHeader title="Closed" />
			{@render rows(view.closed)}
		{/if}
	{/if}
{:catch}
	<ErrorState onRetry={reload} />
{/await}

<!-- One row shape for both lists; a closed position shows "Closed" instead of a
     share count, because it no longer has one. -->
{#snippet rows(positions: Position[])}
	<ul class="rows card">
		{#each positions as position (position.instrumentId)}
			<li>
				<a href="/positions/{position.instrumentId}">
					<span class="symbol">
						<strong>{position.symbol}</strong>
						<span class="muted sub">
							{#if position.quantity > 0}
								{formatShares(position.quantity)} shares{position.avgCost === null
									? ''
									: ` · avg ${formatMoney(position.avgCost)}`}
							{:else}
								Closed
							{/if}
						</span>
					</span>
					<span class="amounts">
						<span class="tabular">{formatMoney(position.costBasis)}</span>
						{#if position.realizedPl !== 0}
							<span class="tabular sub {tone(position.realizedPl)}">
								{formatSignedMoney(position.realizedPl)}
							</span>
						{/if}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

<style>
	h1 {
		font-size: 1.5rem;
		margin: 1.25rem 0 1rem;
	}

	.summary {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.1rem 1.25rem;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow: hidden;
	}

	.rows li + li {
		border-top: 1px solid var(--border);
	}

	.rows a {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.85rem 1.25rem;
		text-decoration: none;
	}

	.rows a:hover {
		background: var(--bg);
	}

	.symbol,
	.amounts {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.amounts {
		align-items: flex-end;
		font-weight: 600;
	}

	.sub {
		font-size: 0.8rem;
		font-weight: 400;
	}
</style>
