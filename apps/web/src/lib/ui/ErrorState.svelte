<script lang="ts">
	interface Props {
		message?: string;
		onRetry?: () => void;
	}

	let { message = "Couldn't load that. Check the local stack is running.", onRetry }: Props =
		$props();
</script>

<div class="error card" role="alert">
	<p>{message}</p>
	{#if onRetry}
		<button type="button" onclick={onRetry}>Retry</button>
	{/if}
</div>

<style>
	.error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.25rem;
		border-color: var(--negative);
	}

	p {
		margin: 0;
		color: var(--negative);
	}
</style>
