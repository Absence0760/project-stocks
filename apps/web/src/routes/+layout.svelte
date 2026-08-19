<script lang="ts">
	import type { Session } from '@supabase/supabase-js';
	import { onMount, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { resolveSession, signIn, signOut } from '$lib/auth/session';
	import { isConfigured } from '$lib/supabase/client';
	import '../app.css';

	let { children }: { children: Snippet } = $props();

	let session = $state<Session | null>(null);
	let ready = $state(false);
	let email = $state('investor@test.com');
	let password = $state('');
	let signingIn = $state(false);
	let authError = $state<string | null>(null);

	// `ready` gates the template so the sign-in form never flashes while the
	// stored session (or the dev auto-login) is still resolving.
	onMount(async () => {
		try {
			session = await resolveSession();
		} catch (error) {
			authError = error instanceof Error ? error.message : String(error);
		} finally {
			ready = true;
		}
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (signingIn) return;

		signingIn = true;
		authError = null;
		try {
			await signIn(email, password);
			session = await resolveSession();
			password = '';
		} catch (error) {
			authError = error instanceof Error ? error.message : 'Sign-in failed.';
		} finally {
			signingIn = false;
		}
	}

	async function leave() {
		await signOut();
		session = null;
	}
</script>

<svelte:head>
	<title>Stocks</title>
</svelte:head>

{#if !ready}
	<p class="centred muted">Loading…</p>
{:else if session === null}
	<main class="gate">
		<form class="card" onsubmit={submit}>
			<h1>Stocks</h1>
			<p class="muted">Sign in to your portfolio journal.</p>

			{#if !isConfigured()}
				<p class="warn" role="alert">
					No Supabase key. Start this app with <code>pnpm dev:run:web</code>, which reads the
					publishable key out of <code>supabase status</code>.
				</p>
			{/if}

			<div class="field">
				<label for="email">Email</label>
				<input id="email" type="email" autocomplete="username" bind:value={email} required />
			</div>

			<div class="field">
				<label for="password">Password</label>
				<input
					id="password"
					type="password"
					autocomplete="current-password"
					bind:value={password}
					required
				/>
			</div>

			{#if authError}
				<p class="warn" role="alert">{authError}</p>
			{/if}

			<button class="primary" type="submit" disabled={signingIn}>
				{signingIn ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	</main>
{:else}
	<header class="chrome">
		<nav>
			<a href="/" class:current={page.url.pathname === '/'}>Portfolio</a>
			<a href="/import" class:current={page.url.pathname.startsWith('/import')}>Import</a>
		</nav>
		<button type="button" onclick={leave}>Sign out</button>
	</header>

	<main>
		{@render children()}
	</main>
{/if}

<style>
	.centred {
		padding: 4rem 1.5rem;
		text-align: center;
	}

	main {
		max-width: 46rem;
		margin: 0 auto;
		padding: 1rem 1.25rem 4rem;
	}

	.gate {
		display: grid;
		place-items: center;
		min-height: 100svh;
	}

	.gate form {
		width: min(24rem, 100%);
		padding: 1.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.gate h1 {
		font-size: 1.4rem;
	}

	.gate p {
		margin: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
	}

	.warn {
		color: var(--negative);
		font-size: 0.85rem;
	}

	.chrome {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		max-width: 46rem;
		margin: 0 auto;
		padding: 1rem 1.25rem 0;
	}

	nav {
		display: flex;
		gap: 1.1rem;
	}

	nav a {
		text-decoration: none;
		font-weight: 600;
		color: var(--muted);
		padding-bottom: 0.15rem;
		border-bottom: 2px solid transparent;
	}

	nav a.current {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
</style>
