<script lang="ts">
	import { untrack } from 'svelte';
	import { supersedeThesis } from '$lib/portfolio/repository';
	import type { Thesis } from './models';

	interface Props {
		instrumentId: string;
		symbol: string;
		/** The live thesis, when revising. Null when writing the first one. */
		current: Thesis | null;
		onsaved: () => void;
		oncancel: () => void;
	}

	let { instrumentId, symbol, current, onsaved, oncancel }: Props = $props();

	/**
	 * Revising deliberately starts from a BLANK rationale rather than pre-filling
	 * the old one: saving writes a NEW thesis and stamps the old (never an update
	 * in place), and pre-filling invites editing history rather than recording a
	 * change of mind. The entry and exit conditions do carry over, since those are
	 * usually still what you meant. Same rule as the mobile editor —
	 * docs/STACK.md § theses are append-only.
	 */
	// `untrack` because these ARE a one-time snapshot of the thesis being revised:
	// the form is what you are about to write, not a live view of what's stored.
	let rationale = $state('');
	let entryConditions = $state(untrack(() => current?.entryConditions ?? ''));
	let exitConditions = $state(untrack(() => current?.exitConditions ?? ''));
	let conviction = $state(untrack(() => current?.conviction ?? 3));
	let saving = $state(false);
	let error = $state<string | null>(null);

	const revising = $derived(current !== null);

	function blankToNull(value: string): string | null {
		const trimmed = value.trim();
		return trimmed === '' ? null : trimmed;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;

		const text = rationale.trim();
		if (text === '') {
			error = 'A thesis needs a rationale.';
			return;
		}

		saving = true;
		error = null;
		try {
			await supersedeThesis({
				instrumentId,
				rationale: text,
				entryConditions: blankToNull(entryConditions),
				exitConditions: blankToNull(exitConditions),
				conviction
			});
			onsaved();
		} catch {
			saving = false;
			error = "Couldn't save. Check your connection and try again.";
		}
	}
</script>

<form class="editor card" onsubmit={save}>
	<h3>{revising ? `Revise ${symbol} thesis` : `Write ${symbol} thesis`}</h3>
	{#if revising}
		<p class="muted note">Your current thesis is kept as history.</p>
	{/if}

	<div class="field">
		<label for="rationale">Why do you own this?</label>
		<textarea id="rationale" rows="5" bind:value={rationale} required></textarea>
	</div>

	<div class="field">
		<label for="entry">Entry conditions (optional)</label>
		<input id="entry" type="text" bind:value={entryConditions} />
	</div>

	<div class="field">
		<label for="exit">Exit conditions (optional)</label>
		<input id="exit" type="text" bind:value={exitConditions} />
		<p class="muted hint">What would make you sell?</p>
	</div>

	<div class="field">
		<label for="conviction">Conviction — {conviction}/5</label>
		<input id="conviction" type="range" min="1" max="5" step="1" bind:value={conviction} />
	</div>

	{#if error}
		<p class="warn" role="alert">{error}</p>
	{/if}

	<div class="actions">
		<button type="button" onclick={oncancel} disabled={saving}>Cancel</button>
		<button class="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
	</div>
</form>

<style>
	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 1.25rem;
		margin-bottom: 0.75rem;
	}

	h3 {
		font-size: 1rem;
	}

	.note,
	.hint {
		margin: 0;
		font-size: 0.8rem;
	}

	.hint {
		margin-top: 0.25rem;
	}

	.field {
		display: flex;
		flex-direction: column;
	}

	.warn {
		margin: 0;
		color: var(--negative);
		font-size: 0.85rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}
</style>
