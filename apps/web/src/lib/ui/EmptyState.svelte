<script lang="ts">
	interface Props {
		message: string;
	}

	let { message }: Props = $props();
</script>

<p class="empty card">{message}</p>

<style>
	.empty {
		margin: 0;
		padding: 1.25rem;
		color: var(--muted);
		white-space: pre-line;
	}
</style>
