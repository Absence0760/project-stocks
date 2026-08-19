<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		action?: Snippet;
	}

	let { title, action }: Props = $props();
</script>

<div class="header">
	<h2>{title}</h2>
	{#if action}
		{@render action()}
	{/if}
</div>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin: 1.75rem 0 0.6rem;
	}

	h2 {
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--muted);
	}
</style>
