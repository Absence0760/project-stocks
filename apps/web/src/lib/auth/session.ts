import type { Session } from '@supabase/supabase-js';
import { devUserEmail, devUserPassword, supabaseUrl } from '$lib/config/env';
import { supabase } from '$lib/supabase/client';
import { shouldAutoLogin } from './dev-auto-login';

/**
 * Resolve the current session, signing in as the seeded dev user when — and only
 * when — this is a dev build talking to a loopback stack.
 *
 * Both conditions are required, exactly as in apps/mobile/lib/main.dart:
 * `import.meta.env.DEV` is the web's `kDebugMode`, and the host gate is what
 * stops a dev build accidentally pointed at production from sending a hardcoded
 * credential to it.
 */
export async function resolveSession(): Promise<Session | null> {
	const auth = supabase().auth;

	const { data } = await auth.getSession();
	if (data.session) return data.session;

	if (!import.meta.env.DEV) return null;
	if (!shouldAutoLogin({ url: supabaseUrl, email: devUserEmail, password: devUserPassword })) {
		return null;
	}

	const { data: signedIn, error } = await auth.signInWithPassword({
		email: devUserEmail,
		password: devUserPassword
	});

	if (error) {
		// Not fatal — fall through to the sign-in form rather than blocking the
		// app on a stack that hasn't been seeded yet.
		console.warn('dev auto-login failed:', error.message);
		return null;
	}

	return signedIn.session;
}

export async function signIn(email: string, password: string): Promise<void> {
	const { error } = await supabase().auth.signInWithPassword({ email, password });
	if (error) throw error;
}

export async function signOut(): Promise<void> {
	await supabase().auth.signOut();
}
