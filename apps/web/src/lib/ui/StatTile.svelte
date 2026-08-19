<script lang="ts">
	interface Props {
		label: string;
		value: string;
		tone?: 'positive' | 'negative' | null;
	}

	let { label, value, tone = null }: Props = $props();
</script>

<div class="stat">
	<span class="label">{label}</span>
	<span class="value tabular" class:positive={tone === 'positive'} class:negative={tone === 'negative'}
		>{value}</span
	>
</div>

<style>
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.label {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.value {
		font-size: 1.05rem;
		font-weight: 600;
	}
</style>
