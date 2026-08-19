<script lang="ts">
	import { page } from '$app/state';
	import { formatDate, formatMoney, formatShares, formatSignedMoney } from '$lib/core/formatting';
	import ThesisEditor from '$lib/journal/ThesisEditor.svelte';
	import { isLive, type Note, type Thesis } from '$lib/journal/models';
	import { lotCostBasis, type Position, type PositionLot } from '$lib/portfolio/models';
	import {
		addNote,
		fetchLots,
		fetchNotes,
		fetchPosition,
		fetchTheses
	} from '$lib/portfolio/repository';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import ErrorState from '$lib/ui/ErrorState.svelte';
	import SectionHeader from '$lib/ui/SectionHeader.svelte';
	import StatTile from '$lib/ui/StatTile.svelte';

	interface Detail {
		position: Position | null;
		lots: PositionLot[];
		theses: Thesis[];
		notes: Note[];
	}

	const instrumentId = $derived(page.params.instrumentId ?? '');

	/**
	 * Everything for one position is fetched together so the screen renders in a
	 * single pass rather than four staggered spinners.
	 */
	async function load(id: string): Promise<Detail> {
		const [position, lots, theses, notes] = await Promise.all([
			fetchPosition(id),
			fetchLots(id),
			fetchTheses(id),
			fetchNotes(id)
		]);
		return { position, lots, theses, notes };
	}

	let reloadNonce = $state(0);
	let editing = $state(false);
	let noteBody = $state('');
	let savingNote = $state(false);
	let noteError = $state<string | null>(null);

	// Derived, not plain state: SvelteKit reuses this component when you navigate
	// from one position to another, so a fetch fired once at init would leave the
	// previous holding's data on screen.
	const detail = $derived.by(() => {
		void reloadNonce; // referenced so bumping it re-runs the fetch
		return load(instrumentId);
	});

	function reload() {
		reloadNonce += 1;
	}

	// Same reuse: an editor left open on one holding must not carry over.
	$effect(() => {
		void instrumentId;
		editing = false;
		noteBody = '';
		noteError = null;
	});

	function liveThesis(theses: Thesis[]): Thesis | null {
		return theses.find(isLive) ?? null;
	}

	function history(theses: Thesis[]): Thesis[] {
		return theses.filter((thesis) => !isLive(thesis));
	}

	function tone(value: number): 'positive' | 'negative' | null {
		if (value > 0) return 'positive';
		if (value < 0) return 'negative';
		return null;
	}

	async function submitNote(event: SubmitEvent) {
		event.preventDefault();
		const body = noteBody.trim();
		if (body === '' || savingNote) return;

		savingNote = true;
		noteError = null;
		try {
			await addNote(body, instrumentId);
			noteBody = '';
			reload();
		} catch {
			noteError = "Couldn't save that note.";
		} finally {
			savingNote = false;
		}
	}

	function thesisSaved() {
		editing = false;
		reload();
	}
</script>

<p class="back"><a href="/">← Portfolio</a></p>

{#await detail}
	<p class="muted">Loading position…</p>
{:then data}
	{#if data.position === null}
		<EmptyState message="No such position. It may have been removed from the ledger." />
	{:else}
		{@const position = data.position}
		{@const live = liveThesis(data.theses)}
		{@const previously = history(data.theses)}

		<h1>{position.symbol}</h1>
		{#if position.name}
			<p class="muted name">{position.name}</p>
		{/if}

		<section class="header card">
			<div class="stats">
				<StatTile label="SHARES" value={formatShares(position.quantity)} />
				<StatTile label="COST BASIS" value={formatMoney(position.costBasis)} />
				<StatTile
					label="AVG COST"
					value={position.avgCost === null ? '—' : formatMoney(position.avgCost)}
				/>
			</div>
			{#if position.realizedPl !== 0}
				<div class="stats">
					<StatTile
						label="REALIZED P/L"
						value={formatSignedMoney(position.realizedPl)}
						tone={tone(position.realizedPl)}
					/>
				</div>
			{/if}
			<p class="muted held">Held since {formatDate(position.firstAcquiredOn)}</p>
		</section>

		<SectionHeader title="Thesis">
			{#snippet action()}
				{#if !editing}
					<button type="button" onclick={() => (editing = true)}>
						{live === null ? 'Write' : 'Revise'}
					</button>
				{/if}
			{/snippet}
		</SectionHeader>

		{#if editing}
			<ThesisEditor
				{instrumentId}
				symbol={position.symbol}
				current={live}
				onsaved={thesisSaved}
				oncancel={() => (editing = false)}
			/>
		{/if}

		{#if live === null}
			<EmptyState
				message={"No thesis yet. Write down why you own this — it's what you'll want six months from now."}
			/>
		{:else}
			{@render thesisCard(live, true)}
		{/if}

		{#if previously.length > 0}
			<SectionHeader title="Previously" />
			{#each previously as thesis (thesis.id)}
				{@render thesisCard(thesis, false)}
			{/each}
		{/if}

		{#if data.lots.length > 0}
			<SectionHeader title="Tax lots (FIFO)" />
			<ul class="rows card">
				{#each data.lots as lot (lot.id)}
					<li>
						<span>
							<span class="tabular"
								>{formatShares(lot.quantity)} @ {formatMoney(lot.costPerShare)}</span
							>
							<span class="muted sub">Acquired {formatDate(lot.acquiredOn)}</span>
						</span>
						<span class="tabular">{formatMoney(lotCostBasis(lot))}</span>
					</li>
				{/each}
			</ul>
		{/if}

		<SectionHeader title="Notes" />
		<form class="composer" onsubmit={submitNote}>
			<label class="sr-only" for="note">Add a note</label>
			<textarea id="note" rows="2" placeholder="Add a note…" bind:value={noteBody}></textarea>
			<button class="primary" type="submit" disabled={savingNote || noteBody.trim() === ''}>
				{savingNote ? 'Saving…' : 'Add'}
			</button>
		</form>
		{#if noteError}
			<p class="warn" role="alert">{noteError}</p>
		{/if}

		{#if data.notes.length === 0}
			<EmptyState message="No notes on this position yet." />
		{:else}
			<ul class="rows card">
				{#each data.notes as note (note.id)}
					<li class="note">
						<span>{note.body}</span>
						<span class="muted sub">{formatDate(note.createdAt)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
{:catch}
	<ErrorState onRetry={reload} />
{/await}

{#snippet thesisCard(thesis: Thesis, live: boolean)}
	<article class="thesis card" class:superseded={!live}>
		<header>
			<span class="muted sub">
				{#if live}
					Written {formatDate(thesis.writtenAt)}
				{:else}
					{formatDate(thesis.writtenAt)} — superseded {formatDate(thesis.supersededAt)}
				{/if}
			</span>
			{#if thesis.conviction !== null}
				<span class="muted sub">Conviction {thesis.conviction}/5</span>
			{/if}
		</header>
		<p class="rationale">{thesis.rationale}</p>
		{#if thesis.entryConditions}
			<p class="condition"><strong>Entry:</strong> {thesis.entryConditions}</p>
		{/if}
		{#if thesis.exitConditions}
			<p class="condition"><strong>Exit:</strong> {thesis.exitConditions}</p>
		{/if}
	</article>
{/snippet}

<style>
	.back {
		margin: 1rem 0 0.5rem;
		font-size: 0.85rem;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.name {
		margin: 0.15rem 0 1rem;
	}

	.header {
		padding: 1.1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.stats {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.held {
		margin: 0;
		font-size: 0.85rem;
	}

	.thesis {
		padding: 1.1rem 1.25rem;
		margin-bottom: 0.6rem;
	}

	.thesis header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.thesis.superseded .rationale {
		color: var(--muted);
	}

	.rationale {
		margin: 0.5rem 0 0;
		white-space: pre-line;
	}

	.condition {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1.25rem;
	}

	.rows li + li {
		border-top: 1px solid var(--border);
	}

	.rows li span {
		display: flex;
		flex-direction: column;
	}

	.rows li.note {
		align-items: flex-start;
		flex-direction: column;
		gap: 0.2rem;
	}

	.sub {
		font-size: 0.8rem;
	}

	.composer {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		margin-bottom: 0.75rem;
	}

	.warn {
		margin: 0 0 0.75rem;
		color: var(--negative);
		font-size: 0.85rem;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
